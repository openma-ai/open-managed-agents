import { describe, expect, it, vi } from "vitest";
import type { RuntimeAdapter } from "../src/ports";
import type { TurnRuntimeAgent } from "../src/turn-lifetime";
import { clearTurnRecoveryCount, recoverAgentTurn } from "../src/turn-recovery";

function fakeAgent(overrides: Partial<RuntimeAdapter> = {}) {
  const calls: string[] = [];
  const store = new Map<string, unknown>();
  const adapter = {
    beginTurn: async () => { calls.push("begin"); },
    endTurn: async (_s: string, _t: string, status: string) => { calls.push(`end:${status}`); },
    hintTurnInFlight: () => { calls.push("hint"); },
    hintTurnEnded: () => { calls.push("ended"); },
    ...overrides,
  } as unknown as RuntimeAdapter;
  const agent: TurnRuntimeAgent = {
    adapter,
    sessionId: "sess_1",
    storage: {
      get: async <V,>(key: string) => store.get(key) as V | undefined,
      put: async (key, value) => { store.set(key, value); },
      delete: async (key) => { store.delete(key); },
    },
  };
  return { agent, calls, store };
}

const ctx = { id: "fiber", name: "turn:1", snapshot: null };
const KEY = "turn_recovery:turn:1";
const load = async () => ({
  history: [],
  partialStreams: [
    { message_id: "m1", partial_text: "half", status: "interrupted" as const },
    { message_id: "m2", partial_text: "", status: "streaming" as const },
  ],
});

describe("recoverAgentTurn", () => {
  it("counts recoveries durably while the turn continues", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { agent, store } = fakeAgent();
    const seen: number[] = [];
    const resume = async (r: { recoveryCount: number }) => { seen.push(r.recoveryCount); return { continue: true }; };
    await recoverAgentTurn(agent, ctx, load, resume);
    await recoverAgentTurn(agent, ctx, load, resume);
    expect(seen).toEqual([1, 2]);
    expect(store.get(KEY)).toBe(2);
  });

  it("persists only non-empty partials when asked, and resets an abandoned turn", async () => {
    const { agent, store } = fakeAgent();
    const persisted: string[] = [];
    const decision = await recoverAgentTurn(agent, ctx, load, async () => ({ continue: false, persistPartial: true }), {
      persistAgentMessage: (text, id) => { persisted.push(`${id}:${text}`); },
    });
    expect(decision).toEqual({ continue: false, persistPartial: true });
    expect(persisted).toEqual(["m1:half"]);
    expect(store.has(KEY)).toBe(false);
  });

  it("stops at the cap with session.error + forced idle and does not resume", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { agent, store } = fakeAgent();
    store.set(KEY, 5);
    const events: unknown[] = [];
    let idled = false;
    const resume = vi.fn();
    const decision = await recoverAgentTurn(agent, ctx, load, resume, {
      emitEvent: (event) => { events.push(event); },
      forceIdle: () => { idled = true; },
    });
    expect(decision).toEqual({ continue: false });
    expect(resume).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session.error" });
    expect(idled).toBe(true);
    expect(store.has(KEY)).toBe(false);
  });

  it("clearTurnRecoveryCount removes the counter", async () => {
    const { agent, store } = fakeAgent();
    store.set(KEY, 3);
    await clearTurnRecoveryCount(agent, "turn:1");
    expect(store.has(KEY)).toBe(false);
  });
});
