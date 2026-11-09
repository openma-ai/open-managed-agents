import { describe, expect, it } from "vitest";

import { AcpSandboxHarness } from "../src/acp-sandbox-loop";
import type { HarnessContext } from "../src/interface";
import { DYING_ACP_AGENT, dyingAcpAgentSandbox } from "../../../test/fakes/dying-acp-agent-sandbox";

// e2e cf-container-acp-mm-r1 (session_30b83e8f17f44e72a04e92393e8169f4):
// pi-acp vanished mid-turn on Cloudflare and the session stayed running.
// Node's pipe ends stdout when the child dies, so the ACP SDK fails the
// prompt with "ACP connection closed"; Cloudflare's RPC stdio can report the
// exit while stdout stays open. Both must end the turn with session.error.
async function runTurn(stdoutEndsOnExit: boolean) {
  const events: Array<Record<string, unknown>> = [];
  const runtime = {
    sandbox: dyingAcpAgentSandbox({ stdoutEndsOnExit }),
    history: { getEvents: () => [] },
    broadcast: (event: Record<string, unknown>) => events.push(event),
    broadcastStreamStart: async () => {},
    broadcastChunk: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
  };
  const harness = new AcpSandboxHarness();
  try {
    await harness.run({
      agent: { model: "minimax-m31-flash", acp: { agent: DYING_ACP_AGENT } },
      session_id: "session_child_exit",
      userMessage: { type: "user.message", content: [{ type: "text", text: "hello" }] },
      systemPrompt: "",
      env: { ANTHROPIC_API_KEY: "" },
      runtime,
    } as unknown as HarnessContext);
  } finally {
    await harness.dispose("destroy");
  }
  return events.filter((event) => event.type === "session.error");
}

const EXIT_ERROR = {
  type: "session.error",
  error: "The agent process exited before it could accept the prompt (parity-acp-agent, exit code 137). "
    + "Reopen the task to restart it, or check this agent's setup and sign-in.",
};

describe("AcpSandboxHarness when the ACP child exits mid-turn", () => {
  it("ends the turn with session.error when stdout closes with the child (Node pipes)", async () => {
    expect(await runTurn(true)).toEqual([EXIT_ERROR]);
  });

  it("ends the turn with the same session.error when only the exit is reported (Cloudflare RPC stdio)", async () => {
    expect(await runTurn(false)).toEqual([EXIT_ERROR]);
  }, 10_000);
});
