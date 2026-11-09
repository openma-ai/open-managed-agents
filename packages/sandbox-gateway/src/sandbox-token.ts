// The one sandbox credential (#561): model gateway, MCP gateway, sandbox API
// and Vault egress. `oma_sbx_<random><crc>`: 32 random bytes in base62 (43
// chars) plus a 6-char base62 CRC32 of the prefix and random part — 57 chars,
// independent of what the Session holds. The token carries no Session data:
// each channel sends the Session id in its own slot (proxy path, Basic
// username, SOCKS5 username). Only the SHA-256 of the random part is stored,
// on the execution attempt row; the checksum lets a gateway refuse a typo or
// truncation (401) before any database read.

export const SANDBOX_TOKEN_PREFIX = "oma_sbx_";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
export const SANDBOX_TOKEN_LENGTH = SANDBOX_TOKEN_PREFIX.length + RANDOM_LENGTH + CHECKSUM_LENGTH;
const SHAPE = new RegExp(`^${SANDBOX_TOKEN_PREFIX}([0-9A-Za-z]{${RANDOM_LENGTH}})([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`, "u");

function base62(value: bigint, width: number): string {
  let out = "";
  for (let i = 0; i < width; i++) { out = ALPHABET[Number(value % 62n)] + out; value /= 62n; }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const checksum = (randomPart: string) => base62(BigInt(crc32(SANDBOX_TOKEN_PREFIX + randomPart)), CHECKSUM_LENGTH);

export function generateSandboxToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const randomPart = base62(BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`), RANDOM_LENGTH);
  return `${SANDBOX_TOKEN_PREFIX}${randomPart}${checksum(randomPart)}`;
}

/** Handed to a forwarder installed with no current execution attempt
 * (warm-up): the right shape with a checksum that never matches, so every
 * gateway refuses it (401, no database read) and the forwarder exits. */
export const UNFENCED_SANDBOX_TOKEN = `${SANDBOX_TOKEN_PREFIX}${"0".repeat(RANDOM_LENGTH)}${checksum("0".repeat(RANDOM_LENGTH)) === "zzzzzz" ? "000000" : "zzzzzz"}`;

/** Looks like a sandbox token (prefix), whether or not it is well formed. */
export const isSandboxTokenShaped = (value: string) => value.startsWith(SANDBOX_TOKEN_PREFIX);

/** The random part when the shape and checksum hold; null otherwise. No I/O. */
export function sandboxTokenRandomPart(token: string): string | null {
  const match = SHAPE.exec(token);
  return match !== null && match[2] === checksum(match[1]!) ? match[1]! : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HTTP Basic (and SOCKS5 user/password): username = Session id, password = token. */
export function sandboxBasicCredential(sessionId: string, token: string): string {
  if (sessionId === "" || sessionId.includes(":")) throw new Error("Sandbox credential Session id is invalid");
  return `Basic ${btoa(`${sessionId}:${token}`)}`;
}

export function parseSandboxBasicCredential(header: string): { sessionId: string; token: string } | null {
  const encoded = /^Basic\s+(\S+)$/iu.exec(header)?.[1];
  if (encoded === undefined) return null;
  let decoded: string;
  try { decoded = atob(encoded); } catch { return null; }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { sessionId: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}
