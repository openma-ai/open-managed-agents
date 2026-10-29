/**
 * Runs an Agent's Matter MCP tool calls as OpenMatter operation calls.
 *
 * The MCP request is the source of the call. Its tool name, its arguments
 * and the bearer (which Matter issued for one OpenMatter Agent Session) are
 * all Matter needs, so Matter does not read the Agent's event log to find
 * calls. Harnesses differ in how and when they log a tool call: some log it
 * only after the call returns, which is too late to correlate with. Tool
 * execution must not depend on any harness's event format or timing.
 *
 * The flow:
 *
 * 1. The MCP request registers the call in the `CallStore` under a call id it
 *    generates, and waits.
 * 2. The connector running that Session's Turn watches the store and takes
 *    the Session's new calls. It does this alongside reading the harness's
 *    event stream, because a harness may emit nothing while it waits on the
 *    tool. It reports each call to the kernel as a `callback.requested`
 *    operation call.
 * 3. The kernel's answer resolves the call, and the MCP request returns it.
 *
 * Bounds: when no Turn takes a call within `pickupTimeoutMs` (the Session
 * has no running Turn on any replica), the call fails. A Turn takes calls
 * within one poll interval, so the bound only has to cover polling and
 * database latency. A taken call waits up to `resultTimeoutMs` for the
 * kernel's answer. When a Turn ends, every call it took but did not answer
 * fails.
 *
 * Determinism: the connector reports calls in the order they were
 * registered in the store, interleaved with the harness's events in the
 * order they reach the connector. The callback positions in the Agent event
 * stream therefore follow arrival time, not a position in the harness's
 * log, and a replayed Turn does not reproduce callbacks it already reported.
 * We accept that tradeoff so the call can run while the harness waits on it.
 *
 * The store is shared by all replicas (the Matter database): the MCP
 * request may reach a different replica than the one running the Turn.
 */

import { randomUUID } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** An MCP tool name for an OpenMatter tool name (`feishu.message.reply` →
 * `feishu_message_reply`). MCP tool names allow only `[A-Za-z0-9_-]`. */
export const mcpToolName = (toolName: string): string =>
  toolName.replace(/[^A-Za-z0-9_-]/g, "_");

/** A tool call that ended without an answer from the kernel. */
export class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

/** No running Turn of the Session took the call. */
export class NoActiveTurnError extends ToolCallError {
  constructor(toolName: string) {
    super(
      `${toolName} was not run: this Session has no running Turn to run it in`,
    );
    this.name = "NoActiveTurnError";
  }
}

/** A Turn took the call, but the kernel did not answer in time. */
export class ToolCallTimeoutError extends ToolCallError {
  constructor(toolName: string) {
    super(`${toolName} got no answer in time; its outcome is unknown`);
    this.name = "ToolCallTimeoutError";
  }
}

export type ToolCallOutcome =
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: JsonValue };

/** A registered call, as the Turn side reads it. */
export interface StoredCall {
  readonly callId: string;
  readonly sessionId: string;
  /** MCP tool name. */
  readonly tool: string;
  readonly input: JsonValue;
  readonly createdAtMs: number;
}

export type CallState =
  /** Not registered, or forgotten. */
  | { readonly state: "missing" }
  | { readonly state: "waiting" }
  | { readonly state: "taken" }
  | { readonly state: "answered"; readonly outcome: unknown };

/** Shared state behind the bridge. */
export interface CallStore {
  setTools(sessionId: string, toolsJson: string): Promise<void>;
  tools(sessionId: string): Promise<string | undefined>;
  /** Record a new call. Registration order is the order `take` returns. */
  register(call: StoredCall): Promise<void>;
  /** Atomically take the Session's calls no Turn took yet, oldest first. */
  take(sessionId: string, taker: string): Promise<readonly StoredCall[]>;
  state(callId: string): Promise<CallState>;
  /** First answer wins. */
  resolve(callId: string, outcome: unknown): Promise<void>;
  /** Remove a call no Turn took. True when it was removed; false when a
   * Turn took it first (or it is gone). */
  withdraw(callId: string): Promise<boolean>;
  /** Remove a call after its answer was delivered. */
  forget(callId: string): Promise<void>;
}

