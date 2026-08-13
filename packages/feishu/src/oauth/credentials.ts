// Feishu App credential validation.
//
// Feishu Apps require 4 secrets at install time:
//   - app_id           (cli_…)        — public, plaintext
//   - app_secret                       — used to mint tenant_access_token
//   - verification_token               — legacy signing material (optional)
//   - encrypt_key                      — preferred HMAC signing key
//
// We validate format / length only here — actual reachability is checked by
// the WS runner when it does the test-ping.

export interface FeishuAppCredentialsInput {
  appId: string;
  appSecret: string;
  verificationToken: string | null;
  encryptKey: string | null;
}

export interface FeishuAppCredentialsError {
  field: "appId" | "appSecret" | "verificationToken" | "encryptKey";
  message: string;
}

const APP_ID_PREFIX = "cli_";
const MIN_APP_SECRET_LENGTH = 16;
const MIN_VERIFICATION_TOKEN_LENGTH = 8;
const MIN_ENCRYPT_KEY_LENGTH = 16;

/**
 * Validate a Feishu App credentials payload. Returns null on success or an
 * array of {field, message} entries (one per failing field).
 *
 * Caller UX: surface all errors at once in the Console wizard so the user
 * can fix them in a single pass.
 */
export function validateFeishuAppCredentials(
  input: Partial<FeishuAppCredentialsInput>,
): FeishuAppCredentialsError[] | null {
  const errors: FeishuAppCredentialsError[] = [];

  const appId = input.appId?.trim() ?? "";
  if (!appId) {
    errors.push({ field: "appId", message: "App ID is required" });
  } else if (!appId.startsWith(APP_ID_PREFIX)) {
    errors.push({
      field: "appId",
      message: `App ID must start with "${APP_ID_PREFIX}"`,
    });
  } else if (appId.length <= APP_ID_PREFIX.length) {
    errors.push({ field: "appId", message: "App ID is too short" });
  }

  const appSecret = input.appSecret?.trim() ?? "";
  if (!appSecret) {
    errors.push({ field: "appSecret", message: "App Secret is required" });
  } else if (appSecret.length < MIN_APP_SECRET_LENGTH) {
    errors.push({
      field: "appSecret",
      message: `App Secret must be at least ${MIN_APP_SECRET_LENGTH} characters`,
    });
  }

  const verificationToken = input.verificationToken?.trim() ?? "";
  if (verificationToken && verificationToken.length < MIN_VERIFICATION_TOKEN_LENGTH) {
    errors.push({
      field: "verificationToken",
      message: `Verification Token must be at least ${MIN_VERIFICATION_TOKEN_LENGTH} characters`,
    });
  }

  const encryptKey = input.encryptKey?.trim() ?? "";
  if (!encryptKey) {
    errors.push({
      field: "encryptKey",
      message: "Encrypt Key is required (Feishu's URL verification signing key)",
    });
  } else if (encryptKey.length < MIN_ENCRYPT_KEY_LENGTH) {
    errors.push({
      field: "encryptKey",
      message: `Encrypt Key must be at least ${MIN_ENCRYPT_KEY_LENGTH} characters`,
    });
  }

  return errors.length === 0 ? null : errors;
}

/**
 * Strip whitespace from all credential fields before persisting. Feishu's
 * developer console sometimes copies secrets with a trailing newline; we
 * canonicalize once at the boundary.
 */
export function normalizeFeishuAppCredentials(
  input: FeishuAppCredentialsInput,
): FeishuAppCredentialsInput {
  return {
    appId: input.appId.trim(),
    appSecret: input.appSecret.trim(),
    verificationToken: input.verificationToken?.trim() ?? null,
    encryptKey: input.encryptKey?.trim() ?? null,
  };
}
