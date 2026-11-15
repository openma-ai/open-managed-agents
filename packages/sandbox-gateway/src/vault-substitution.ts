// Vault placeholder substitution (design §0.1 `Substitution`, §8.0, §8.4
// rules 1–6, §8.4b matching). The sandbox holds only placeholders; the
// gateway swaps real values in on the credential's allowed hosts. Pure
// WebCrypto and string code: the Cloudflare outbound handler and the Node
// forwarder gateway run this one implementation. No plaintext ever leaves
// VaultSubstitutionSecret (gateway side only).

export type HostPattern = string;

/** Same shape as @open-managed-agents/sandbox `Substitution`: no plaintext. */
export interface VaultSubstitution {
  credentialId: string;
  envName: string;
  placeholder: string;
  /** Exact host or `*.example.com` (subdomains only); `*` = any host the
   * environment lets through (credential networking `unrestricted`, §8.0). */
  hosts: HostPattern[];
  inject: { header: boolean; body: boolean };
}
/** Gateway side only; `value` null = known credential without a value (left as the placeholder). */
export interface VaultSubstitutionSecret { substitution: VaultSubstitution; value: string | null }

export const VAULT_PLACEHOLDER_PREFIX = "oma_vault_";
/** The fixed sentinel CLI specs ship in `bootstrap.env`; replaced per Session. */
export const CAP_CLI_SENTINEL = "__cap_managed__";
const PLACEHOLDER = "oma_vault_[A-Za-z0-9_-]{43}";
const placeholdersIn = (text: string): string[] => text.match(new RegExp(PLACEHOLDER, "gu")) ?? [];

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

export interface VaultPlaceholders {
  placeholder(scope: { workspaceId: string; sessionId: string }, credentialId: string): Promise<string>;
}

/** Rule 1: high entropy (HMAC-SHA256), bound to workspace + Session +
 * credential, stable for the whole Session (long-lived processes keep their
 * env across generations). Derived, so nothing is stored; generation
 * isolation is the gateway's source check (pass / platform binding). */
