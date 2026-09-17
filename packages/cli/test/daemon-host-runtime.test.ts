import { expect, it } from "vitest";
import { DaemonHost } from "@open-managed-agents/runtime/daemon-host";
import { SessionManager } from "../src/bridge/lib/session-manager.js";
import { acpSessionFixture } from "../../managed-agents-runtime/test/acp-fixtures.js";

it("drains the real CLI session manager before releasing its output connection", async () => {
  let finishTurn!: () => void;
  const turn = new Promise<void>((resolve) => { finishTurn = resolve; });
  let prompting!: () => void;
  const started = new Promise<void>((resolve) => { prompting = resolve; });
  const events: Array<Record<string, unknown>> = [];
  let connected = false;
  const manager = new SessionManager((message) => {
    if (connected) events.push(message);
  }, {
    acpRuntime: { async start() { return acpSessionFixture({
      acpSessionId: "native",
      async *prompt() {
        prompting();
        await turn;
        yield { type: "promptComplete", stopReason: "end_turn" };
      },
      async dispose() { events.push({ type: "native.disposed" }); },
    }); } },
    async prepareSession() { return { agent: { command: "fixture" } }; },
  });
  manager.setTenantKeys([{ id: "workspace", agentApiKey: "test-only" }]);
  const host = new DaemonHost({
    connection: { start() { connected = true; }, stop() { connected = false; events.push({ type: "disconnected" }); } },
    sessions: manager, drainDeadlineMs: 1_000,
  });
  host.start();
  try {
    await manager.start({ session_id: "s", agent_id: "fixture", tenant_id: "workspace" });
    const prompt = manager.prompt({ session_id: "s", turn_id: "t", text: "go" });
    await started;
    const stopped = host.stop();
    await manager.start({ session_id: "too-late", agent_id: "fixture", tenant_id: "workspace" });
    expect(events.some((event) => event.type === "session.error" && event.session_id === "too-late")).toBe(true);
    // Reusing an existing session must not bypass shutdown admission.
    const latePrompt = manager.prompt({ session_id: "s", turn_id: "too-late-turn", text: "do more" });
    await expect.poll(() => events.some((event) => event.type === "session.error" && event.turn_id === "too-late-turn"), { timeout: 300 }).toBe(true);
    await latePrompt;
    expect(connected).toBe(true);
    finishTurn();
    await prompt;
    await expect(stopped).resolves.toEqual({ kind: "drained", summary: { initialTurns: 1, abortedTurns: 0, sessions: 1 } });
    expect(events.slice(-3)).toEqual([
      { type: "session.complete", session_id: "s", turn_id: "t", tenant_id: "workspace" },
      { type: "native.disposed" },
      { type: "disconnected" },
    ]);
  } finally { finishTurn(); await host.stop({ force: true }); }
});
