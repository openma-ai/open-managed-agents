import { describe, expect, it } from "vitest";
import type { ClientCallbacks } from "@openma/common/acp-runtime";
import type { ManagedRuntimeEventWire } from "@openma/common/managed-runtime";
import { createWorkPermissionBridge } from "../src/work-permission-bridge.js";

const scope = {
  workspaceId: "workspace-1", environmentId: "env-1", sessionId: "session-1",
  workId: "work-1", generation: 4, holder: "holder-1",
};
type Request = Parameters<NonNullable<ClientCallbacks["requestPermission"]>>[0];
const request = (id = "native-tool-1"): Request => ({
  sessionId: "native-session-1",
  toolCall: { toolCallId: id, title: "Run command", kind: "execute", rawInput: { command: "pwd" } },
  options: [
    { optionId: "always", kind: "allow_always", name: "Always" },
    { optionId: "yes", kind: "allow_once", name: "Allow" },
    { optionId: "no", kind: "reject_once", name: "Deny" },
  ],
});
const cancelled = { outcome: { outcome: "cancelled" } };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture(overrides: Partial<Parameters<typeof createWorkPermissionBridge>[0]> = {}) {
  const batches: ManagedRuntimeEventWire[][] = [];
  const consumed: unknown[] = [];
  const controller = new AbortController();
  let id = 0;
  const bridge = createWorkPermissionBridge({
    scope, turnId: "original-prompt", acpSessionId: "native-session-1",
    signal: controller.signal,
    nextEventId: () => `event-${++id}`,
    now: () => new Date("2026-11-10T00:00:00Z"),
    publish: async ({ events }) => { batches.push(structuredClone(events)); },
    consume: async (input) => { consumed.push(input); },
    ...overrides,
  });
  const document = (toolUseId: string, result = "allow", id = "answer-1") => JSON.stringify({
    id, type: "user.tool_confirmation", toolUseId, result, processedAt: null,
    source_position: { revision: 8, index: 0 },
  });
  return { bridge, batches, consumed, controller, document };
}

describe("Work ACP permission bridge", () => {
  it("publishes ask + requires_action before accepting a canonical confirmation on the original callback", async () => {
    const f = fixture();
    const callback: NonNullable<ClientCallbacks["requestPermission"]> = f.bridge.requestPermission;
    let settled = false;
    const response = callback(request()).then(value => { settled = true; return value; });
    await tick();
    expect(settled).toBe(false);
    expect(f.batches).toEqual([[
      { id: "event-1", type: "agent.tool_use", processed_at: "2026-11-10T00:00:00.000Z", name: "Run command", input: { command: "pwd" }, evaluated_permission: "ask" },
      { id: "event-2", type: "session.status_idle", processed_at: "2026-11-10T00:00:00.000Z", stop_reason: { type: "requires_action", event_ids: ["event-1"] } },
    ]]);
    const document = f.document("event-1");
    expect(await f.bridge.confirm({ scope, document })).toBe("answered");
    expect(await response).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    // SqlWorkInputs.consume requires decoded.executionId ?? inputId, not the
    // ACP prompt id. SessionEventsApplicationService writes confirmation
    // processedAt:null; SqlSessionEventStore.append omits execution_id.
    expect(f.consumed).toEqual([{ inputId: "answer-1", turnId: "answer-1", expectedDocument: document, signal: expect.any(AbortSignal) }]);
    expect(f.batches[1]).toEqual([{ id: "event-3", type: "session.status_running", processed_at: "2026-11-10T00:00:00.000Z" }]);
    expect(f.bridge.toolUseIdFor("native-tool-1")).toBe("event-1");
  });

  it("keeps independent callbacks and the remaining requires_action IDs when answers arrive out of order", async () => {
    const f = fixture();
    const first = f.bridge.requestPermission(request("a"));
    const second = f.bridge.requestPermission(request("b"));
    await tick();
    const a = f.bridge.toolUseIdFor("a")!;
    const b = f.bridge.toolUseIdFor("b")!;
    expect(a).not.toBe(b);
    expect(f.batches[1]?.at(-1)?.stop_reason).toEqual({ type: "requires_action", event_ids: [a, b] });
    expect(await f.bridge.confirm({ scope, document: f.document(b, "deny", "deny-b") })).toBe("answered");
    expect(await second).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(f.batches.at(-1)?.at(-1)?.stop_reason).toEqual({ type: "requires_action", event_ids: [a] });
    expect(await f.bridge.confirm({ scope, document: f.document(a) })).toBe("answered");
    expect(await first).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });
});

