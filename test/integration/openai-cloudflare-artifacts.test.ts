// Cloudflare parity with the Node runner's `afterExecution`: once an Agents
// API execution commits its terminal, SessionDO publishes its
// /workspace/outputs through the shared publisher (main RPC → D1 + R2), and
// the artifacts appear in the HTTP list.
//
// It also covers an SSE client that disconnects mid-session: the server must
// tear its stream down cleanly and no unhandled rejection may escape (Vitest
// fails the run on any). The subscriber calls the main app in-process, as a
// workerd request handler sees it. Going through the vitest loopback
// (`exports.default.fetch` / a service binding) instead makes workerd's own
// response pump reject unobserved on any client cancel/abort — reproducible
// with a bare ReadableStream and no OMA code — so that path cannot prove
// anything about this route.
import { registerCoreHarnesses } from "../../apps/agent/src/harness/builtins";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { setCloudflareSandboxForTest } from "../../apps/agent/src/runtime/sandbox";
import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import mainApp from "../../apps/main/src/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureModelCards } from "./_model-cards";

const headers = { Authorization: "Bearer test-key", "OpenAI-Beta": "agents=v1", "Content-Type": "application/json" };
const request = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://localhost/openai/v1${path}`, { ...init, headers: init?.headers ?? headers }));
const json = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  expect(response.ok, `${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
};

/** SDK-shaped sandbox stub backed by an in-memory /workspace. */
const workspace = new Map<string, Uint8Array>();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, success: true });
/** Sandbox SDK 1.0 container: mounts are attached when it starts. */
let container: { incarnation: string; mounts: string[]; marker: string } | null = null;

beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  setCloudflareSandboxForTest({
    describe: async () => ({ running: container !== null, incarnation: container?.incarnation ?? null, mounts: container?.mounts ?? [] }),
    provision: async (input: { incarnation: string; mounts: Array<{ mountPath: string }> }) => {
      if (container !== null) return { incarnation: container.incarnation, started: false, pendingMounts: [] };
      container = { incarnation: input.incarnation, mounts: input.mounts.map(mount => mount.mountPath), marker: input.incarnation };
      return { incarnation: input.incarnation, started: true, pendingMounts: [] };
    },
    exec: async (command: string) => {
      const marker = command.match(/^echo (\S+) > \/tmp\/\.oma-warm$/);
      if (marker && container !== null) container.marker = marker[1]!;
      if (command.startsWith("cat /tmp/.oma-warm")) return ok(container?.marker ?? "");
      if (command.includes("find ./outputs")) {
        const paths = [...workspace.keys()].filter(path => path.startsWith("/workspace/outputs/")).sort();
        return ok(base64(new TextEncoder().encode(paths.map(path => `.${path.slice("/workspace".length)}\0`).join(""))));
      }
      const read = command.match(/^base64 -w0 -- '([^']+)'/);
      if (read) {
        const bytes = workspace.get(read[1]!);
        return bytes ? ok(base64(bytes)) : { stdout: "", stderr: "No such file", exitCode: 1, success: false };
      }
      return ok("");
    },
    readFile: async () => ({ content: "" }),
    writeFile: async () => ({ success: true }),
    mkdir: async () => ({ success: true }),
    setEnvVars: async () => undefined,
    deleteFile: async () => ({ success: true }),
  });
});
afterAll(() => {
  setCloudflareSandboxForTest(undefined);
  registerCoreHarnesses();
});

describe("Cloudflare Agents API automatic artifact publication", () => {
  it("publishes completed-turn outputs to D1/R2 once, survives an SSE disconnect, and deduplicates by path + content", async () => {
    const files: Array<Record<string, Uint8Array>> = [
      { "/workspace/outputs/report.bin": new Uint8Array([0, 1, 127, 255]) },
      // Turn 2 leaves report.bin unchanged and adds notes.txt.
      { "/workspace/outputs/notes.txt": new TextEncoder().encode("CF_ARTIFACT_NOTES") },
      // A changed file at the same path is a new artifact on a later turn.
      { "/workspace/outputs/report.bin": new Uint8Array([2, 3, 128, 254]) },
    ];
    let turns = 0;
    let releaseFirstTurn!: () => void;
    const firstTurnMayFinish = new Promise<void>(resolve => { releaseFirstTurn = resolve; });
    registerHarness("default", () => ({
      async run(ctx) {
        for (const [path, bytes] of Object.entries(files[turns++] ?? {})) workspace.set(path, bytes);
        if (turns === 1) await firstTurnMayFinish;
        ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: `CF_DONE_${turns}` }] });
      },
    }));

    const session = await json<{ id: string }>(await request("/agents/sessions", { method: "POST", body: JSON.stringify({ agent: { model: "claude-sonnet-4-6" }, environment: { type: "openai_hosted" } }) }));
    const path = `/agents/sessions/${session.id}`;

    // Disconnect while the first turn is running. The durable turn must still
    // complete and publish its output after this subscription has gone away.
    const disconnect = new AbortController();
    const streamed: Array<{ type: string }> = [];
    const stream = await mainApp.fetch(new Request(`http://localhost/openai/v1${path}/events`, { headers, signal: disconnect.signal }), env, createExecutionContext());
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        // A disconnect must end the server stream, never reject the read.
        const chunk = await reader.read();
        if (chunk.done) return "closed";
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          for (const line of buffer.slice(0, at).split("\n")) if (line.startsWith("data:")) streamed.push(JSON.parse(line.slice(5)));
          buffer = buffer.slice(at + 2);
        }
      }
    })();

    const send = (text: string) => request(`${path}/events`, { method: "POST", body: JSON.stringify({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] }] }) });
    expect((await send("write report")).status).toBe(202);
    try {
      await expect.poll(() => turns, { timeout: 15_000 }).toBe(1);
      await expect.poll(() => streamed.some(event => event.type === "agent.session.turn.in_progress"), { timeout: 15_000 }).toBe(true);
      disconnect.abort();
      // The server observed the disconnect and closed its side of the stream.
      expect(await reading).toBe("closed");
    } finally {
      disconnect.abort();
      releaseFirstTurn();
    }

    type Artifact = { id: string; path: string; turn_id: string; size_bytes: number };
    const list = async () => (await json<{ data: Artifact[] }>(await request(`${path}/artifacts?limit=100`))).data;
    await expect.poll(async () => (await list()).map(artifact => artifact.path), { timeout: 15_000 }).toEqual(["/workspace/outputs/report.bin"]);
    const [report] = await list();
    const turnsList = await json<{ data: Array<{ id: string; status: string }> }>(await request(`${path}/turns?order=asc&limit=100`));
    expect(turnsList.data).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(report).toMatchObject({ turn_id: turnsList.data[0]!.id, size_bytes: 4 });
    const download = await request(`${path}/artifacts/${report!.id}/content`);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0, 1, 127, 255]));

    expect((await send("add notes")).status).toBe(202);
    await expect.poll(async () => (await list()).map(artifact => artifact.path).sort(), { timeout: 15_000 })
      .toEqual(["/workspace/outputs/notes.txt", "/workspace/outputs/report.bin"]);
    const second = await json<{ data: Array<{ id: string; status: string }> }>(await request(`${path}/turns?order=asc&limit=100`));
    expect(second.data.map(turn => turn.status)).toEqual(["completed", "completed"]);
    const notes = (await list()).find(artifact => artifact.path.endsWith("notes.txt"))!;
    // The second execution's own turn, not the first turn.
    const firstTurnId = turnsList.data[0]!.id;
    expect(new Set(second.data.map(turn => turn.id))).toEqual(new Set([firstTurnId, notes.turn_id]));
    expect(notes.turn_id).not.toBe(firstTurnId);
    expect(new TextDecoder().decode(await (await request(`${path}/artifacts/${notes.id}/content`)).arrayBuffer())).toBe("CF_ARTIFACT_NOTES");

    expect((await send("update report")).status).toBe(202);
    await expect.poll(async () => (await list()).length, { timeout: 15_000 }).toBe(3);
    const changed = (await list()).find(artifact => artifact.path === report!.path && artifact.id !== report!.id)!;
    expect(changed.turn_id).not.toBe(report!.turn_id);
    expect(new Uint8Array(await (await request(`${path}/artifacts/${changed.id}/content`)).arrayBuffer())).toEqual(new Uint8Array([2, 3, 128, 254]));
    // Previously published snapshots remain immutable.
    expect(new Uint8Array(await (await request(`${path}/artifacts/${report!.id}/content`)).arrayBuffer())).toEqual(new Uint8Array([0, 1, 127, 255]));
    expect(turns).toBe(3);
  }, 60_000);
});
