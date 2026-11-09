import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

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
  it("logs bounded payload-free exit and both output drain timings", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const child = openStdoutProcess("session/prompt");
      child.process.stderr = new ReadableStream({ start(c) { c.enqueue(encoder.encode("PRIVATE-DIAGNOSTIC")); c.close(); } });
      child.process.stdout = new ReadableStream({ start(c) { c.enqueue(encoder.encode("PRIVATE-PAYLOAD")); c.close(); } });
      const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
      child.die();
      for await (const _ of handle.stdout) {}
      for await (const _ of handle.stderr) {}
      const entries = log.mock.calls.map(call => String(call[0])).filter(line => line.includes("acp.process_exit_stdio"));
      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toMatch(/PRIVATE|open-stdout-agent/);
      expect(JSON.parse(entries[0])).toMatchObject({ event: "acp.process_exit_stdio", exitAtMs: expect.any(Number),
        stdout: { lastByteAtMs: expect.any(Number), eofAtMs: expect.any(Number), outcome: "eof" },
        stderr: { lastByteAtMs: expect.any(Number), eofAtMs: expect.any(Number), outcome: "eof" } });
    } finally { log.mockRestore(); }
  });
  it("logs timed-out EOF observation without falsely logging successful EOF", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const child = openStdoutProcess("session/prompt");
      const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
      const output = expect(handle.stdout.getReader().read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
      const errorOutput = expect(handle.stderr.getReader().read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
      child.die();
      await Promise.all([output, errorOutput]);
      const entries = log.mock.calls.map(call => String(call[0])).filter(line => line.includes("acp.process_exit_stdio"));
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0])).toMatchObject({ stdout: { eofAtMs: null, timedOutAtMs: expect.any(Number), outcome: "timed_out" }, stderr: { eofAtMs: null, timedOutAtMs: expect.any(Number), outcome: "timed_out" } });
    } finally { log.mockRestore(); }
  }, 5_000);
  it("reports uncertain transport drain instead of EOF before a tail delayed beyond the quiet window", async () => {
    const child = openStdoutProcess("session/prompt");
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    const reader = handle.stdout.getReader();
    child.die();
    const result = reader.read().then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setTimeout(resolve, 2_200));
    try { child.send({ late: "tail" }); } catch { /* cancelled transport */ }
    expect(await result).toMatchObject({ error: { name: "SandboxAcpTransportError", message: expect.stringContaining("stdout drain was not confirmed") } });
  }, 5_000);

  it("rejects both close and closed when the underlying stdin close never completes", async () => {
    const child = openStdoutProcess("session/prompt");
    let started!: () => void;
    const closing = new Promise<void>(resolve => { started = resolve; });
    child.process.stdin = new WritableStream({ close() { started(); return new Promise<void>(() => {}); } });
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    const writer = handle.stdin.getWriter();
    const closeResult = expect(writer.close()).rejects.toThrow("stdin is closed");
    const closedResult = expect(writer.closed).rejects.toThrow("stdin is closed");
    await closing;
    child.die();
    await Promise.all([closeResult, closedResult]);
  }, 3_000);
  it("restarts the idle drain window for delayed tail packets", async () => {
    const child = openStdoutProcess("session/prompt");
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    const reader = handle.stdout.getReader();
    child.die();
    const first = reader.read();
    await new Promise(resolve => setTimeout(resolve, 1_200));
    child.send({ tail: 1 });
    expect(decoder.decode((await first).value)).toContain('"tail":1');
    const second = reader.read();
    await new Promise(resolve => setTimeout(resolve, 1_200));
    child.send({ tail: 2 });
    expect(decoder.decode((await second).value)).toContain('"tail":2');
    await expect(reader.read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
  }, 10_000);

  it.each(["zero", "signal", "crash", "dispose", "rejected"])("terminates all bridge stdio and flushes diagnostics after %s", async mode => {
    let exit!: (value: { code: number | null; signal: string | null }) => void;
    let reject!: (reason: Error) => void;
    let aborted = false;
    const diagnostics: string[] = [];
    const process: SandboxDuplexProcess = {
      stdout: new ReadableStream(),
      stderr: new ReadableStream({ start(c) { c.enqueue(encoder.encode("last diagnostic")); } }),
      stdin: new WritableStream({ abort() { aborted = true; } }),
      exited: new Promise((resolve, fail) => { exit = resolve; reject = fail; }),
      kill: async () => { exit({ code: null, signal: "SIGTERM" }); },
    };
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => process }).spawn({ ...agent, onDiagnosticLine: line => diagnostics.push(line) });
    const writer = handle.stdin.getWriter();
    const stopped = writer.closed.catch(() => undefined);
    const stdout = expect(handle.stdout.getReader().read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
    const stderr = handle.stderr.getReader();
    expect(decoder.decode((await stderr.read()).value)).toBe("last diagnostic");
    if (mode === "rejected") reject(new Error("bridge disconnected"));
    else if (mode === "dispose") await handle.kill();
    else exit({ code: mode === "zero" ? 0 : mode === "signal" ? 137 : 1, signal: mode === "signal" ? "SIGKILL" : null });
    await stopped;
    expect(aborted).toBe(true);
    await expect(writer.write(encoder.encode("late"))).rejects.toThrow();
    await stdout;
    await expect(stderr.read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
    expect(diagnostics).toEqual(["last diagnostic"]);
  }, 8_000);

  it("rejects a blocked stdin write on exit without waiting for the bridge", async () => {
    const child = openStdoutProcess("session/prompt");
    let release!: () => void;
    child.process.stdin = new WritableStream({ write: () => new Promise<void>(resolve => { release = resolve; }) });
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    const writer = handle.stdin.getWriter();
    const closed = writer.closed.catch(() => undefined);
    const writing = writer.write(encoder.encode("blocked"));
    const rejected = expect(writing).rejects.toThrow("stdin is closed");
    await Promise.resolve();
    child.die();
    await rejected;
    await closed;
    release();
  });

  it.each(["process.exit(0)", "process.kill(process.pid, 'SIGKILL')", "throw new Error('crash')"])("drains real Node child pipes: %s", async ending => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('a'.repeat(262144), () => { process.stderr.write('final diagnostic', () => { " + ending + "; }); });"], { stdio: "pipe" });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => ({
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      exited,
      kill: async () => { child.kill(); },
    }) }).spawn(agent);
    const writer = handle.stdin.getWriter();
    const closed = writer.closed.catch(() => undefined);
    let bytes = 0;
    for await (const chunk of handle.stdout) {
      if (bytes === 0) await new Promise(resolve => setTimeout(resolve, 2_100));
      bytes += chunk.byteLength;
    }
    await exited;
    expect(bytes).toBe(262144);
    let diagnostic = "";
    for await (const chunk of handle.stderr) diagnostic += decoder.decode(chunk);
    expect(diagnostic).toContain("final diagnostic");
    await closed;
  }, 10_000);
  it.each([false, true])("preserves every buffered byte under slow consumption (source closed: %s)", async (closed) => {
    let cancelled = false;
    const child = openStdoutProcess("session/prompt");
    child.process.stdout = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(encoder.encode(`chunk${i}`));
        if (closed) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    child.die();
    const reader = handle.stdout.getReader();
    const received: string[] = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, i === 0 ? 2_100 : 600));
      received.push(decoder.decode((await reader.read()).value));
    }
    expect(received).toEqual(["chunk0", "chunk1", "chunk2", "chunk3", "chunk4"]);
    expect(cancelled).toBe(false);
    if (closed) expect((await reader.read()).done).toBe(true);
    else await expect(reader.read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
  }, 12_000);
  it("delivers what the process wrote, then ends after the exit drain window", async () => {
    const child = openStdoutProcess("session/prompt");
    const handle = await new SandboxSpawner({ spawnDuplexProcess: async () => child.process }).spawn(agent);
    const reader = handle.stdout.getReader();
    child.send({ written: "before exit" });
    child.die();
    const started = Date.now();
    expect(decoder.decode((await reader.read()).value)).toBe('{"written":"before exit"}\n');
    await expect(reader.read()).rejects.toMatchObject({ name: "SandboxAcpTransportError" });
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
      "stdout drain was not confirmed",
    );
    expect(session.isAlive()).toBe(false);
    await session.dispose();
  }, 10_000);
});
