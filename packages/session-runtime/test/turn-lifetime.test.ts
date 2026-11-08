import { describe, expect, it, vi } from "vitest";
import type { RuntimeAdapter } from "../src/ports";
import { runAgentTurn, TurnAborted, type TurnRuntimeAgent } from "../../../apps/agent/src/runtime/turn-runtime";

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

async function causeOf(run: Promise<unknown>) {
  const error = await run.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TurnAborted);
  return (error as TurnAborted).cause;
}

describe("runAgentTurn", () => {
  it("marks, runs, persists, then clears the marker in that order", async () => {
    const { agent, calls } = fakeAgent();
    const result = await runAgentTurn(agent, "turn:1", async (ctx) => {
      calls.push(`body:${ctx.turnName}`);
      return 7;
    }, { persistWorkspace: async () => { calls.push("persist"); } });
    expect(result).toBe(7);
    expect(calls).toEqual(["begin", "hint", "body:turn:1", "persist", "end:idle", "ended"]);
  });

  it("exposes the parent signal to the body", async () => {
    const { agent } = fakeAgent();
    const parent = new AbortController();
    const seen = await runAgentTurn(agent, "t", async (ctx) => ctx.signal, { parentSignal: parent.signal });
    expect(seen).toBe(parent.signal);
  });

  it("persists partial state on failure and still clears the marker", async () => {
    const { agent, calls } = fakeAgent();
    await causeOf(runAgentTurn(agent, "t", async () => { throw new Error("boom"); }, {
      persistWorkspace: async () => { calls.push("persist"); throw new Error("disk"); },
    }));
    expect(calls).toEqual(["begin", "hint", "persist", "end:idle", "ended"]);
  });

  it("surfaces a persist failure after a successful body as backup_failed", async () => {
    const { agent } = fakeAgent();
    expect(await causeOf(runAgentTurn(agent, "t", async () => 1, {
      persistWorkspace: async () => { throw new Error("disk full"); },
    }))).toEqual({ kind: "backup_failed", message: "disk full" });
  });

  it("swallows endTurn failures and still fires hintTurnEnded", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => undefined);
    const { agent, calls } = fakeAgent({ endTurn: async () => { throw new Error("d1 down"); } });
    await expect(runAgentTurn(agent, "t", async () => "ok")).resolves.toBe("ok");
    expect(calls).toContain("ended");
  });

  it.each([
    ["stream stalled", "stream_stall"],
    ["HTTP 429 from provider", "rate_limited"],
    ["request timed out", "model_timeout"],
    ["The operation was aborted", "model_timeout"],
    ["abort: user", "user_aborted"],
    ["no idea", "unexpected"],
  ])("classifies %j as %s", async (message, kind) => {
    const { agent } = fakeAgent();
    expect((await causeOf(runAgentTurn(agent, "t", async () => { throw new Error(message); }))).kind).toBe(kind);
  });

  it("reads retry-after and provider status", async () => {
    const { agent } = fakeAgent();
    expect(await causeOf(runAgentTurn(agent, "t", async () => { throw new Error("429 retry-after: 3"); })))
      .toMatchObject({ kind: "rate_limited", retry_after_ms: 3000 });
    const paid = Object.assign(new Error("payment"), { status: 402 });
    expect(await causeOf(runAgentTurn(agent, "t", async () => { throw paid; })))
      .toEqual({ kind: "model_error", status: 402, message: "payment" });
  });

  it("does not re-wrap a TurnAborted thrown by the body", async () => {
    const { agent } = fakeAgent();
    const original = new TurnAborted({ kind: "user_aborted" });
    await expect(runAgentTurn(agent, "t", async () => { throw original; })).rejects.toBe(original);
  });
});
