// Parent R2 key for the session outputs bucket. Two supported deployments:
// one key that reaches every bucket (R2_ACCESS_KEY_ID), or one key per bucket
// (R2_FILES_* for the files bucket, R2_ACCESS_KEY_ID for Memory).

export interface R2FilesCredentialEnv {
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_FILES_ACCESS_KEY_ID?: string;
  R2_FILES_SECRET_ACCESS_KEY?: string;
}

/** The files bucket key when configured, else the account-wide key. Setting
 * one R2_FILES_* without the other is a configuration error. */
export function r2FilesCredentials(env: R2FilesCredentialEnv): { accessKeyId: string; secretAccessKey: string } {
  const id = env.R2_FILES_ACCESS_KEY_ID;
  const secret = env.R2_FILES_SECRET_ACCESS_KEY;
  if (Boolean(id) !== Boolean(secret)) {
    throw new Error(`R2_FILES_ACCESS_KEY_ID and R2_FILES_SECRET_ACCESS_KEY must be set together; ${id ? "R2_FILES_SECRET_ACCESS_KEY" : "R2_FILES_ACCESS_KEY_ID"} is missing`);
  }
  if (id && secret) return { accessKeyId: id, secretAccessKey: secret };
  return { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! };
}
