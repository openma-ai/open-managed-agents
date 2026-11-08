// Object storage over the S3 API: scoped mount credentials and output upload.
// Only fetch + WebCrypto (aws4fetch), so it runs in Workers and Node alike.
// Used by adapters that mount Memory Stores with s3fs and by createSyncStorage
// deployments that publish outputs to an S3-compatible bucket.

import { AwsClient } from "aws4fetch";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { SandboxOutputSinkPort, SandboxVendorPort } from "./ports";

export const SESSION_OUTPUTS_DIR = "/mnt/session/outputs";

/** Short-lived S3 credentials bound to one bucket prefix. The sandbox gets
 * these; the parent key that minted them never leaves the control plane. */
export interface ScopedObjectStoreCredentials {
  endpoint: string;
  bucket: string;
  /** Key prefix the credential is restricted to, with a trailing slash. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
}

/** Issues prefix-scoped credentials for a sandbox mount. */
export interface ObjectStoreCredentialPort {
  issue(input: { prefix: string; access: "read_only" | "read_write"; ttlSeconds: number }): Promise<ScopedObjectStoreCredentials>;
}

export interface R2ParentKey {
  /** Cloudflare account id (the JWT subject). */
  accountId: string;
  /** https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * R2 temporary credentials signed locally (R2 "client-side signing"): an
 * HS256 JWT over { bucket, scope, paths } signed with the parent secret; the
 * temporary secret is sha256-hex(jwt) and the session token is
 * base64("jwt/" + jwt). The parent access key id is reused as the temporary
 * key id. https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
 */
export function createR2TemporaryCredentials(
  parent: R2ParentKey,
  now: () => number = Date.now,
): ObjectStoreCredentialPort {
  return {
    async issue(input) {
      const prefix = normalizePrefix(input.prefix);
      if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new TypeError("R2 temporary credential ttlSeconds must be a positive integer");
      }
      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + input.ttlSeconds;
      const jwt = await signHs256({
        bucket: parent.bucket,
        scope: input.access === "read_only" ? "object-read-only" : "object-read-write",
        paths: { prefixPaths: [prefix], objectPaths: [] },
        sub: parent.accountId,
        iss: parent.accessKeyId,
        aud: new URL(parent.endpoint).host,
        iat: issuedAt,
        exp: expiresAt,
      }, parent.secretAccessKey);
      return {
        endpoint: parent.endpoint,
        bucket: parent.bucket,
        prefix,
        accessKeyId: parent.accessKeyId,
        secretAccessKey: await sha256Hex(jwt),
        sessionToken: btoa(`jwt/${jwt}`),
        expiresAt: expiresAt * 1000,
      };
    },
  };
}

/** Publishes a Session's outputs into an S3-compatible bucket under
 * `keyPrefix(scope)`, replacing the previous set (stale keys are deleted
 * after the upload). Signed in the control plane with the deployment key. */
export function createS3OutputSink(options: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyPrefix(scope: RuntimeResourceScope): string;
  maxFileBytes?: number;
  fetch?: typeof fetch;
}): SandboxOutputSinkPort {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const send = (url: string, init: RequestInit) => client.sign(url, init).then((request) => (options.fetch ?? fetch)(request));
  const base = `${options.endpoint.replace(/\/+$/u, "")}/${encodeURIComponent(options.bucket)}`;
  const objectUrl = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async publish(input) {
      const prefix = normalizePrefix(options.keyPrefix(input.scope));
      const previous = await listKeys(send, base, prefix, input.signal);
      const written = new Set<string>();
      for await (const [logicalPath, bytes] of input.files) {
        input.signal.throwIfAborted();
        assertLogicalPath(logicalPath);
        if (options.maxFileBytes !== undefined && bytes.byteLength > options.maxFileBytes) {
          throw new Error(`Session output ${logicalPath} exceeds ${options.maxFileBytes} bytes`);
        }
        const key = `${prefix}${logicalPath}`;
        const response = await send(objectUrl(key), { method: "PUT", body: bytes, signal: input.signal });
        if (!response.ok) throw new Error(`Session output upload failed (${response.status}) for ${logicalPath}`);
        written.add(key);
      }
      for (const key of previous) {
        if (written.has(key)) continue;
        input.signal.throwIfAborted();
        const response = await send(objectUrl(key), { method: "DELETE", signal: input.signal });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Stale Session output delete failed (${response.status})`);
        }
      }
    },
  };
}

/** Every regular file under /mnt/session/outputs/, as logical paths. An
 * absent directory yields nothing; a failing listing throws. */
export async function* readSandboxOutputs<R>(
  vendor: Pick<SandboxVendorPort<R>, "exec" | "readFile">,
  runtime: R,
  options: { maxFiles?: number; maxBytes?: number } = {},
): AsyncGenerator<readonly [string, Uint8Array]> {
  const listed = await vendor.exec(
    runtime,
    `if [ -d ${SESSION_OUTPUTS_DIR} ]; then t=$(mktemp) || exit 1; if (cd ${SESSION_OUTPUTS_DIR} && find . -type f -print0) > "$t"; then base64 < "$t" | tr -d '\\n'; s=0; else s=1; fi; rm -f "$t"; exit $s; fi`,
    { timeoutMs: 30_000 },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`Listing Session outputs failed (exit ${listed.exitCode}): ${listed.stderr.slice(0, 300)}`);
  }
  const encoded = listed.stdout.trim();
  if (encoded === "") return;
  const paths = new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
    .split("\0").filter((item) => item.length > 0);
  if (options.maxFiles !== undefined && paths.length > options.maxFiles) {
    throw new Error(`Session output file limit exceeded (${options.maxFiles})`);
  }
  let total = 0;
  for (const listedPath of paths) {
    if (!listedPath.startsWith("./")) throw new Error("Session output listing escaped its root");
    const logicalPath = listedPath.slice(2);
    assertLogicalPath(logicalPath);
    const bytes = await vendor.readFile(runtime, `${SESSION_OUTPUTS_DIR}/${logicalPath}`);
    if (bytes === null) continue;
    total += bytes.byteLength;
    if (options.maxBytes !== undefined && total > options.maxBytes) {
      throw new Error(`Session output byte limit exceeded (${options.maxBytes})`);
    }
    yield [logicalPath, bytes] as const;
  }
}

async function listKeys(
  send: (url: string, init: RequestInit) => Promise<Response>,
  base: string,
  prefix: string,
  signal: AbortSignal,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | null = null;
  do {
    const query = new URLSearchParams({ "list-type": "2", prefix });
    if (token !== null) query.set("continuation-token", token);
    const response = await send(`${base}?${query}`, { method: "GET", signal });
    if (!response.ok) throw new Error(`Session output listing failed (${response.status})`);
    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/gu)) keys.push(decodeXml(match[1]!));
    const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(xml);
    token = truncated ? decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml)?.[1] ?? "") : null;
    if (truncated && token === "") throw new Error("Session output listing was truncated without a continuation token");
  } while (token !== null);
  return keys;
}

function decodeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/gu, (_, entity: string) =>
    ({ lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" })[entity]!);
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/u, "");
  if (trimmed === "" || trimmed.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`Unsafe object-store prefix: ${JSON.stringify(prefix)}`);
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function assertLogicalPath(path: string): void {
  if (path === "" || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe Session output path: ${JSON.stringify(path)}`);
  }
}

async function signHs256(claims: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64Url(signature)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
