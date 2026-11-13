// Session acp-sandbox resource guidance ingress.
//
// Evidence level: the real AcpSandboxHarness talks JSON-RPC to a DETERMINISTIC
// ACP child fixture (no inference). The fixture knows only the session/prompt
// text it receives and acts on it with REAL local filesystem reads (sandbox
// `/mnt` remapped to a temp dir). The system prompt is composed the way the
// Session hosts compose it: composeSystemPrompt(raw, sessionResourceReminders
// (facts, { outputsGuidedByPlatform: true })). Host builders themselves are
// owned/tested by core-host; this pins the harness ingress on first turn and
// on recovery after an owner restart.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AcpSandboxHarness } from "../src/acp-sandbox-loop";
import type { HarnessContext } from "../src/interface";
import { composeSystemPrompt } from "../src/platform-guidance";
// agent-harness has no package dependency on the contract (no lockfile change
// allowed); the contract module is import-free, so load its source directly.
import {
  sessionMemoryResourceFact,
  sessionResourceFacts,
  sessionResourceReminders,
} from "../../runtime-resource-contract/src/index";

interface Observation { prompt: string; memory?: string; mode?: string }

let sandboxCount = 0;

function guidanceDrivenSandbox(mnt: string, files: Map<string, string>, observed: Observation[]) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sessions = new Set<string>();
  // Native session ids are unique per sandbox: a replacement sandbox never
  // knows (or coincidentally reissues) its predecessor's session.
  const sandboxNumber = ++sandboxCount;
  async function act(prompt: string): Promise<Observation> {
    const observation: Observation = { prompt };
    const memory = /## Memory store: notes\nMounted at (\/mnt\/\S+?)\/ \((read-only|read-write)\)/u.exec(prompt);
    if (memory) {
      observation.mode = memory[2];
      observation.memory = await readFile(join(mnt, memory[1]!.slice("/mnt".length), "facts.md"), "utf8");
    }
    return observation;
  }
  return {
    exec: async () => "",
    readFile: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("absent");
      return value;
    },
    writeFile: async (path: string, content: string) => { files.set(path, content); return path; },
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
          async write(chunk) {
            buffered += decoder.decode(chunk);
            let index: number;
            while ((index = buffered.indexOf("\n")) >= 0) {
              const request = JSON.parse(buffered.slice(0, index)) as { id?: number; method: string; params?: any };
              buffered = buffered.slice(index + 1);
              const result = (value: unknown) => send({ jsonrpc: "2.0", id: request.id, result: value });
              if (request.method === "initialize") result({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
              else if (request.method === "session/load" && sessions.has(request.params.sessionId)) result({});
              else if (request.method === "session/new") {
                const id = `native-${sandboxNumber}-${sessions.size + 1}`;
                sessions.add(id);
                result({ sessionId: id });
              } else if (request.method === "session/prompt") {
                const text = (request.params.prompt as Array<{ type: string; text?: string }>)
                  .map((block) => block.text ?? "").join("");
                const observation = await act(text);
                observed.push(observation);
                send({ jsonrpc: "2.0", method: "session/update", params: {
                  sessionId: request.params.sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `memory=${observation.memory ?? "unknown"}` } },
                } });
                result({ stopReason: "end_turn" });
              } else if (request.id !== undefined) {
                send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
              }
            }
          },
        }),
        exited,
        async kill() { try { output.close(); } catch { /* closed */ } exit({ code: 0, signal: null }); },
      };
    },
  };
}

function runtimeFor(sandbox: unknown, history: Array<Record<string, unknown>>) {
  return {
    sandbox,
    history: { getEvents: () => history },
    broadcast: (event: Record<string, unknown>) => { history.push(event); },
    broadcastStreamStart: async () => {}, broadcastStreamEnd: async () => {},
    broadcastChunk: async (_id: string, text: string) => { history.push({ type: "chunk", text }); },
    broadcastThinkingStart: async () => {}, broadcastThinkingChunk: async () => {}, broadcastThinkingEnd: async () => {},
  };
}

