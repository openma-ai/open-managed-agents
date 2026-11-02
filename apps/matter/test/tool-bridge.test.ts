import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretBox, openSqliteMatterDatabase, type MatterDatabase } from "../src/persistence.js";
import {
  type CallStore,
  mcpToolName,
  memoryCallStore,
  NoActiveTurnError,
  OperationCallBridge,
  ToolCallTimeoutError,
} from "../src/tool-bridge.js";

const opened: MatterDatabase[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const stores: Record<string, () => CallStore> = {
  memory: memoryCallStore,
  sqlite: () => {
    const dir = mkdtempSync(join(tmpdir(), "matter-bridge-"));
    const db = openSqliteMatterDatabase({
      filename: join(dir, "m.sqlite"),
      connectionsDir: join(dir, "apps"),
      box: createSecretBox("bridge-secret-key-0001"),
    });
    opened.push(db);
    return db.calls;
  },
};

describe.each(Object.keys(stores))("OperationCallBridge (%s)", (kind) => {
  const bridge = (options: { pickupTimeoutMs?: number; resultTimeoutMs?: number; store?: CallStore } = {}) =>
    new OperationCallBridge({ store: options.store ?? stores[kind]!(), pollMs: 5, ...options });

  /** The Turn side: take the next call of a Session. */
  const takeOne = async (b: OperationCallBridge, sessionId: string, taker = "turn") => {
    for (;;) {
      const [call] = await b.take(sessionId, taker);
      if (call !== undefined) return call;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  it("registers the call from the MCP request and returns the kernel's answer", async () => {
    const b = bridge();
    const call = b.call("s1", "reply", { markdown: "x" });
    const taken = await takeOne(b, "s1");
    expect(taken).toMatchObject({ sessionId: "s1", tool: "reply", input: { markdown: "x" } });
    expect(taken.callId).toMatch(/^mcp_/);
    await b.resolve(taken.callId, { ok: true, result: "done" });
    expect(await call).toEqual({ ok: true, result: "done" });
  });

  it("takes calls once, in registration order, and keeps sessions apart", async () => {
    const store = stores[kind]!();
    const b = bridge({ store });
    const calls = [b.call("s1", "reply", { n: 1 }), b.call("s2", "reply", { n: 2 }), b.call("s1", "reply", { n: 3 })];
    await new Promise((resolve) => setTimeout(resolve, 10));
    const s1 = await b.take("s1", "t1");
    expect(s1.map((c) => c.input)).toEqual([{ n: 1 }, { n: 3 }]);
    expect(await b.take("s1", "t2")).toEqual([]);
    const s2 = await b.take("s2", "t1");
    expect(s2.map((c) => c.input)).toEqual([{ n: 2 }]);
    for (const c of [...s1, ...s2]) await b.resolve(c.callId, { ok: true, result: null });
    await Promise.all(calls);
  });

  it("gives two identical calls different ids", async () => {
    const b = bridge();
    const one = b.call("s1", "reply", {});
    const two = b.call("s1", "reply", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    const taken = await b.take("s1", "t");
    expect(new Set(taken.map((c) => c.callId)).size).toBe(2);
    for (const c of taken) await b.resolve(c.callId, { ok: true, result: c.callId });
    const results = await Promise.all([one, two]);
    expect(results.map((r) => (r.ok ? r.result : null)).sort()).toEqual(taken.map((c) => c.callId).sort());
  });

  it("fails a call no running Turn takes, within the pickup bound", async () => {
    const b = bridge({ pickupTimeoutMs: 30 });
    const started = Date.now();
    await expect(b.call("s1", "reply", {})).rejects.toBeInstanceOf(NoActiveTurnError);
    expect(Date.now() - started).toBeLessThan(1_000);
    // A failed call is gone: a later Turn does not run it.
    expect(await b.take("s1", "t")).toEqual([]);
  });

  it("keeps waiting when a Turn takes the call as the pickup bound passes", async () => {
    const inner = stores[kind]!();
    let takenId: string | undefined;
    // A Turn takes the call just before the MCP side withdraws it.
    const store: CallStore = {
      ...inner,
      withdraw: async (callId) => {
        const [call] = await inner.take("s1", "late-turn");
        takenId = call?.callId;
        return inner.withdraw(callId);
      },
    };
    const b = bridge({ store, pickupTimeoutMs: 0 });
    const call = b.call("s1", "reply", {});
    while (takenId === undefined) await new Promise((resolve) => setTimeout(resolve, 2));
    await b.resolve(takenId, { ok: true, result: "late" });
    expect(await call).toEqual({ ok: true, result: "late" });
  });

  it("times out a taken call the kernel never answers", async () => {
    const b = bridge({ resultTimeoutMs: 30 });
    const call = b.call("s1", "reply", {});
    await takeOne(b, "s1");
    await expect(call).rejects.toBeInstanceOf(ToolCallTimeoutError);
  });

  it("stops waiting when the caller aborts and leaves no call behind", async () => {
    const b = bridge();
    const controller = new AbortController();
    const call = b.call("s1", "reply", {}, controller.signal);
    controller.abort(new Error("client went away"));
    await expect(call).rejects.toThrow("client went away");
    expect(await b.take("s1", "t")).toEqual([]);
  });

  it("lists the tools the connector set, across bridges sharing a store", async () => {
    const store = stores[kind]!();
    const turnSide = bridge({ store });
    const mcpSide = bridge({ store });
    expect(await mcpSide.tools("s1")).toEqual([]);
    const tools = [{ name: "feishu.message.reply", description: "Reply", inputSchema: { type: "object" } }];
    await turnSide.setTools("s1", tools);
    expect(await mcpSide.tools("s1")).toEqual(tools);
  });

  it("runs a call received by one bridge in a Turn run by another", async () => {
    const store = stores[kind]!();
    const turnSide = bridge({ store });
    const mcpSide = bridge({ store });
    const call = mcpSide.call("s1", "reply", { markdown: "hi" });
    const taken = await takeOne(turnSide, "s1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await turnSide.resolve(taken.callId, { ok: true, result: { status: "sent" } });
    expect(await call).toEqual({ ok: true, result: { status: "sent" } });
  });
});

describe("names", () => {
  it("maps OpenMatter tool names to MCP tool names", () => {
    expect(mcpToolName("feishu.message.reply")).toBe("feishu_message_reply");
    expect(mcpToolName("gitlab.mr-note")).toBe("gitlab_mr-note");
  });
});
