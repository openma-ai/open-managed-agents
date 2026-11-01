import { describe, expect, it } from "vitest";
import { NodeSessionRouter } from "../../../packages/control-plane-node/src/lib/node-session-router";

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

  function harnessRouter(pollSteering: boolean) {
    const published: any[] = [];
    const logEvents: any[] = [];
    let n = 0;
    const log = {
      appendAsync: async (event: any) => { logEvents.push({ ...event, id: event.id ?? `sevt_${++n}` }); },
      getEventsAsync: async () => logEvents,
    };
    const turns: string[] = [];
    const steeredInTurn: string[][] = [];
    let inflight = false;
    let release!: () => void;
    let midAccepted!: () => void;
    const midSeen = new Promise<void>((resolve) => { midAccepted = resolve; });
    const machine = {
      hasInflightTurn: () => inflight,
      runHarnessTurn: async (_agent: string, ev: any, opts: { takeSteeringInputs?: () => Promise<any[]> } = {}) => {
        inflight = true;
        turns.push(ev.id);
        if (turns.length === 1) {
          await midSeen; // a tool call is running when the user sends again
          if (pollSteering) {
            // next LLM/tool-call boundary inside this same turn
            steeredInTurn.push((await opts.takeSteeringInputs!()).map((e) => e.id));
          }
          await new Promise<void>((resolve) => { release = resolve; });
        }
        inflight = false;
      },
    };
    const router = new NodeSessionRouter({
      sql: { prepare: () => ({ bind: () => ({ first: async () => ({ tenant_id: "t", agent_id: "a" }) }) }) } as any,
      hub: { publish: (_s: string, event: unknown) => published.push(event) } as any,
      registry: { getOrCreate: async () => ({ machine }), interrupt: () => undefined } as any,
      newEventLog: () => log as any,
    });
    return { router, turns, steeredInTurn, published, release: () => release(), midAccepted: () => midAccepted() };
  }

  it("steers a mid-run user.message into the running harness turn (after-call), not an after-turn drain", async () => {
    const h = harnessRouter(true);
    await h.router.appendEvent("s1", { type: "user.message", content: [{ type: "text", text: "go" }] } as any);
    await new Promise((r) => setTimeout(r, 5));
    await h.router.appendEvent("s1", { type: "user.message", content: [{ type: "text", text: "also" }] } as any);
    h.midAccepted();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.steeredInTurn).toEqual([["sevt_2"]]);
    expect(h.published).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "system.user_message_steered", event_id: "sevt_2" }),
      expect.objectContaining({ id: "sevt_2", processed_at: expect.any(String) }),
    ]));
    h.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.turns).toEqual(["sevt_1"]);
  });

  it("falls back to drain-after-idle when the harness never polls for steering", async () => {
    const h = harnessRouter(false);
    await h.router.appendEvent("s1", { type: "user.message", content: [{ type: "text", text: "go" }] } as any);
    await new Promise((r) => setTimeout(r, 5));
    await h.router.appendEvent("s1", { type: "user.message", content: [{ type: "text", text: "also" }] } as any);
    h.midAccepted();
    await new Promise((r) => setTimeout(r, 5));
    h.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.turns).toEqual(["sevt_1", "sevt_2"]);
  });
});