it.each(["workspaceId", "environmentId", "sessionId", "workId", "generation", "holder"] as const)("rejects a confirmation from another %s", async key => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  await tick();
  const wrongScope = { ...scope, [key]: key === "generation" ? 5 : "other" };
  expect(await f.bridge.confirm({ scope: wrongScope, document: f.document("event-1") })).toBe("rejected");
  expect(f.consumed).toEqual([]);
  f.bridge.close();
  expect(await response).toEqual(cancelled);
});

it.each([
  "not json", "null", "[]", "{}",
  JSON.stringify({ id: "x", type: "user.message", toolUseId: "event-1", result: "allow" }),
  JSON.stringify({ id: "x", type: "user.tool_confirmation", tool_use_id: "event-1", result: "allow", processedAt: null, source_position: { revision: 8, index: 0 } }),
])("rejects malformed or non-canonical input without dispatch", async document => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  await tick();
  expect(await f.bridge.confirm({ scope, document })).toBe("rejected");
  expect(f.consumed).toEqual([]);
  f.bridge.close();
  expect(await response).toEqual(cancelled);
});

it.each([
  { result: "yes" }, { toolUseId: "other" }, { id: "" }, { processedAt: "2026-11-10" },
  { source_position: { revision: 0, index: 0 } }, { source_position: { revision: 8, index: -1 } },
])("rejects invalid confirmation fields %j", async patch => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  await tick();
  const document = JSON.stringify({ ...JSON.parse(f.document("event-1")), ...patch });
  expect(await f.bridge.confirm({ scope, document })).toBe("rejected");
  expect(f.consumed).toEqual([]);
  f.bridge.close();
  expect(await response).toEqual(cancelled);
});

it("consumes and answers a confirmation at most once, even concurrently or with a new answer id", async () => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  await tick();
  const input = { scope, document: f.document("event-1") };
  expect(await Promise.all([f.bridge.confirm(input), f.bridge.confirm(input)])).toEqual(["answered", "rejected"]);
  expect(await response).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  expect(await f.bridge.confirm({ scope, document: f.document("event-1", "deny", "another") })).toBe("rejected");
  expect(f.consumed).toHaveLength(1);
});

it("does not reuse one answer id across different pending tools", async () => {
  const f = fixture();
  const a = f.bridge.requestPermission(request("a"));
  const b = f.bridge.requestPermission(request("b"));
  await tick();
  await f.bridge.confirm({ scope, document: f.document(f.bridge.toolUseIdFor("a")!) });
  expect(await f.bridge.confirm({ scope, document: f.document(f.bridge.toolUseIdFor("b")!) })).toBe("rejected");
  expect(await a).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  f.bridge.close();
  expect(await b).toEqual(cancelled);
});

it.each(["close", "abort"])("cancels all waits on %s and rejects late answers and requests", async reason => {
  const f = fixture();
  const a = f.bridge.requestPermission(request("a"));
  const b = f.bridge.requestPermission(request("b"));
  await tick();
  if (reason === "close") f.bridge.close(); else f.controller.abort();
  expect(await Promise.all([a, b])).toEqual([cancelled, cancelled]);
  expect(await f.bridge.confirm({ scope, document: f.document(f.bridge.toolUseIdFor("a")!) })).toBe("rejected");
  expect(await f.bridge.requestPermission(request("c"))).toEqual(cancelled);
  expect(f.consumed).toEqual([]);
});

it("never publishes a request when the Work is already aborted", async () => {
  const f = fixture({ signal: AbortSignal.abort() });
  expect(await f.bridge.requestPermission(request())).toEqual(cancelled);
  expect(f.batches).toEqual([]);
});

it.each([
  { sessionId: "different-native-session" },
  { toolCall: { toolCallId: "" } },
  { options: [{ optionId: "same", kind: "allow_once" }, { optionId: "same", kind: "reject_once" }] },
  { options: [{ optionId: "", kind: "allow_once" }] },
  { options: [] },
])("fails closed on malformed ACP correlation/options %j", async patch => {
  const f = fixture();
  expect(await f.bridge.requestPermission({ ...request(), ...patch } as Request)).toEqual(cancelled);
  expect(f.batches).toEqual([]);
});

