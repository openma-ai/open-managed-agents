import { describe, expect, it } from "vitest";
import { NodeSessionRouter } from "../src/lib/node-session-router";

describe("NodeSessionRouter", () => {
  it("publishes session.error when session initialization fails", async () => {
    const events: any[] = [];
    const log = {
      appendAsync: async (event: any) => {
        events.push(event);
      },
      getEventsAsync: async () => events,
    };
    const router = new NodeSessionRouter({
      sql: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ tenant_id: "tenant-1", agent_id: "agent-1" }),
          }),
        }),
      } as any,
      hub: { publish: (_sessionId: string, event: unknown) => events.push(event) } as any,
      registry: {
        getOrCreate: async () => {
          throw new Error("sandbox unavailable");
        },
        interrupt: () => undefined,
      } as any,
      newEventLog: () => log as any,
    });

    await expect(
      router.appendEvent("session-1", {
        type: "user.message",
        message: { role: "user", content: "hello" },
      } as any),
    ).resolves.toMatchObject({ status: 202 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.error",
          error: "session_initialization_failed",
          message: "sandbox unavailable",
        }),
      ]),
    );
  });
});