export function createVaultPlaceholders(secret: string): VaultPlaceholders {
  if (!secret) throw new Error("Vault placeholders require the platform root secret");
  const key = crypto.subtle.importKey("raw", new TextEncoder().encode(`vault-placeholder.v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return {
    async placeholder(scope, credentialId) {
      if (!scope.workspaceId || !scope.sessionId || !credentialId) throw new Error("Invalid Vault placeholder scope");
      const mac = await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(JSON.stringify([scope.workspaceId, scope.sessionId, credentialId])));
      return VAULT_PLACEHOLDER_PREFIX + base64url(new Uint8Array(mac));
    },
  };
}

/** §8.4b: lowercase, punycode, no trailing dot. */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\.$/u, "");
  try { return new URL(`https://${trimmed}`).hostname; } catch { return trimmed.toLowerCase(); }
}

/** CMA host patterns: exact, or `*.example.com` (subdomains, not the apex); `*` = any. */
export function hostMatches(pattern: HostPattern, host: string): boolean {
  if (pattern === "*") return true;
  const target = normalizeHost(host);
  if (pattern.startsWith("*.")) return target.endsWith(`.${normalizeHost(pattern.slice(2))}`);
  return normalizeHost(pattern) === target;
}

export const substitutesOnHost = (secret: VaultSubstitutionSecret, host: string): boolean =>
  secret.substitution.hosts.some((pattern) => hostMatches(pattern, host));

/** The part of a stored Vault credential compilation reads (domain `Credential` fits). */
export interface VaultCredentialRecord {
  credential: { id: string; archivedAt: string | null; auth: { type: string } };
}
interface EnvironmentVariableAuth {
  type: "environment_variable"; secretName: string; secretValue: string | null;
  networking: { type: "unrestricted" } | { type: "limited"; allowedHosts: readonly string[] };
  injectionLocation: { header: boolean; body: boolean };
}
interface CapCliAuth { type: "cap_cli"; cliId: string; token: string | null }
export interface VaultCliSpecs {
  byCliId(cliId: string): { endpoints: readonly string[]; bootstrap?: { env?: Readonly<Record<string, string>> } } | null;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Credentials that only work through egress substitution (400 where the deployment cannot substitute). */
export function vaultSandboxCredentialIds(records: readonly VaultCredentialRecord[]): string[] {
  return records
    .filter(({ credential }) => credential.archivedAt === null
      && (credential.auth.type === "environment_variable" || credential.auth.type === "cap_cli"))
    .map(({ credential }) => credential.id);
}

/** `environment_variable` and `cap_cli` credentials of a Session's Vaults
 * (in Vault order) → substitutions (design §0.1). The first credential to
 * claim an env name wins. `env` carries the non-secret CLI bootstrap values
 * (e.g. a metadata endpoint URL) that are not the sentinel. An unknown
 * cli_id throws: the gateway could not honour that credential. */
export async function compileVaultSubstitutions(input: {
  scope: { workspaceId: string; sessionId: string };
  records: readonly VaultCredentialRecord[];
  specs: VaultCliSpecs;
  placeholders: VaultPlaceholders;
}): Promise<{ secrets: VaultSubstitutionSecret[]; env: Record<string, string> }> {
  const secrets: VaultSubstitutionSecret[] = [];
  const env: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const { credential } of input.records) {
    if (credential.archivedAt !== null) continue;
    if (credential.auth.type === "environment_variable") {
      const auth = credential.auth as EnvironmentVariableAuth;
      if (!auth.secretValue || !ENV_NAME.test(auth.secretName) || claimed.has(auth.secretName)) continue;
      claimed.add(auth.secretName);
      secrets.push({ value: auth.secretValue, substitution: {
        credentialId: credential.id, envName: auth.secretName,
        placeholder: await input.placeholders.placeholder(input.scope, credential.id),
        hosts: auth.networking.type === "limited" ? [...auth.networking.allowedHosts] : ["*"],
        inject: { header: auth.injectionLocation.header, body: auth.injectionLocation.body },
      } });
    } else if (credential.auth.type === "cap_cli") {
      const auth = credential.auth as CapCliAuth;
      const spec = input.specs.byCliId(auth.cliId);
      if (spec === null) throw new Error(`cap_cli credential ${credential.id} names unknown cli_id "${auth.cliId}"`);
      for (const [envName, value] of Object.entries(spec.bootstrap?.env ?? {})) {
        if (claimed.has(envName)) continue;
        claimed.add(envName);
        if (value !== CAP_CLI_SENTINEL) { env[envName] = value; continue; }
        secrets.push({ value: auth.token || null, substitution: {
          credentialId: credential.id, envName,
          placeholder: await input.placeholders.placeholder(input.scope, `${credential.id}#${envName}`),
          hosts: [...spec.endpoints], inject: { header: true, body: false },
        } });
      }
    }
  }
  return { secrets, env };
}

export type VaultSubstitutionDenyRule = "credential_host_mismatch" | "credential_missing" | "signed_request";
export type VaultSubstitutionResult =
  | { ok: true; headers: Headers; body: ArrayBuffer | null; substitutedHeaders: string[]; credentialIds: string[] }
  | { ok: false; rule: VaultSubstitutionDenyRule; credentialId: string | null };

function basicCredentials(value: string): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/iu.exec(value);
  if (!match) return null;
  try { return atob(match[1]!); } catch { return null; }
}
const utf8 = (body: ArrayBuffer): string | null => { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body); } catch { return null; } };
const latin1 = (body: ArrayBuffer): string => { let text = ""; const bytes = new Uint8Array(body); for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return text; };
const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** Placeholders in headers (Basic auth decoded) and body; scans bytes, so it works on any body. */
export function vaultPlaceholdersIn(headers: Headers, body: ArrayBuffer | null): { header: string[]; body: string[] } {
  const header: string[] = [];
  headers.forEach((value, name) => {
    header.push(...placeholdersIn(value));
    if (name === "authorization") header.push(...placeholdersIn(basicCredentials(value) ?? ""));
  });
  return { header, body: body === null || body.byteLength === 0 ? [] : placeholdersIn(latin1(body)) };
}
export function carriesVaultPlaceholder(headers: Headers, body: ArrayBuffer | null): boolean {
  const found = vaultPlaceholdersIn(headers, body);
  return found.header.length + found.body.length > 0;
}

