import { describe, expect, it } from "vitest";
import { createManagedAcpSupervisorHarness } from "../src/index.js";
import { createNodeManagedAcpWorkItemRunner, NodeManagedAcpWorkItemFailure } from "../src/node-work-item.js";

const environment = {
  ANTHROPIC_BASE_URL: "https://control.test",
  ANTHROPIC_ENVIRONMENT_ID: "env", ANTHROPIC_SESSION_ID: "session", ANTHROPIC_WORK_ID: "work",
  ANTHROPIC_WORK_SECRET: Buffer.from(JSON.stringify({ sessions_token: "scoped", api_base_url: "https://control.test" })).toString("base64url"),
  OPENMA_HARNESS_ID: "test",
};
const scheduler = { sleep: async (_ms: number, signal: AbortSignal) => new Promise<void>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
}) };

// Real Work lifecycle + real common supervisor. Only the external command
// transport and ACP process boundary are fixtures; no fake drain/completed.
function fixture(input: { checkpoint?: () => Promise<void>; runError?: Error; releaseError?: Error; cleanupError?: Error; prompt?: boolean; dispose?: () => Promise<void>; stopError?: Error }) {
  const effects: string[] = [];
  const harness = createManagedAcpSupervisorHarness({
    connect: async () => ({
      async *commands() {
        effects.push("commands");
        // Use the real runtime/session host; only ACP process I/O is replaced.
        yield { type: "session.start" as const, sessionId: "session", agentId: "test", runtime: "cloud" as const, cwd: "/workspace" };
        if (input.prompt) yield { type: "session.prompt" as const, sessionId: "session", turnId: "turn", text: "write output" };
        if (input.runError) throw input.runError;
        yield { type: "control.complete" as const, workId: "work" };
      },
      publish: async event => { effects.push(event.type); },
      close: async () => { effects.push("close"); if (input.cleanupError) throw input.cleanupError; },
    }),
    acpRuntime: { start: async () => {
      effects.push("acp-start");
      return {
        acpSessionId: "native", isAlive: () => true,
        async *prompt() { effects.push("prompt"); yield { type: "promptComplete", response: {} }; effects.push("prompt-drained"); },
        async dispose() { effects.push("acp-dispose"); await input.dispose?.(); },
      } as never;
    } },
    sessionPreparation: { prepare: async () => ({ agent: { command: "/fixture/acp" } }) },
    sessionState: {
      beforeStart: async command => ({ command }), onReady: async () => {}, checkpoint: async () => {},
      release: async () => { effects.push("release"); if (input.releaseError) throw input.releaseError; },
    },
    drainDeadlineMs: 0, abortGraceMs: 0,
  });
  const runner = createNodeManagedAcpWorkItemRunner({
    environment, scheduler,
    onError: async () => { effects.push("reported-error"); },
    checkpoint: input.checkpoint === undefined ? undefined : async () => { effects.push("checkpoint"); await input.checkpoint!(); },
    lifecycleClient: {
      ack: async () => { effects.push("ack"); return {}; },
      heartbeat: async () => ({ last_heartbeat: "one", lease_extended: true, state: "running", ttl_seconds: 90 }),
      stop: async () => { effects.push("work-stop"); if (input.stopError) throw input.stopError; return {}; },
    },
    fetch: async (raw, init) => {
      const request = new Request(raw, init);
      const action = request.url.split("/").at(-1)!;
      effects.push(action);
      return Response.json(action === "startup-boundary" ? { revision: 1 } : { type: "committed" });
    },
    supervisorApp: { resolveHarness: async () => harness, serve: async () => {} },
  });
  return { runner, effects };
}

describe("Work finalization safety with the real common supervisor", () => {
  it("refuses to launch with an unconfigured storage barrier instead of using a noop", async () => {
    const f = fixture({});
    await expect(f.runner.run()).rejects.toThrow(/checkpoint.*configured/i);
    expect(f.effects).not.toContain("commands");
    expect(f.effects).not.toContain("work-stop");
    expect(f.effects).not.toContain("startup-failed");
  });

  it("does not settle a run failure as startup exhaustion", async () => {
    const f = fixture({ checkpoint: async () => {}, runError: new Error("command stream failed after start") });
    await expect(f.runner.run()).rejects.toMatchObject({ phase: "run", message: "command stream failed after start" });
    expect(f.effects).toContain("close");
    expect(f.effects).not.toContain("startup-failed");
    expect(f.effects).not.toContain("work-stop");
  });

  it("does not settle a real drain failure as startup exhaustion", async () => {
    const f = fixture({ checkpoint: async () => {}, releaseError: new Error("native state release failed") });
    await expect(f.runner.run()).rejects.toMatchObject({ phase: "finalization", message: "native state release failed" });
    expect(f.effects).toContain("release");
    expect(f.effects).not.toContain("startup-failed");
    expect(f.effects).not.toContain("work-stop");
  });

  it("retains both execution and cleanup errors instead of silently dropping cleanup failure", async () => {
    const runError = new Error("command stream failed");
    const cleanupError = new Error("control close failed");
    const f = fixture({ checkpoint: async () => {}, runError, cleanupError });
    const error = await f.runner.run().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: runError.message }), cleanupError]));
    expect(f.effects).not.toContain("startup-failed");
    expect(f.effects).not.toContain("work-stop");
  });
});

// Characterization of the installed common, not a passing finalization claim:
// terminal publication is already visible before the barrier throws. This is
// the forbidden ordering the parent's pre-terminal seam must replace.
it("records installed common's terminal-before-barrier and drain-after-barrier ordering", async () => {
  const f = fixture({ prompt: true, checkpoint: async () => { throw new Error("storage unavailable"); } });
  await expect(f.runner.run()).rejects.toMatchObject({ phase: "finalization", message: "storage unavailable" });
  const relevant = f.effects.filter(e => ["prompt-drained", "session.complete", "checkpoint", "acp-dispose"].includes(e));
  expect(relevant).toEqual(["prompt-drained", "session.complete", "checkpoint", "acp-dispose"]);
  expect(f.effects).not.toContain("startup-failed");
  expect(f.effects).not.toContain("work-stop");
});

it("requires explicit phase evidence for asynchronous startup exhaustion", async () => {
  const f = fixture({ checkpoint: async () => {}, runError: new NodeManagedAcpWorkItemFailure("startup", new Error("spawn exhausted")) });
  await expect(f.runner.run()).rejects.toMatchObject({ phase: "startup", message: "spawn exhausted" });
  expect(f.effects).toContain("startup-failed");
  expect(f.effects).not.toContain("work-stop");
});

it("does not stop Work when cancellation arrives during actual runtime drain", async () => {
  let entered!: () => void; const draining = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const f = fixture({ checkpoint: async () => {}, dispose: async () => { entered(); await gate; } });
  const result = f.runner.run(controller.signal).catch(error => error);
  await draining;
  controller.abort(new Error("ownership revoked during drain")); release();
  expect(await result).toMatchObject({ phase: "finalization", message: "ownership revoked during drain" });
  expect(f.effects).not.toContain("startup-failed");
  expect(f.effects).not.toContain("work-stop");
});

it("does not report success when the final Work stop response fails", async () => {
  const f = fixture({ checkpoint: async () => {}, stopError: new Error("stop response lost") });
  await expect(f.runner.run()).rejects.toMatchObject({ phase: "finalization", message: "stop response lost" });
  expect(f.effects).toContain("close");
  expect(f.effects).not.toContain("startup-failed");
});
