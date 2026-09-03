import { describe, expect, it } from "vitest";

import { createE2BManagedRuntime } from "../src/e2b";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

describe("E2B managed runtime preset", () => {
  it("declares only semantics implemented by the E2B provider bridge", async () => {
    const runtime = createE2BManagedRuntime({
      environment: {
        E2B_API_URL: "http://e2b-compatible.invalid",
        E2B_API_KEY: "test-only",
      },
      leaseTtlMs: 90_000,
    });

    await expect(runtime.sandbox.capabilities(scope)).resolves.toEqual({
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    });
    await expect(runtime.workspace.capabilities(scope)).resolves.toEqual({
      strategies: ["retained_runtime", "checkpoint_restore"],
    });
    await expect(runtime.outputs.capabilities(scope)).resolves.toEqual({ strategies: [] });
    await expect(runtime.harness.driverCapabilities(scope)).resolves.toEqual({
      drivers: ["ama_worker"],
    });
  });

  it("preinstalls durable final collection when an S3-compatible files store is configured", async () => {
    const runtime = createE2BManagedRuntime({
      environment: {
        E2B_API_KEY: "test-only",
        FILES_S3_ENDPOINT: "http://minio.invalid",
        FILES_S3_BUCKET: "outputs",
        FILES_S3_ACCESS_KEY: "access",
        FILES_S3_SECRET_KEY: "secret",
      },
      leaseTtlMs: 90_000,
    });

    await expect(runtime.outputs.capabilities(scope)).resolves.toEqual({
      strategies: [{ strategy: "final_collect", durability: "durable" }],
    });
  });
});
