// Feishu URL verification + signature check.
//
// Feishu supports two signing modes:
//
//   1. **Encrypt Key** mode (preferred): the App's "Encrypt Key" is used to
//      HMAC-SHA256 an empty string with the challenge as the key. The result
//      is base64-encoded and returned in the response. See
//      https://open.feishu.cn/document/server-docs/event-subscription-guide/encrypt-key-encryption-strategy
//
//   2. **Verification Token** mode (legacy): the App's "Verification Token"
//      is a static string. The challenge response simply echoes the
//      `challenge` field back without transformation.
//
// detectMode is the public entrypoint; the route layer uses it to pick the
// right verification path. The runner only consumes the WS event stream —
// signature checks live on the HTTP webhook handler only.

export type FeishuSigningMode = "encrypt_key" | "verification_token";

/** Heuristic: Encrypt Key is typically 32+ chars of base64; Verification Token
 *  is typically a 16-32 char alphanumeric string. Default to encrypt_key
 *  (the documented preferred path); callers can override via setCredentials. */
export function detectSigningMode(encryptKey: string | null, verificationToken: string | null): FeishuSigningMode {
  if (encryptKey && encryptKey.length >= 16) return "encrypt_key";
  if (verificationToken) return "verification_token";
  return "encrypt_key";
}

/**
 * Compute the Feishu URL verification response for `encrypt_key` mode.
 * HMAC-SHA256("" :: utf8, key = challenge) → base64. No constant-time
 * requirement on the response side — the App only stores the matching key
 * for future signature verification.
 */
export async function computeEncryptKeyChallenge(
  encryptKey: string,
  challenge: string,
): Promise<string> {
  // Lazy import to avoid loading node:crypto in non-Node runtimes.
  const { createHmac } = await import("node:crypto");
  const hmac = createHmac("sha256", challenge);
  hmac.update("", "utf8");
  return hmac.digest("base64");
}

/**
 * Verification-token mode echo — the response body is simply the challenge
 * string verbatim. No crypto involved.
 */
export function computeVerificationTokenChallenge(challenge: string): string {
  return challenge;
}

/**
 * Constant-time string compare. Used when the Feishu side sends the
 * Verification Token header and we want to verify it matches our stored
 * value (some legacy event-callback paths).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
