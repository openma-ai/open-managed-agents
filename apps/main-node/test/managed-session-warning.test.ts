import { describe, expect, it } from "vitest";
import { DefaultNodeManagedSessionRuntimeDriver } from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";

describe("publishSessionWarning", () => {
  it("records and publishes a session.warning with no execution fence, outside any turn", async () => {
    const recorded: Array<{ events: Array<{ type: string; source?: string; message?: string }>; executionFence?: unknown }> = [];
    const published: unknown[] = [];
    const driver = new DefaultNodeManagedSessionRuntimeDriver({
      engine: { start: async () => undefined, stop: async () => undefined, accept: async () => undefined, archiveThread: async () => undefined },
      realtime: { attach: () => () => undefined, publish: (input: { frame: { event: unknown } }) => { published.push(input.frame.event); }, closeSession: () => undefined },
      projectionFor: () => ({
        recordSessionRuntimeEvents: async (command: never) => { recorded.push(command); return { type: "recorded", session: {} }; },
      }),
    } as never);
    await driver.publishSessionWarning({ workspaceId: "ws", sessionId: "s1", source: "environment_cache", message: "snapshot_build_failed: boom" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.events[0]).toMatchObject({ type: "session.warning", source: "environment_cache", message: "snapshot_build_failed: boom" });
    expect(recorded[0]).not.toHaveProperty("executionFence");
    expect(published).toEqual([expect.objectContaining({ type: "session.warning", source: "environment_cache" })]);
  });
});
