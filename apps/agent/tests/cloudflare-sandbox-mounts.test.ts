// R2 mount targets of a Cloudflare container sandbox. Each R2 key is scoped to
// one bucket: Memory mounts use the memory bucket key, outputs the files bucket
// key and FILES_BUCKET_NAME. A wrong pair is AccessDenied, which the shim reports
// as "cannot verify the new FUSE connection".
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

  it.each(["FILES_BUCKET_NAME", "R2_FILES_ACCESS_KEY_ID", "R2_FILES_SECRET_ACCESS_KEY"])(
    "refuses an outputs mount without %s instead of using another bucket or key",
    (name) => {
      const env = { ...base, [name]: undefined };
      expect(() => new CloudflareSandbox(env as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" }))
        .toThrow(new RegExp(name));
    },
  );

  it("keeps the local outputs directory when no R2 key is configured (wrangler dev)", () => {
    const env = { SANDBOX: {}, FILES_BUCKET: {} };
    expect(new CloudflareSandbox(env as never, "sess").sessionOutputsMount({ tenantId: "t1", sessionId: "s1" }))
      .toMatchObject({ bucket: "FILES_BUCKET", options: { localBucket: true } });
  });
});
