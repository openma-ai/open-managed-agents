import { webcrypto, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import * as x509 from "@peculiar/x509";
const crypto = webcrypto as unknown as Crypto;
x509.cryptoProvider.set(crypto);
const KEY = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const DAY = 86400000;
export interface EgressCertificateAuthority {
  certificatePem: string;
  leafFor(hostname: string): Promise<{ cert: string; key: string }>;
}
/** A private CA per sandbox; never held or persisted by a control plane. */
export async function loadOrCreateEgressCa(dir: string): Promise<{ cert: string; key: string }> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try { return { cert: await fs.readFile(resolve(dir, "ca.crt"), "utf8"), key: await fs.readFile(resolve(dir, "ca.key"), "utf8") }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const keys = await crypto.subtle.generateKey(KEY, true, ["sign", "verify"]) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(randomBytes(16)).toString("hex").replace(/^[89a-f]/u, "1"),
    name: "CN=sandbox local relay CA", notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + 3650 * DAY), keys, signingAlgorithm: SIGN,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)],
  });
  const material = { cert: cert.toString("pem"), key: x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer, "PRIVATE KEY") };
  await fs.writeFile(resolve(dir, "ca.key"), material.key, { mode: 0o600 });
  await fs.writeFile(resolve(dir, "ca.crt"), material.cert);
  return material;
}
export async function createEgressCertificateAuthority(material: { cert: string; key: string }): Promise<EgressCertificateAuthority> {
  const ca = new x509.X509Certificate(material.cert);
  const key = await crypto.subtle.importKey("pkcs8", x509.PemConverter.decodeFirst(material.key), KEY, false, ["sign"]);
  const leaves = new Map<string, Promise<{ cert: string; key: string }>>();
  return { certificatePem: material.cert, leafFor(hostname) {
    let leaf = leaves.get(hostname);
    if (!leaf) {
      leaf = (async () => {
        const keys = await crypto.subtle.generateKey(KEY, true, ["sign", "verify"]) as CryptoKeyPair;
        const cert = await x509.X509CertificateGenerator.create({
          serialNumber: Buffer.from(randomBytes(16)).toString("hex").replace(/^[89a-f]/u, "1"),
          subject: `CN=${hostname.replace(/[,+="\\<>;]/gu, "")}`, issuer: ca.subject,
          notBefore: new Date(Date.now() - DAY), notAfter: new Date(Math.min(Date.now() + 30 * DAY, ca.notAfter.getTime())),
          publicKey: keys.publicKey, signingKey: key, signingAlgorithm: SIGN,
          extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]), new x509.SubjectAlternativeNameExtension([{ type: isIP(hostname) === 0 ? "dns" : "ip", value: hostname }]), await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey)],
        });
        return { cert: cert.toString("pem"), key: x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer, "PRIVATE KEY") };
      })();
      leaves.set(hostname, leaf);
      leaf.catch(() => leaves.delete(hostname));
      setTimeout(() => leaves.delete(hostname), DAY).unref();
    }
    return leaf;
  } };
}
