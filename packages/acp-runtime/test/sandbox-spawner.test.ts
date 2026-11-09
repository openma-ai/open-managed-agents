import { describe, expect, it } from "vitest";

import type { SandboxDuplexProcess } from "@open-managed-agents/sandbox";
import { createAcpRuntime } from "../src/placement";
import { SandboxSpawner, STDOUT_DRAIN_AFTER_EXIT_MS } from "../src/spawners/sandbox";

// e2e cf-container-acp-mm-r1 (session_30b83e8f17f44e72a04e92393e8169f4):
// Cloudflare's RPC stdio reported pi-acp's exit while stdout stayed open, so
// the ACP engine never saw the agent go and the turn stayed running.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A duplex process whose stdout never ends on its own: it answers
 * initialize / session/new, and dies at `dieOn` without a reply. */
function openStdoutProcess(dieOn: "initialize" | "session/prompt") {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (value: { code: number | null; signal: string | null }) => void;
  let gone = false;
  const send = (message: unknown) => output.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
  let buffered = "";
  const process: SandboxDuplexProcess = {
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => { output = controller; } }),
    stderr: new ReadableStream<Uint8Array>(),
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        if (gone) throw new Error("stream is closed");
        buffered += decoder.decode(chunk);
        let index: number;
        while ((index = buffered.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffered.slice(0, index)) as { id?: number; method: string };
          buffered = buffered.slice(index + 1);
          if (request.method === dieOn) {
            gone = true;
            exit({ code: 137, signal: null });
          } else if (request.method === "initialize") {
            send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          } else if (request.method === "session/new") {
            send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "open-stdout" } });
          }
        }
      },
    }),
    exited: new Promise((resolve) => { exit = resolve; }),
    kill: async () => { if (!gone) { gone = true; exit({ code: null, signal: "SIGKILL" }); } },
  };
  return { process, send: (message: unknown) => send(message), die: () => { gone = true; exit({ code: 1, signal: null }); } };
}

const agent = { command: "open-stdout-agent", cwd: "/workspace" };

describe("SandboxSpawner stdout", () => {
  it("delivers what the process wrote, then ends after the exit drain window", async () => {
    const child = openStdoutProcess("session/prompt");
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    const reader = handle.stdout.getReader();
    child.send({ written: "before exit" });
    child.die();
    const started = Date.now();
    expect(decoder.decode((await reader.read()).value)).toBe('{"written":"before exit"}\n');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(Date.now() - started).toBeGreaterThanOrEqual(STDOUT_DRAIN_AFTER_EXIT_MS - 50);
  }, 10_000);

  it("ends with the process's own stdout when the bridge closes it", async () => {
    const process: SandboxDuplexProcess = {
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(encoder.encode("x")); controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>(),
      stdin: new WritableStream<Uint8Array>(),
      exited: new Promise(() => {}),
      kill: async () => {},
    };
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => process }).spawn(agent);
    const reader = handle.stdout.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe("x");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("fails start when the agent dies during initialize with stdout left open", async () => {
    const child = openStdoutProcess("initialize");
    const runtime = createAcpRuntime({ type: "sandbox", sandbox: { spawnDuplexProcess: async () => child.process } });
    await expect(runtime.start({ agent })).rejects.toThrow();
  }, 10_000);

  it("fails the prompt like a Node pipe when the agent dies mid-turn with stdout left open", async () => {
    const child = openStdoutProcess("session/prompt");
    const runtime = createAcpRuntime({ type: "sandbox", sandbox: { spawnDuplexProcess: async () => child.process } });
    const session = await runtime.start({ agent });
    const consume = async () => { for await (const _ of session.prompt("hello")) { /* drain */ } };
    await expect(consume()).rejects.toThrow(
      "The agent process exited before it could accept the prompt (open-stdout-agent, exit code 137).",
    );
    expect(session.isAlive()).toBe(false);
    await session.dispose();
  }, 10_000);
});