function hostSystemPrompt(access: "read_only" | "read_write"): string {
  const facts = sessionResourceFacts({
    memoryStores: [sessionMemoryResourceFact({ storeId: "memstore_notes", storeName: "notes", access })],
    outputs: { path: "/mnt/session/outputs" },
  });
  return composeSystemPrompt("Agent system prompt.", sessionResourceReminders(facts, { outputsGuidedByPlatform: true }));
}

async function turn(harness: AcpSandboxHarness, runtime: ReturnType<typeof runtimeFor>, systemPrompt: string, text: string) {
  const userMessage = { type: "user.message", id: `user-${text}`, content: [{ type: "text", text }] };
  runtime.history.getEvents().push(userMessage);
  await harness.run({
    agent: { model: "deepseek-flash", acp: { agent: { id: "fixture-acp", command: "fixture-acp", cwd: "/workspace" } } },
    session_id: "session_guidance",
    userMessage,
    systemPrompt,
    env: { ANTHROPIC_API_KEY: "" },
    runtime,
  } as unknown as HarnessContext);
}

describe("AcpSandboxHarness resource guidance ingress (deterministic ACP child, real local fs)", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("delivers host resource guidance on the first turn, not again on a live resumed turn, and again on recovery after owner restart", async () => {
    const mnt = await mkdtemp(join(tmpdir(), "openma-acp-guidance-"));
    roots.push(mnt);
    await mkdir(join(mnt, "memory/notes"), { recursive: true });
    await writeFile(join(mnt, "memory/notes/facts.md"), "persisted-bytes-✓\n");
    const systemPrompt = hostSystemPrompt("read_only");
    const files = new Map<string, string>();
    const observed: Observation[] = [];
    const history: Array<Record<string, unknown>> = [];

    const owner1 = new AcpSandboxHarness();
    const runtime1 = runtimeFor(guidanceDrivenSandbox(mnt, files, observed), history);
    try {
      await turn(owner1, runtime1, systemPrompt, "first");
      await turn(owner1, runtime1, systemPrompt, "second");
    } finally {
      await owner1.dispose("destroy");
    }
    expect(observed).toHaveLength(2);
    expect(observed[0]!.prompt.startsWith(`<openma-platform>\n${systemPrompt}\n</openma-platform>\n\nfirst`)).toBe(true);
    expect(observed[0]!.mode).toBe("read-only");
    expect(observed[0]!.memory).toBe("persisted-bytes-✓\n");
    // Native session loaded from the checkpoint: the agent still holds the
    // guidance, so the platform block is not repeated.
    expect(observed[1]!.prompt).toBe("second");

    // Owner restart onto a replacement sandbox: native state is gone, so the
    // harness rebuilds from canonical history and must re-send guidance.
    const owner2 = new AcpSandboxHarness();
    const runtime2 = runtimeFor(guidanceDrivenSandbox(mnt, new Map(), observed), history);
    try {
      await turn(owner2, runtime2, systemPrompt, "third");
    } finally {
      await owner2.dispose("destroy");
    }
    expect(observed).toHaveLength(3);
    expect(observed[2]!.prompt.startsWith(`<openma-platform>\n${systemPrompt}\n</openma-platform>\n\n`)).toBe(true);
    expect(observed[2]!.prompt).toMatch(/<openma-recovery version="1" reason="[a-z-]+">[\s\S]*User: first[\s\S]*User: second[\s\S]*Current request:\nthird\n<\/openma-recovery>$/u);
    expect(observed[2]!.memory).toBe("persisted-bytes-✓\n");
    expect(history.filter((event) => event.type === "session.error")).toEqual([]);
  });

  it("negative control: an empty host system prompt sends no platform block, so the agent cannot locate Memory", async () => {
    const mnt = await mkdtemp(join(tmpdir(), "openma-acp-guidance-neg-"));
    roots.push(mnt);
    const observed: Observation[] = [];
    const harness = new AcpSandboxHarness();
    const runtime = runtimeFor(guidanceDrivenSandbox(mnt, new Map(), observed), []);
    try {
      await turn(harness, runtime, "", "first");
    } finally {
      await harness.dispose("destroy");
    }
    expect(observed[0]!.prompt).toBe("first");
    expect(observed[0]!.memory).toBeUndefined();
  });
});