/** A `CallStore` in process memory, for a single process and tests. */
export const memoryCallStore = (): CallStore => {
  const tools = new Map<string, string>();
  interface Row {
    readonly call: StoredCall;
    takenBy?: string;
    outcome?: unknown;
  }
  // Insertion order is registration order.
  const rows = new Map<string, Row>();
  return {
    setTools: async (sessionId, json) => void tools.set(sessionId, json),
    tools: async (sessionId) => tools.get(sessionId),
    register: async (call) => {
      if (!rows.has(call.callId)) rows.set(call.callId, { call });
    },
    take: async (sessionId, taker) => {
      const taken: StoredCall[] = [];
      for (const row of rows.values()) {
        if (row.call.sessionId === sessionId && row.takenBy === undefined) {
          row.takenBy = taker;
          taken.push(row.call);
        }
      }
      return taken;
    },
    state: async (callId) => {
      const row = rows.get(callId);
      if (row === undefined) return { state: "missing" };
      if (row.outcome !== undefined) return { state: "answered", outcome: row.outcome };
      return { state: row.takenBy === undefined ? "waiting" : "taken" };
    },
    resolve: async (callId, outcome) => {
      const row = rows.get(callId);
      if (row !== undefined && row.outcome === undefined) row.outcome = outcome;
    },
    withdraw: async (callId) => {
      const row = rows.get(callId);
      if (row === undefined || row.takenBy !== undefined) return false;
      rows.delete(callId);
      return true;
    },
    forget: async (callId) => void rows.delete(callId),
  };
};

export interface OperationCallBridgeOptions {
  /** Defaults to `memoryCallStore()`: a single process. */
  readonly store?: CallStore;
  /** How long a call waits for a running Turn to take it (default 15 s).
   * A running Turn takes it within one `pollMs`; the rest is slack for
   * database latency across replicas. */
  readonly pickupTimeoutMs?: number;
  /** How long a taken call waits for the kernel's answer (default 10 min). */
  readonly resultTimeoutMs?: number;
  /** Polling interval of both sides (default 200 ms). */
  readonly pollMs?: number;
}

/** An OpenMatter tool as the Matter MCP server lists it. */
export interface BridgeTool {
  /** OpenMatter tool name, `${integrationId}.${operation}`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Tool call aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Tool call aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

let takers = 0;

export class OperationCallBridge {
  private readonly store: CallStore;
  private readonly pickupTimeoutMs: number;
  private readonly resultTimeoutMs: number;
  private readonly pollMs: number;
  /** Wakes a waiter early when this process wrote what it waits for. */
  private readonly wakers = new Set<() => void>();

  constructor(options: OperationCallBridgeOptions = {}) {
    this.store = options.store ?? memoryCallStore();
    this.pickupTimeoutMs = options.pickupTimeoutMs ?? 15_000;
    this.resultTimeoutMs = options.resultTimeoutMs ?? 600_000;
    this.pollMs = options.pollMs ?? 200;
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /** Waits `pollMs`, or less when this process changed the store. */
  async pause(signal?: AbortSignal): Promise<void> {
    const local = new AbortController();
    const waker = () => local.abort();
    this.wakers.add(waker);
    const onAbort = () => local.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await sleep(this.pollMs, local.signal).catch(() => undefined);
    } finally {
      this.wakers.delete(waker);
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Tool call aborted");
  }

  /** Connector side: the tools the latest Turn of a Session allows. Set
   * before the Turn's message is sent, so the Agent lists them. */
  async setTools(sessionId: string, tools: readonly BridgeTool[]): Promise<void> {
    await this.store.setTools(sessionId, JSON.stringify(tools));
  }

  /** MCP side: the tools to list for a Session. */
  async tools(sessionId: string): Promise<readonly BridgeTool[]> {
    const json = await this.store.tools(sessionId);
    return json === undefined ? [] : (JSON.parse(json) as BridgeTool[]);
  }

  /** Connector side: a new taker id for one running Turn. */
  newTaker(): string {
    return `${process.pid}:${++takers}:${randomUUID()}`;
  }

  /** Connector side: take the Session's new calls, in registration order. */
  async take(sessionId: string, taker: string): Promise<readonly StoredCall[]> {
    return this.store.take(sessionId, taker);
  }

  /** Connector side: answer a call (the kernel's answer, or a failure). */
  async resolve(callId: string, outcome: ToolCallOutcome): Promise<void> {
    await this.store.resolve(callId, outcome);
    this.wake();
  }

  /** MCP side: register the call and wait for its answer. */
  async call(
    sessionId: string,
    toolName: string,
    input: JsonValue,
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const callId = `mcp_${randomUUID()}`;
    await this.store.register({
      callId,
      sessionId,
      tool: toolName,
      input,
      createdAtMs: Date.now(),
    });
    this.wake();
    const pickupBy = Date.now() + this.pickupTimeoutMs;
    let answerBy: number | undefined;
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error("Tool call aborted");
        const current = await this.store.state(callId);
        if (current.state === "answered") return current.outcome as ToolCallOutcome;
        if (current.state === "missing") throw new NoActiveTurnError(toolName);
        if (current.state === "waiting" && Date.now() >= pickupBy) {
          // A Turn may take it at this moment; withdrawing settles the race.
          if (await this.store.withdraw(callId)) throw new NoActiveTurnError(toolName);
          continue;
        }
        if (current.state === "taken") {
          answerBy ??= Date.now() + this.resultTimeoutMs;
          if (Date.now() >= answerBy) throw new ToolCallTimeoutError(toolName);
        }
        await this.pause(signal);
      }
    } finally {
      await this.store.forget(callId).catch(() => undefined);
    }
  }
}
