// R2 mount targets of a Cloudflare container sandbox. Outputs mount
// FILES_BUCKET_NAME with the R2_FILES_* key when set (a key per bucket), else
// with R2_ACCESS_KEY_ID (one key for every bucket). A key that cannot reach the
// bucket is AccessDenied, which the shim reports as "cannot verify the new FUSE
// connection".
import { describe, expect, it } from "vitest";
import { CloudflareSandbox } from "../src/runtime/sandbox";

const base = {
  SANDBOX: {},
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "memory-key",
  R2_SECRET_ACCESS_KEY: "memory-secret",
  MEMORY_BUCKET: {},
  MEMORY_BUCKET_NAME: "lane-memory",
  FILES_BUCKET: {},
  FILES_BUCKET_NAME: "lane-files",
  R2_FILES_ACCESS_KEY_ID: "files-key",
  R2_FILES_SECRET_ACCESS_KEY: "files-secret",
};

describe("CloudflareSandbox R2 mounts", () => {
  it("mounts outputs from FILES_BUCKET_NAME with the files bucket key", () => {
    const mount = new CloudflareSandbox(base as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" });
    expect(mount).toMatchObject({
      bucket: "lane-files",
      mountPath: "/mnt/session/outputs",
      options: { endpoint: base.R2_ENDPOINT, credentials: { accessKeyId: "files-key", secretAccessKey: "files-secret" }, readOnly: false },
    });
  });

  it("mounts Memory from MEMORY_BUCKET_NAME with the memory bucket key", () => {
    const mount = new CloudflareSandbox(base as never, "sess").memoryStoreMount({ storeName: "notes", storeId: "st", readOnly: true });
    expect(mount).toMatchObject({
      bucket: "lane-memory",
      options: { credentials: { accessKeyId: "memory-key", secretAccessKey: "memory-secret" }, prefix: "/st/", readOnly: true },
    });
  });

  it("mounts outputs with the general key when no files key is set", () => {
    const env = { ...base, R2_FILES_ACCESS_KEY_ID: undefined, R2_FILES_SECRET_ACCESS_KEY: undefined };
    expect(new CloudflareSandbox(env as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" })).toMatchObject({
      bucket: "lane-files",
      options: { credentials: { accessKeyId: "memory-key", secretAccessKey: "memory-secret" } },
    });
  });

  it.each([
    ["R2_FILES_ACCESS_KEY_ID", "R2_FILES_SECRET_ACCESS_KEY"],
    ["R2_FILES_SECRET_ACCESS_KEY", "R2_FILES_ACCESS_KEY_ID"],
  ])("refuses an outputs mount with only one files key (%s unset)", (unset, kept) => {
    const env = { ...base, [unset]: undefined };
    expect(env[kept as keyof typeof env]).toBeTruthy();
    expect(() => new CloudflareSandbox(env as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" }))
      .toThrow(new RegExp(`must be set together; ${unset} is missing`));
  });

  it("refuses an outputs mount without FILES_BUCKET_NAME, with either key shape", () => {
    for (const keys of [{}, { R2_FILES_ACCESS_KEY_ID: undefined, R2_FILES_SECRET_ACCESS_KEY: undefined }]) {
      const env = { ...base, ...keys, FILES_BUCKET_NAME: undefined };
      expect(() => new CloudflareSandbox(env as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" }))
        .toThrow(/FILES_BUCKET_NAME/);
    }
  });

  it("keeps the local outputs directory when no R2 key is configured (wrangler dev)", () => {
    const env = { SANDBOX: {}, FILES_BUCKET: {} };
    expect(new CloudflareSandbox(env as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" }))
      .toMatchObject({ bucket: "FILES_BUCKET", options: { localBucket: true } });
  });
});
