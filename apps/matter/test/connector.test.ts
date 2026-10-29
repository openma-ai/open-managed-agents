import { makeConnectorAgentDriver, OPERATION_CALL_METHOD } from "@openma/matter/agent";
import type { AgentTurnInput, OpenMAEvent } from "@openma/common/agent-contract";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOmaClient,
  createOpenMAConnector,
  isOmaSessionUnavailable,
  memoryCallStore,
  NoActiveTurnError,
  OmaSessionUnavailableError,
  OperationCallBridge,
  SESSION_TITLE_PREFIX,
} from "../src/index.js";
import { FakeOma, type FakeEvent } from "./fake-oma.js";

const SERVER = "matter";
const REPLY_TOOL = {
  name: "feishu.message.reply",
  integrationId: "feishu",
  operation: "message.reply",
  description: "Reply in the conversation",
  inputSchema: { type: "object" },
};

const idle = { type: "session.status_idle", stop_reason: { type: "end_turn" } };
const running = { type: "session.status_running" };
const message = (text: string) => ({
  type: "agent.message",
  id: `msg_${text}`,
  content: [{ type: "text", text }],
});

let oma: FakeOma;
let bridge: OperationCallBridge;

const makeConnector = (extra: { vaultIds?: readonly string[]; bridge?: OperationCallBridge } = {}) =>
  createOpenMAConnector({
    client: createOmaClient({
      baseUrl: "https://oma.test/",
      apiKey: oma.apiKey,
      fetch: oma.fetch as typeof fetch,
    }),
    bridge: extra.bridge ?? bridge,
    environmentId: "env_1",
    ...(extra.vaultIds === undefined
      ? {}
      : { vaultIds: async () => extra.vaultIds! }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

const turn = (
  turnId: string,
  overrides: Partial<AgentTurnInput> = {},
): AgentTurnInput => ({
  sessionId: "matter-session-1",
  turnId,
  afterSequence: 0,
  content: "hello",
  metadata: { openmatter: { tools: [REPLY_TOOL] } },
  ...overrides,
});

const collect = async (events: AsyncIterable<OpenMAEvent>) => {
  const out: OpenMAEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const respondOnMessage = (replies: readonly FakeEvent[]) => {
  oma.responder = (_id, event) =>
    event.type === "user.message" ? replies : undefined;
};

beforeEach(() => {
  oma = new FakeOma();
  bridge = new OperationCallBridge({ pickupTimeoutMs: 2_000, pollMs: 5 });
});

describe("open", () => {
  it("creates one session per idempotency key and reuses it on replay", async () => {
    const connector = makeConnector({ vaultIds: ["vlt_1"] });
    const input = {
      sessionId: "s1",
      idempotencyKey: "key-1",
      generation: 0,
      agentId: "agent-1",
    };
    const first = await connector.open(input);
    const second = await connector.open(input);
    expect(second.externalSessionId).toBe(first.externalSessionId);
    expect(first).toMatchObject({ connectorId: "openma", placement: "managed" });
    const creates = oma.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/sessions",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({
      agent: "agent-1",
      title: `${SESSION_TITLE_PREFIX}key-1`,
      environment_id: "env_1",
      vault_ids: ["vlt_1"],
    });
  });

  it("does not reuse a session whose title only contains the key", async () => {
    oma.createSession(`${SESSION_TITLE_PREFIX}key-1-other`);
    const connector = makeConnector();
    const handle = await connector.open({
      sessionId: "s1",
      idempotencyKey: "key-1",
      generation: 0,
      agentId: "agent-1",
    });
    expect(oma.sessions.get(handle.externalSessionId)?.title).toBe(
      `${SESSION_TITLE_PREFIX}key-1`,
    );
  });

  it("reports a missing or archived session on resume as unavailable", async () => {
    const connector = makeConnector();
    const resume = {
      connectorId: "openma",
      externalSessionId: "sesn_missing",
      placement: "managed" as const,
    };
    const missing = connector
      .open({ sessionId: "s", idempotencyKey: "k", generation: 1, agentId: "a", resume })
      .catch((error: unknown) => error);
    expect(await missing).toBeInstanceOf(OmaSessionUnavailableError);
    expect(isOmaSessionUnavailable(await missing)).toBe(true);

    const id = oma.createSession("archived");
    oma.sessions.get(id)!.archived_at = "2026-01-01T00:00:00Z";
    const archived = await connector
      .open({
        sessionId: "s",
        idempotencyKey: "k",
        generation: 1,
        agentId: "a",
        resume: { ...resume, externalSessionId: id },
      })
      .catch((error: unknown) => error);
    expect(isOmaSessionUnavailable(archived)).toBe(true);
  });
});

describe("execute", () => {
  it("sends one user.message and streams the Turn until its terminal status", async () => {
    const id = oma.createSession("t");
    respondOnMessage([running, message("hi"), idle]);
    const connector = makeConnector();
    const events = await collect(
      connector.execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (const event of events) {
      expect(event.session_id).toBe("matter-session-1");
      expect(event.turn_id).toBe("turn-1");
    }
    expect(oma.sessions.get(id)!.events[0]).toMatchObject({
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
    });
    // The MCP server lists the Turn's tools for this Session.
    expect((await bridge.tools("matter-session-1")).map((tool) => tool.name)).toEqual([
      "feishu.message.reply",
    ]);
  });

  it("ignores events of an earlier Turn already in the log", async () => {
    const id = oma.createSession("t");
    oma.append(id, { type: "user.message", content: [] });
    oma.append(id, message("old"));
    oma.append(id, idle);
    respondOnMessage([message("new"), idle]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-2"),
      ),
    );
    expect(events.map((e) => [e.type, (e.data as { text?: string }).text])).toEqual([
      ["agent.message", "new"],
      ["turn.completed", undefined],
    ]);
  });

  /** Play the kernel: read the Turn, answer each operation call with `answer`. */
  const runAsKernel = async (
    connector: ReturnType<typeof makeConnector>,
    handle: { connectorId: string; externalSessionId: string; placement: "managed" },
    events: AsyncIterable<OpenMAEvent>,
    answer: (callback: OpenMAEvent) => unknown | undefined,
  ) => {
    const out: OpenMAEvent[] = [];
    for await (const event of events) {
      out.push(event);
      if (event.type === "callback.requested") {
        const result = answer(event);
        if (result !== undefined) {
          const callbackId = (event.data as { callback_id: string }).callback_id;
          await connector.send(handle, { type: "callback.respond", callbackId, result: result as never });
        }
      }
    }
    return out;
  };

  /** Like the claude-managed harness: the OpenMA stream stays silent while
   * the MCP call runs; tool_use and tool_result are logged after it returns. */
  const claudeManagedHarness = (
    id: string,
    mcp: OperationCallBridge,
    input: Record<string, unknown>,
  ) => {
    let mcpResult: Promise<unknown> | undefined;
    oma.responder = (_id, event) => {
      if (event.type !== "user.message") return undefined;
      mcpResult = mcp.call("matter-session-1", "feishu_message_reply", input as never).then(
        (outcome) => {
          oma.append(id, {
            type: "agent.tool_use",
            id: "toolu_1",
            name: `mcp__${SERVER}__feishu_message_reply`,
            input,
          });
          oma.append(id, { type: "agent.tool_result", tool_use_id: "toolu_1", content: JSON.stringify(outcome) });
          oma.append(id, idle);
          return outcome;
        },
        (error: unknown) => {
          oma.append(id, idle);
          throw error;
        },
      );
      return [];
    };
    return () => mcpResult;
  };

  it("runs a Matter MCP call while the OpenMA stream is silent (claude-managed ordering)", async () => {
    const id = oma.createSession("t");
    const mcpResult = claudeManagedHarness(id, bridge, { markdown: "done" });
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const events = await runAsKernel(connector, handle, connector.execute(handle, turn("turn-1")), () => ({
      status: "succeeded",
    }));
    const callback = events.find((e) => e.type === "callback.requested")!;
    expect(callback).toMatchObject({
      seq: 1,
      data: {
        method: OPERATION_CALL_METHOD,
        category: "extension",
        params: {
          integrationId: "feishu",
          operation: "message.reply",
          input: { markdown: "done" },
        },
      },
    });
    expect((callback.data as { callback_id: string }).callback_id).toMatch(/^mcp_/);
    expect(typeof (callback.data as { fingerprint?: unknown }).fingerprint).toBe("string");
    expect(await mcpResult()).toEqual({ ok: true, result: { status: "succeeded" } });
    // The callback came before the harness logged the call at all.
    expect(events.map((e) => e.type)).toEqual([
      "callback.requested",
      "tool.started",
      "tool.completed",
      "turn.completed",
    ]);
  });

  it("runs a call received by another replica's bridge sharing the store", async () => {
    const store = memoryCallStore();
    const mcpReplica = new OperationCallBridge({ store, pickupTimeoutMs: 2_000, pollMs: 5 });
    const turnReplica = new OperationCallBridge({ store, pickupTimeoutMs: 2_000, pollMs: 5 });
    const id = oma.createSession("t");
    const mcpResult = claudeManagedHarness(id, mcpReplica, { markdown: "across" });
    const connector = makeConnector({ bridge: turnReplica });
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const events = await runAsKernel(connector, handle, connector.execute(handle, turn("turn-1")), () => ({
      status: "sent",
    }));
    expect(await mcpResult()).toEqual({ ok: true, result: { status: "sent" } });
    expect(events.at(-1)?.type).toBe("turn.completed");
    // The MCP side's tool list came from the Turn side through the store.
    expect((await mcpReplica.tools("matter-session-1")).map((t) => t.name)).toEqual(["feishu.message.reply"]);
  });

  it("fails a call that arrives when no Turn is running, within the bounded wait", async () => {
    const quick = new OperationCallBridge({ pickupTimeoutMs: 50, pollMs: 5 });
    const started = Date.now();
    await expect(quick.call("matter-session-1", "feishu_message_reply", {})).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fails a call the kernel did not answer when the Turn ends", async () => {
    const id = oma.createSession("t");
    let mcpResult: Promise<unknown> | undefined;
    oma.responder = (_id, event) => {
      if (event.type !== "user.message") return undefined;
      mcpResult = bridge.call("matter-session-1", "feishu_message_reply", { markdown: "x" });
      return [];
    };
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const events = await runAsKernel(connector, handle, connector.execute(handle, turn("turn-1")), () => {
      // The kernel does not answer; the Turn ends (for example, cancelled).
      setTimeout(() => oma.append(id, idle), 10);
      return undefined;
    });
    expect(events.map((e) => e.type)).toEqual(["callback.requested", "turn.completed"]);
    expect(await mcpResult).toEqual({
      ok: false,
      error: { message: "The Turn ended before this call was answered" },
    });
  });

  it("fails a call to a tool the Turn does not allow without reporting it", async () => {
    const id = oma.createSession("t");
    let mcpResult: Promise<unknown> | undefined;
    oma.responder = (_id, event) => {
      if (event.type !== "user.message") return undefined;
      mcpResult = bridge.call("matter-session-1", "feishu_message_send", {}).finally(() => oma.append(id, idle));
      return [];
    };
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const events = await runAsKernel(connector, handle, connector.execute(handle, turn("turn-1")), () => null);
    expect(events.some((e) => e.type === "callback.requested")).toBe(false);
    expect(await mcpResult).toEqual({
      ok: false,
      error: { message: "feishu_message_send is not available in this Turn" },
    });
  });

  it("does not treat tool-use events in the OpenMA log as Matter calls", async () => {
    const id = oma.createSession("t");
    respondOnMessage([
      {
        type: "agent.mcp_tool_use",
        id: "toolu_a",
        mcp_server_name: SERVER,
        name: `mcp__${SERVER}__feishu_message_reply`,
        input: {},
      },
      {
        type: "agent.tool_use",
        id: "toolu_c",
        name: "mcp_invoke",
        input: { tool_name: `mcp__${SERVER}__feishu_message_reply`, arguments: {} },
      },
      idle,
    ]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    expect(events.some((e) => e.type === "callback.requested")).toBe(false);
  });

  it("replays a repeated turnId from the log without sending the message again", async () => {
    const id = oma.createSession("t");
    respondOnMessage([running, message("a")]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const first = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();
    const seen = [(await first.next()).value, (await first.next()).value] as OpenMAEvent[];
    await first.return?.(undefined);
    oma.append(id, idle);

    const replay = await collect(connector.execute(handle, turn("turn-1")));
    expect(replay.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(replay.slice(0, 2).map((e) => e.event_id)).toEqual(seen.map((e) => e.event_id));
    expect(replay.at(-1)?.type).toBe("turn.completed");
    const sent = oma.sessions.get(id)!.events.filter((e) => e.type === "user.message");
    expect(sent).toHaveLength(1);
  });

  it("ignores user events echoed on the stream", async () => {
    const id = oma.createSession("t");
    oma.echoUserEvents = true;
    respondOnMessage([message("hi"), idle]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["agent.message", "turn.completed"]);
  });

  it("does not repeat an event that is both listed and streamed", async () => {
    const id = oma.createSession("t");
    respondOnMessage([running]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const first = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();
    await first.next();
    await first.return?.(undefined);
    // Appended after the replay's stream opened and before its list answers.
    oma.onList = (sessionId) => {
      oma.onList = () => undefined;
      oma.append(sessionId, message("both"));
      setTimeout(() => oma.append(sessionId, idle), 0);
    };
    const replay = await collect(connector.execute(handle, turn("turn-1")));
    expect(replay.filter((e) => e.type === "agent.message")).toHaveLength(1);
    expect(replay.at(-1)?.type).toBe("turn.completed");
  });

  it("reads a repeated Turn back across pages of the event list", async () => {
    const id = oma.createSession("t");
    oma.append(id, { type: "user.message", content: [] });
    oma.append(id, message("earlier"));
    oma.append(id, idle);
    const many = Array.from({ length: 150 }, (_, i) => message(`m${i}`));
    respondOnMessage([running, ...many]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const first = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();
    await first.next();
    await first.return?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    oma.append(id, idle);

    const replay = await collect(connector.execute(handle, turn("turn-1")));
    const texts = replay
      .filter((e) => e.type === "agent.message")
      .map((e) => (e.data as { text?: string }).text);
    expect(texts).toEqual(many.map((m) => m.content[0]!.text));
    expect(replay.at(-1)?.type).toBe("turn.completed");
    const pages = oma.requests.filter((r) => r.method === "GET" && r.path.includes("/events?"));
    expect(pages.length).toBeGreaterThan(1);
  });

  it("fails the Turn when the session is terminated", async () => {
    const id = oma.createSession("t");
    respondOnMessage([{ type: "session.status_terminated" }]);
    const result = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(OmaSessionUnavailableError);
  });
});

describe("send and close", () => {
  it("cancels with user.interrupt, steers with user.message and archives on close", async () => {
    const id = oma.createSession("t");
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    await connector.send(handle, { type: "turn.cancel", turnId: "turn-1" });
    await connector.send(handle, { type: "turn.steer", content: "more" });
    expect(oma.sessions.get(id)!.events.map((e) => e.type)).toEqual([
      "user.interrupt",
      "user.message",
    ]);
    await connector.close(handle);
    await connector.close(handle);
    await connector.close({ ...handle, externalSessionId: "sesn_gone" });
    expect(oma.sessions.get(id)!.archived_at).not.toBeNull();
  });
});

describe("kernel driver", () => {
  it("advertises operation calls through makeConnectorAgentDriver", async () => {
    const driver = makeConnectorAgentDriver({
      connector: makeConnector(),
      agentId: "agent-1",
      isSessionUnavailable: isOmaSessionUnavailable,
    });
    const capabilities = await Effect.runPromise(driver.capabilities());
    expect(capabilities).toMatchObject({ operations: true, resume: true, cancel: true });
  });
});