/** Signatures cover what we would rewrite (rule 5): refuse, never re-sign here. */
function isSignedRequest(headers: Headers): boolean {
  const authorization = headers.get("authorization") ?? "";
  return /^AWS4-HMAC-SHA256\s/iu.test(authorization) || /\boauth_signature=/u.test(authorization);
}

function escapeForBody(contentType: string): (value: string) => string {
  if (/\bjson\b/iu.test(contentType)) return (value) => JSON.stringify(value).slice(1, -1);
  if (/application\/x-www-form-urlencoded/iu.test(contentType)) return encodeURIComponent;
  return (value) => value;
}

/** Rules 2–6 for one request to `host`: every placeholder must belong to
 * this Session and be allowed on this host, or the request is refused (never
 * forwarded with the placeholder). Headers are replaced when the credential
 * injects into headers (Basic auth decoded, replaced, re-encoded); the body
 * only when it injects into the body and the body is uncompressed UTF-8 and
 * not multipart. One pass: a substituted value is never scanned again. */
export function substituteVaultPlaceholders(input: {
  host: string; headers: Headers; body: ArrayBuffer | null; secrets: readonly VaultSubstitutionSecret[];
}): VaultSubstitutionResult {
  const byPlaceholder = new Map(input.secrets.map((secret) => [secret.substitution.placeholder, secret]));
  const found = vaultPlaceholdersIn(input.headers, input.body);
  const all = [...found.header, ...found.body];
  for (const placeholder of all) {
    const secret = byPlaceholder.get(placeholder);
    if (secret === undefined) return { ok: false, rule: "credential_missing", credentialId: null };
    if (!substitutesOnHost(secret, input.host)) return { ok: false, rule: "credential_host_mismatch", credentialId: secret.substitution.credentialId };
  }
  const headers = new Headers(input.headers);
  if (all.length === 0) return { ok: true, headers, body: input.body, substitutedHeaders: [], credentialIds: [] };
  if (isSignedRequest(input.headers)) return { ok: false, rule: "signed_request", credentialId: byPlaceholder.get(all[0]!)!.substitution.credentialId };
  const used = new Set<string>();
  const replace = (text: string, where: "header" | "body", escape: (value: string) => string = (value) => value) =>
    text.replace(new RegExp(PLACEHOLDER, "gu"), (placeholder) => {
      const secret = byPlaceholder.get(placeholder)!;
      if (!secret.substitution.inject[where] || secret.value === null) return placeholder;
      used.add(secret.substitution.credentialId);
      return escape(secret.value);
    });
  const substitutedHeaders: string[] = [];
  input.headers.forEach((value, name) => {
    const basic = name === "authorization" ? basicCredentials(value) : null;
    const next = basic !== null && placeholdersIn(basic).length > 0 ? `Basic ${toBase64(replace(basic, "header"))}` : replace(value, "header");
    if (next !== value) { headers.set(name, next); substitutedHeaders.push(name); }
  });
  let body = input.body;
  const contentType = input.headers.get("content-type") ?? "";
  if (body !== null && found.body.length > 0 && !input.headers.has("content-encoding") && !/^multipart\//iu.test(contentType)) {
    const text = utf8(body);
    if (text !== null) {
      const next = replace(text, "body", escapeForBody(contentType));
      if (next !== text) body = new TextEncoder().encode(next).buffer as ArrayBuffer;
    }
  }
  return { ok: true, headers, body, substitutedHeaders, credentialIds: [...used] };
}

/** Rule 3: an echoing upstream must not hand the real value back to the
 * sandbox. Headers only; response bodies stream through unchanged. */
export function scrubVaultValues(headers: Headers, secrets: readonly VaultSubstitutionSecret[]): Headers {
  const out = new Headers(headers);
  const known = secrets.filter((secret): secret is VaultSubstitutionSecret & { value: string } => secret.value !== null && secret.value.length >= 8);
  if (known.length === 0) return out;
  headers.forEach((value, name) => {
    let next = value;
    for (const secret of known) next = next.replaceAll(secret.value, secret.substitution.placeholder);
    if (next !== value) out.set(name, next);
  });
  return out;
}
