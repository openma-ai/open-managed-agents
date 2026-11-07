import { describe, expect, it, vi } from "vitest";
import {
  provisionSessionSandbox,
  supportsSandboxProvisioning,
  withoutDeferredMemoryMounts,
  type ProvisionableSandbox,
} from "../src/runtime/sandbox-provisioning";

type Mount = { bucket: string; mountPath: string; options: Record<string, unknown> };

function fakeSandbox(initial: { running: boolean; incarnation: string | null; mounts?: string[] }) {
  const state = { ...initial, mounts: initial.mounts ?? [] };
  const provisioned: Array<{ incarnation: string; mounts: Mount[] }> = [];
  const sandbox: ProvisionableSandbox & { failures: number } = {
    failures: 0,
    describeSandbox: vi.fn(async () => ({ ...state })),
    provisionSandbox: vi.fn(async (input: { incarnation: string; mounts: Mount[] }) => {
      if (sandbox.failures > 0) {
        sandbox.failures -= 1;
        throw new Error("container did not start");
      }
      provisioned.push(input);
      if (state.running && state.incarnation !== null) {
        return {
          incarnation: state.incarnation,
          started: false,
          pendingMounts: input.mounts.map((m) => m.mountPath).filter((p) => !state.mounts.includes(p)),
        };
      }
      Object.assign(state, { running: true, incarnation: input.incarnation, mounts: input.mounts.map((m) => m.mountPath) });
      return { incarnation: input.incarnation, started: true, pendingMounts: [] };
    }),
    sessionOutputsMount: ({ sessionId }) => ({ bucket: "files", mountPath: "/mnt/session/outputs", options: { prefix: sessionId } }),
    memoryStoreMount: ({ storeName, storeId, readOnly }) => ({ bucket: "memory", mountPath: `/mnt/memory/${storeName}`, options: { prefix: storeId, readOnly } }),
    destroy: vi.fn(async () => { Object.assign(state, { running: false, incarnation: null, mounts: [] }); }),
  };
  return { sandbox, state, provisioned };
}

const memoryResource = (name: string, generation: string) => ({
  type: "memory_store",
  memory_store_id: `store-${name}`,
  name,
  access: "read_write",
  runtimeMountStoreId: `snap-${name}-${generation}`,
});

describe("provisionSessionSandbox", () => {
  it("starts a new container with outputs and Memory Store mounts keyed to the new incarnation", async () => {
    const { sandbox, provisioned } = fakeSandbox({ running: false, incarnation: null });
    const loadResources = vi.fn(async (generation: string) => ({ resources: [memoryResource("notes", generation), { type: "file", file_id: "f" }] }));

    const result = await provisionSessionSandbox({
      sandbox, tenantId: "t", sessionId: "s", loadResources, mintIncarnation: () => "fresh-1",
    });

    expect(loadResources).toHaveBeenCalledWith("fresh-1");
    expect(provisioned[0]).toEqual({
      incarnation: "fresh-1",
      mounts: [
        { bucket: "files", mountPath: "/mnt/session/outputs", options: { prefix: "s" } },
        { bucket: "memory", mountPath: "/mnt/memory/notes", options: { prefix: "snap-notes-fresh-1", readOnly: false } },
      ],
    });
    expect(result).toMatchObject({ incarnation: "fresh-1", started: true, deferredMounts: [] });
  });

  it("reuses a running container's incarnation so writable Memory keeps its private prefix", async () => {
    const { sandbox } = fakeSandbox({ running: true, incarnation: "live-1", mounts: ["/mnt/session/outputs", "/mnt/memory/notes"] });
    const loadResources = vi.fn(async (generation: string) => ({ resources: [memoryResource("notes", generation)] }));

    const result = await provisionSessionSandbox({ sandbox, tenantId: "t", sessionId: "s", loadResources });

    expect(loadResources).toHaveBeenCalledWith("live-1");
    expect(result).toMatchObject({ incarnation: "live-1", started: false, deferredMounts: [] });
  });

  it("defers a Memory Store attached after the container started", async () => {
    const { sandbox } = fakeSandbox({ running: true, incarnation: "live-1", mounts: ["/mnt/session/outputs"] });
    const result = await provisionSessionSandbox({
      sandbox, tenantId: "t", sessionId: "s",
      loadResources: async (generation) => ({ resources: [memoryResource("late", generation), { type: "file", file_id: "f" }] }),
    });

    expect(result.deferredMounts).toEqual(["/mnt/memory/late"]);
    expect(withoutDeferredMemoryMounts(result.resources!.resources, result.deferredMounts)).toEqual({
      resources: [{ type: "file", file_id: "f" }],
      deferredStores: ["late"],
    });
  });

  it("replaces a running container that lacks the required outputs mount", async () => {
    const { sandbox, provisioned } = fakeSandbox({ running: true, incarnation: "bare-1", mounts: [] });
    const result = await provisionSessionSandbox({
      sandbox, tenantId: "t", sessionId: "s", loadResources: null, mintIncarnation: () => "fresh-2",
    });

    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(provisioned.map((p) => p.incarnation)).toEqual(["bare-1", "fresh-2"]);
    expect(result).toMatchObject({ incarnation: "fresh-2", started: true });
  });

  it("retries a failed start and reports the last error after the final attempt", async () => {
    const flaky = fakeSandbox({ running: false, incarnation: null });
    flaky.sandbox.failures = 2;
    const sleep = vi.fn(async () => undefined);
    await expect(provisionSessionSandbox({ sandbox: flaky.sandbox, tenantId: null, sessionId: null, loadResources: null, sleep }))
      .resolves.toMatchObject({ started: true });
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);

    const broken = fakeSandbox({ running: false, incarnation: null });
    broken.sandbox.failures = 3;
    await expect(provisionSessionSandbox({ sandbox: broken.sandbox, tenantId: null, sessionId: null, loadResources: null, sleep }))
      .rejects.toThrow("Sandbox container failed to start after 3 attempts. Last error: container did not start");
  });

  it("recognizes only sandboxes that expose the whole provisioning surface", () => {
    expect(supportsSandboxProvisioning(fakeSandbox({ running: false, incarnation: null }).sandbox)).toBe(true);
    expect(supportsSandboxProvisioning({ exec: async () => "" })).toBe(false);
    expect(supportsSandboxProvisioning(null)).toBe(false);
  });
});
