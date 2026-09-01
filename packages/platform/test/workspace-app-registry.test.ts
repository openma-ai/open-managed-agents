import { describe, expect, it, vi } from "vitest";
import { createApp, type App } from "@open-managed-agents/app";
import { WorkspaceAppRegistry } from "../src/index";

function testApp(stop: () => void): App {
  const app = createApp({ modules: [] });
  return { ...app, stop: async () => stop() };
}

describe("WorkspaceAppRegistry", () => {
  it("reuses one app within a workspace and never across workspaces", () => {
    const created: string[] = [];
    const registry = new WorkspaceAppRegistry({
      createApp({ workspaceId }) {
        created.push(workspaceId);
        return testApp(() => undefined);
      },
    });

    const first = registry.app({ workspaceId: "workspace_a" });
    expect(registry.app({ workspaceId: "workspace_a" })).toBe(first);
    expect(registry.app({ workspaceId: "workspace_b" })).not.toBe(first);
    expect(created).toEqual(["workspace_a", "workspace_b"]);
  });

  it("removes before stopping so a new request cannot receive a stopping app", async () => {
    const stop = vi.fn();
    const registry = new WorkspaceAppRegistry({
      createApp: () => testApp(stop),
    });
    const first = registry.app({ workspaceId: "workspace_a" });

    await expect(registry.stop("workspace_a")).resolves.toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(registry.existing("workspace_a")).toBeUndefined();
    expect(registry.app({ workspaceId: "workspace_a" })).not.toBe(first);
    await expect(registry.stop("missing")).resolves.toBe(false);
  });

  it("rejects empty workspace identities at the platform boundary", () => {
    const registry = new WorkspaceAppRegistry({
      createApp: () => testApp(() => undefined),
    });
    expect(() => registry.app({ workspaceId: "  " })).toThrow(
      "workspaceId must not be empty",
    );
  });
});