it.each(["allow", "deny"])("does not escalate a one-time %s to an always option", async result => {
  const f = fixture();
  const response = f.bridge.requestPermission({ ...request(), options: [
    { optionId: "always-yes", kind: "allow_always", name: "Always" },
    { optionId: "always-no", kind: "reject_always", name: "Never" },
  ] });
  await tick();
  expect(await f.bridge.confirm({ scope, document: f.document("event-1", result) })).toBe("answered");
  expect(await response).toEqual(cancelled);
});

it("fails closed on duplicate ACP tool ids instead of merging unrelated callbacks", async () => {
  const f = fixture();
  const a = f.bridge.requestPermission(request());
  const b = f.bridge.requestPermission(request());
  expect(await Promise.all([a, b])).toEqual([cancelled, cancelled]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("does not reply until both ask publication and fenced consumption have completed", async () => {
  const publication = deferred();
  const consumption = deferred();
  const f = fixture({ publish: async () => publication.promise, consume: async () => consumption.promise });
  let settled = false;
  const response = f.bridge.requestPermission(request()).then(value => { settled = true; return value; });
  const answer = f.bridge.confirm({ scope, document: f.document("event-1") });
  await tick();
  expect(settled).toBe(false);
  publication.resolve();
  await tick();
  expect(settled).toBe(false);
  consumption.resolve();
  expect(await answer).toBe("answered");
  expect(await response).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
});

it.each(["publish", "consume"] as const)("cancels all requests on %s failure without retrying or surfacing secrets", async operation => {
  let calls = 0;
  const f = fixture({ [operation]: async () => { calls++; throw new Error("secret-sentinel"); } });
  const response = f.bridge.requestPermission(request());
  await tick();
  expect(await f.bridge.confirm({ scope, document: f.document("event-1") })).toBe("rejected");
  expect(await response).toEqual(cancelled);
  expect(calls).toBe(1);
  expect(await f.bridge.requestPermission(request("later"))).toEqual(cancelled);
});

it.each(["publish", "consume"] as const)("cancels promptly during a stuck %s, and late success cannot grant", async operation => {
  const gate = deferred();
  const f = fixture({ [operation]: async () => gate.promise });
  const response = f.bridge.requestPermission(request());
  const answer = f.bridge.confirm({ scope, document: f.document("event-1") });
  await tick();
  f.controller.abort();
  expect(await response).toEqual(cancelled);
  expect(await answer).toBe("rejected");
  gate.resolve();
  await tick();
  expect(f.batches.flat().filter(event => event.type === "session.status_running")).toEqual([]);
});

it("cancels rather than approving if publishing resumed status fails after consumption", async () => {
  let calls = 0;
  const f = fixture({ publish: async () => { if (++calls === 2) throw new Error("lost claim"); } });
  const response = f.bridge.requestPermission(request());
  await tick();
  expect(await f.bridge.confirm({ scope, document: f.document("event-1") })).toBe("rejected");
  expect(await response).toEqual(cancelled);
  expect(f.consumed).toHaveLength(1);
});

it("snapshots request options, tool input and claim instead of trusting later caller mutations", async () => {
  const claim = { ...scope };
  const f = fixture({ scope: claim });
  const req = request();
  const response = f.bridge.requestPermission(req);
  req.options[1].optionId = "always";
  (req.toolCall.rawInput as Record<string, unknown>).command = "changed";
  claim.holder = "other";
  await tick();
  expect(f.batches[0][0].input).toEqual({ command: "pwd" });
  expect(await f.bridge.confirm({ scope, document: f.document("event-1") })).toBe("answered");
  expect(await response).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
});

it("cancels the answering callback while resumed-status publication is stuck", async () => {
  const gate = deferred();
  let calls = 0;
  const f = fixture({ publish: async () => { if (++calls === 2) await gate.promise; } });
  const response = f.bridge.requestPermission(request());
  const answer = f.bridge.confirm({ scope, document: f.document("event-1") });
  await tick();
  f.controller.abort();
  const result = await Promise.race([response, Promise.resolve("still pending")]);
  expect(result).toEqual(cancelled);
  expect(await answer).toBe("rejected");
  gate.resolve();
});

it.each(["empty", "duplicate"])("rejects %s canonical event identities without leaving a waiting callback", async kind => {
  const f = fixture({ nextEventId: () => kind === "empty" ? "" : "same" });
  expect(await f.bridge.requestPermission(request())).toEqual(cancelled);
  expect(f.batches).toEqual([]);
});

it.each([
  { generation: 0 }, { generation: 1.5 }, { holder: "" }, { workId: "" },
  { sessionId: "" }, { environmentId: "" }, { workspaceId: "" },
])("refuses an invalid owner at construction %j", async patch => {
  expect(() => fixture({ scope: { ...scope, ...patch } })).toThrow("Invalid Work permission scope");
});

it.each([{ result: ["allow"] }, { sessionThreadId: "child-thread" }])("rejects nonliteral decisions and nonprimary lanes %j", async patch => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  await tick();
  expect(await f.bridge.confirm({ scope, document: JSON.stringify({ ...JSON.parse(f.document("event-1")), ...patch }) })).toBe("rejected");
  expect(f.consumed).toEqual([]);
  f.bridge.close();
  expect(await response).toEqual(cancelled);
});

it.each(["rpc-permission-17", 17])("bridges published common's actual JSON-RPC callback %s without another prompt or killing the resident peer", async callbackId => {
  const { AcpRuntimeImpl } = await import("@openma/common/acp-runtime");
  const published = deferred();
  const f = fixture({ publish: async () => { published.resolve(); } });
  const outbound: Record<string, any>[] = [];
  let send!: (value: object) => void;
  let promptId: unknown;
  let killCount = 0;
  const exited = deferred();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const runtime = new AcpRuntimeImpl({
    async spawn() {
      return {
        stdout: new ReadableStream<Uint8Array>({ start(controller) {
          send = value => controller.enqueue(encoder.encode(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"));
        } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        stdin: new WritableStream<Uint8Array>({ write(bytes) {
          buffer += decoder.decode(bytes, { stream: true });
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n");
            const message = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            outbound.push(message);
            if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
            else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "native-session-1" } });
            else if (message.method === "session/prompt") {
              promptId = message.id;
              send({ id: callbackId, method: "session/request_permission", params: request() });
            } else if (message.id === callbackId && message.result) {
              send({ id: promptId, result: { stopReason: "end_turn" } });
            }
          }
        } }),
        async kill() { killCount++; exited.resolve(); },
        exited: exited.promise.then(() => ({ code: 0, signal: null })),
      };
    },
  });
  const session = await runtime.start({ agent: { command: "in-memory-test-peer" }, clientCallbacks: { requestPermission: f.bridge.requestPermission } });
  try {
    const prompt = (async () => { for await (const _event of session.prompt("original task")) { /* drain original stream */ } })();
    await published.promise;
    expect(outbound.filter(message => message.id === callbackId && message.result)).toEqual([]);
    expect(session.isAlive()).toBe(true);
    expect(killCount).toBe(0);
    expect(await f.bridge.confirm({ scope, document: f.document("event-1") })).toBe("answered");
    await prompt;
    expect(outbound.filter(message => message.id === callbackId && message.result)).toEqual([
      { jsonrpc: "2.0", id: callbackId, result: { outcome: { outcome: "selected", optionId: "yes" } } },
    ]);
    expect(outbound.filter(message => message.method === "session/prompt")).toHaveLength(1);
    expect(outbound.filter(message => message.method === "session/cancel")).toHaveLength(0);
    expect(killCount).toBe(0);
  } finally {
    f.bridge.close();
    await session.dispose();
  }
});


it("uses canonical execution_id for consumption without changing the original ACP reply", async () => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  const raw = JSON.parse(f.document("event-1"));
  const document = JSON.stringify({ ...raw, source_position: { ...raw.source_position, execution_id: "accepted-batch" } });
  expect(await f.bridge.confirm({ scope, document })).toBe("answered");
  expect(f.consumed).toEqual([{ inputId: "answer-1", turnId: "accepted-batch", expectedDocument: document, signal: expect.any(AbortSignal) }]);
  expect(await response).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
});

it.each([
  { execution_id: "" }, { execution_id: 17 }, { execution_id: null },
  { consumed_by_execution_id: "answer-1" },
])("does not consume malformed or already-consumed identity metadata %j", async patch => {
  const f = fixture();
  const response = f.bridge.requestPermission(request());
  const raw = JSON.parse(f.document("event-1"));
  const document = JSON.stringify({ ...raw, source_position: { ...raw.source_position, ...patch } });
  expect(await f.bridge.confirm({ scope, document })).toBe("rejected");
  expect(f.consumed).toEqual([]);
  f.bridge.close();
  expect(await response).toEqual(cancelled);
});
