import { describe, expect, it } from "vitest";

import * as sandboxExports from "../src/index";

function exportedGuard(name: string): (value: unknown) => boolean {
  const candidate = (sandboxExports as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeTypeOf("function");
  return candidate as (value: unknown) => boolean;
}

describe("sandbox persistence capability ports", () => {
  it("does not infer workspace backup support from an incomplete primitive", () => {
    const supportsWorkspaceBackup = exportedGuard("supportsWorkspaceBackup");

    expect(supportsWorkspaceBackup({
      createWorkspaceBackup: async () => null,
    })).toBe(false);
    expect(supportsWorkspaceBackup({
      createWorkspaceBackup: async () => null,
      restoreWorkspaceBackup: async () => ({ ok: true }),
    })).toBe(true);
  });

  it("recognizes only the complete host-managed workspace lifecycle", () => {
    const supportsManagedWorkspaceLifecycle = exportedGuard(
      "supportsManagedWorkspaceLifecycle",
    );

    expect(supportsManagedWorkspaceLifecycle({
      setBackupContext: async () => {},
    })).toBe(false);
    expect(supportsManagedWorkspaceLifecycle({
      setBackupContext: async () => {},
      snapshotWorkspaceNow: async () => {},
    })).toBe(true);
  });

  it("recognizes the Session output mount independently from compute", () => {
    const supportsSessionOutputMount = exportedGuard("supportsSessionOutputMount");

    expect(supportsSessionOutputMount({})).toBe(false);
    expect(supportsSessionOutputMount({
      mountSessionOutputs: async () => {},
    })).toBe(false);
    expect(supportsSessionOutputMount({
      sessionOutputMountCapabilities: () => ({ durability: "durable" }),
      mountSessionOutputs: async () => {},
    })).toBe(true);
    expect(supportsSessionOutputMount({
      sessionOutputMountCapabilities: () => null,
      mountSessionOutputs: async () => {},
    })).toBe(false);
  });

  it("recognizes prepared-base capture only from the capture primitive", () => {
    const supportsPreparedBase = exportedGuard("supportsPreparedBase");

    expect(supportsPreparedBase(null)).toBe(false);
    expect(supportsPreparedBase({})).toBe(false);
    expect(supportsPreparedBase({ capturePreparedBase: "nope" })).toBe(false);
    expect(supportsPreparedBase({
      capturePreparedBase: async () => ({ provider: "x", id: "base_1" }),
    })).toBe(true);
  });

  it("lets adapters without prepared bases reject a requested one", async () => {
    expect(() => sandboxExports.rejectPreparedBase("x", undefined)).not.toThrow();
    expect(() => sandboxExports.rejectPreparedBase("sprites", { provider: "e2b", id: "snap_1" })).toThrow(
      "SANDBOX_PROVIDER=sprites cannot create a sandbox from a prepared base (requested e2b:snap_1)",
    );
    const { sandboxFactory } = await import("../src/adapters/local-subprocess");
    await expect(sandboxFactory(
      { sessionId: "s", workdir: "/tmp/psb-unused", preparedBase: { provider: "e2b", id: "snap_1" } },
      {},
    )).rejects.toThrow(/local-subprocess cannot create a sandbox from a prepared base/);
  });
});
