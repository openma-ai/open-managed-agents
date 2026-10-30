/**
 * The egress proxy's certificate authority: one per deployment, persisted in
 * a directory (`ca.crt`, `ca.key`) so sandboxes that trust it keep working
 * across restarts and replicas sharing the directory. Only `ca.crt` ever
 * reaches a sandbox. Leaf certificates for intercepted hosts are minted in
 * memory and cached per hostname.
 */
import { webcrypto, randomBytes } from "node:crypto";
import { promises as fs, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import * as x509 from "@peculiar/x509";

const crypto = webcrypto as unknown as Crypto;
x509.cryptoProvider.set(crypto);

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const DAY_MS = 86_400_000;
const LEAF_VALIDITY_MS = 30 * DAY_MS;
/** Re-mint a cached leaf this long before it expires. */
const LEAF_RENEW_MS = DAY_MS;

export interface EgressCertificateAuthority {
  /** PEM certificate sandboxes install as a trust anchor. */
  readonly certificatePem: string;
  /** PEM certificate and key for a TLS server presenting `hostname`. */
  leafFor(hostname: string): Promise<{ cert: string; key: string }>;
}

async function readCa(dir: string): Promise<{ cert: string; key: string } | null> {
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(resolve(dir, "ca.crt"), "utf8"),
      fs.readFile(resolve(dir, "ca.key"), "utf8"),
    ]);
    return { cert, key };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function generateCa(): Promise<{ cert: string; key: string }> {
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]) as CryptoKeyPair;
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(randomBytes(16)).toString("hex").replace(/^[89a-f]/u, "1"),
    name: "CN=openma sandbox egress CA",
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 10 * 365 * DAY_MS),
    keys,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer;
  return { cert: cert.toString("pem"), key: x509.PemConverter.encode(pkcs8, "PRIVATE KEY") };
}

/**
 * Load the CA from `dir`, generating it on first use. Replicas sharing the
 * directory serialize creation on an exclusive `ca.lock`; losers wait for
 * the winner's files.
 */
export async function loadOrCreateEgressCa(dir: string): Promise<{ cert: string; key: string }> {
  mkdirSync(resolve(dir), { recursive: true });
  const existing = await readCa(dir);
  if (existing !== null) return existing;
  const lockPath = resolve(dir, "ca.lock");
  let lock: import("node:fs/promises").FileHandle;
  try {
    lock = await fs.open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const created = await readCa(dir);
      if (created !== null) return created;
    }
    throw new Error(`timed out waiting for another process to create the egress CA in ${dir} (stale ${lockPath}?)`);
  }
  try {
    const raced = await readCa(dir);
    if (raced !== null) return raced;
    const ca = await generateCa();
    await fs.writeFile(resolve(dir, "ca.key"), ca.key, { mode: 0o600 });
    await fs.writeFile(resolve(dir, "ca.crt"), ca.cert);
    return ca;
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

export async function createEgressCertificateAuthority(
  ca: { cert: string; key: string },
): Promise<EgressCertificateAuthority> {
  const caCert = new x509.X509Certificate(ca.cert);
  const caKey = await crypto.subtle.importKey(
    "pkcs8",
    x509.PemConverter.decodeFirst(ca.key),
    KEY_ALGORITHM,
    false,
    ["sign"],
  );
  // One leaf key pair per process; each host gets its own certificate.
  const leafKeys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]) as CryptoKeyPair;
  const leafKeyPem = x509.PemConverter.encode(
    await crypto.subtle.exportKey("pkcs8", leafKeys.privateKey) as ArrayBuffer,
    "PRIVATE KEY",
  );
  const authorityKeyId = await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey);
  const leaves = new Map<string, Promise<{ cert: string; key: string; notAfter: number }>>();

  const mint = async (hostname: string) => {
    const now = Date.now();
    const notAfter = Math.min(now + LEAF_VALIDITY_MS, caCert.notAfter.getTime());
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: Buffer.from(randomBytes(16)).toString("hex").replace(/^[89a-f]/u, "1"),
      subject: `CN=${hostname.replace(/[,+="\\<>;]/gu, "")}`,
      issuer: caCert.subject,
      notBefore: new Date(now - DAY_MS),
      notAfter: new Date(notAfter),
      publicKey: leafKeys.publicKey,
      signingKey: caKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([
          { type: isIP(hostname) === 0 ? "dns" : "ip", value: hostname },
        ]),
        authorityKeyId,
      ],
    });
    return { cert: cert.toString("pem"), key: leafKeyPem, notAfter };
  };

  return {
    certificatePem: ca.cert,
    async leafFor(hostname) {
      let pending = leaves.get(hostname);
      if (pending !== undefined && (await pending).notAfter - LEAF_RENEW_MS <= Date.now()) {
        pending = undefined;
      }
      if (pending === undefined) {
        pending = mint(hostname);
        leaves.set(hostname, pending);
        pending.catch(() => leaves.delete(hostname));
      }
      const { cert, key } = await pending;
      return { cert, key };
    },
  };
}
