import { describe, expect, it } from "vitest";

import { AcpSandboxHarness } from "../../../packages/agent-harness/src/acp-sandbox-loop";
import type { HarnessContext } from "../../../packages/agent-harness/src/interface";

// e2e 42d7c785 (session_hLxyQiRfRNX8Gc2KS7wh8): pi's model call failed and
// pi-acp answered session/prompt with a plain end_turn, so the turn ended
// with no output, 0 tokens and no error. This fake ACP agent does the same;
// the sandbox's exec serves pi's session JSONL, where pi 0.84 records the
// failure on the assistant message (stopReason "error" + errorMessage).
function silentPiSandbox(transcript: string) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    exec: async (command: string) => command.includes(".pi/agent/sessions") ? transcript : "",
    readFile: async () => { throw new Error("absent"); },
    writeFile: async (path: string) => path,
    async spawnDuplexProcess() {
      let output!: ReadableStreamDefaultController<Uint8Array>;
      let exit!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve; });
      const send = (message: unknown) => output.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
      let buffered = "";
      return {
        stdout: new ReadableStream<Uint8Array>({ start: (controller) => { output = controller; } }),
        stderr: new ReadableStream<Uint8Array>(),
        stdin: new WritableStream<Uint8Array>({
          write(chunk) {
            buffered += decoder.decode(chunk);
            let index: number;
            while ((index = buffered.indexOf("\n")) >= 0) {
              const request = JSON.parse(buffered.slice(0, index)) as { id?: number; method: string };
              buffered = buffered.slice(index + 1);
              const result = (value: unknown) => send({ jsonrpc: "2.0", id: request.id, result: value });
              if (request.method === "initialize") result({ protocolVersion: 1, agentCapabilities: {} });
              else if (request.method === "session/new") result({ sessionId: "pi-session" });
              else if (request.method === "session/prompt") result({ stopReason: "end_turn" });
              else if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
            }
          },
        }),
        exited,
        async kill() { try { output.close(); } catch { /* closed */ } exit({ code: 0, signal: null }); },
      };
    },
  };
}

async function runTurn(transcript: string) {
  const events: Array<Record<string, unknown>> = [];
  const runtime = {
    sandbox: silentPiSandbox(transcript),
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
      agent: { model: "deepseek-flash", acp: { agent: { id: "pi-acp", command: "pi-acp", cwd: "/workspace" } } },
      session_id: "session_silent",
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

const piTranscript = [
  { type: "session", version: 3 },
  { type: "message", message: { role: "user", content: [] } },
  { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: '401: {"message":"Unauthorized"}' } },
].map((entry) => JSON.stringify(entry)).join("\n");

describe("AcpSandboxHarness turn without output", () => {
  it("surfaces the error pi recorded but pi-acp swallowed", async () => {
    expect(await runTurn(piTranscript)).toEqual([
      { type: "session.error", error: 'ACP agent turn failed: 401: {"message":"Unauthorized"}' },
    ]);
  });

  it("reports an end_turn with no output as an error even without a transcript", async () => {
    expect(await runTurn("")).toEqual([
      { type: "session.error", error: "ACP agent ended the turn without any output; check its model configuration" },
    ]);
  });
});
