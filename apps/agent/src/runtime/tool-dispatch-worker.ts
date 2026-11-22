import {
  buildTools,
  delegationCredentials,
  disposeTools,
  resolveProxiedToolCall,
  type CodemodeCheckpoint,
  type CodemodeRuntime,
  type HistoryStore,
  type ResolvedModelCardCredentials,
  type SandboxExecutor,
} from "@open-managed-agents/agent-harness";
import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import type { BrowserHarness } from "@open-managed-agents/browser-harness";
import {
  ToolRequestDispatcher,
  ToolRequestWorker,
  type ToolDispatcherPort,
  type ToolRequest,
  type ToolRequestResult,
} from "@open-managed-agents/session-runtime-contract";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { generateEventId, type SessionEvent, type UserToolResultEvent, type EnvironmentConfig } from "@open-managed-agents/shared";
import type { Env } from "@open-managed-agents/shared";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlToolRequestStore } from "@open-managed-agents/managed-agents-adapters-sql";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { cfWorkersAiToMarkdown } from "@open-managed-agents/markdown";

export interface ToolDispatchState {
  tenant_id: string;
  session_id: string;
  environment_id: string;
}

export interface ToolDispatchWakeupArgs {
  delay_seconds?: number;
  at?: string;
  cron?: string;
  prompt: string;
}

export interface ToolDispatchWakeup {
  id: string;
  fire_at?: string;
  cron?: string;
  prompt: string;
  kind: "one_shot" | "cron";
}

export interface ToolDispatchScheduleResult {
  id: string;
  fire_at?: string;
  cron?: string;
  kind: "one_shot" | "cron";
}

export interface ToolDispatchHost {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  state: ToolDispatchState;
  getThreadAgentConfig(threadId: string): Promise<AgentConfig | null>;
  getEnvConfig(envId: string): Promise<EnvironmentConfig | null>;
  getOrCreateSandbox(): Promise<SandboxExecutor>;
  bindSandboxToExecution(
    sandbox: SandboxExecutor,
    signal: AbortSignal | undefined,
    fence: SessionExecutionFence | undefined,
    laneId: string,
  ): SandboxExecutor;
  resolveModelCardCredentials(handle: string): Promise<ResolvedModelCardCredentials>;
  agentModelHandle(agent: AgentConfig): string;
  getBrowserHarness(): BrowserHarness | null;
  persistAndBroadcastEvent(event: SessionEvent, laneId?: string): void;
  scheduleWakeup(args: ToolDispatchWakeupArgs): Promise<ToolDispatchScheduleResult>;
  cancelWakeup(id: string): Promise<{ cancelled: boolean }>;
  listWakeups(): ToolDispatchWakeup[];
  openHistory(): HistoryStore;
  toolUseAlreadyAnswered(toolUseId: string, history: HistoryStore): boolean;
  processedNow(): string;
  enqueueQueueInputIfNew(event: SessionEvent): boolean;
  broadcastPendingFrame(event: SessionEvent, threadId: string): void;
  schedule(delayMs: number, callback: string): Promise<unknown>;
  dispatchEventQueue(threadId: string): Promise<void>;
}

export interface ToolResultHost {
  toolUseAlreadyAnswered(toolUseId: string, history: HistoryStore): boolean;
  toolUseExists(toolUseId: string, history: HistoryStore): boolean;
  acceptNoEffectAnswer(event: SessionEvent, history: HistoryStore): Response;
  processedNow(): string;
  markAcceptedEventsProcessed(eventIds: string[], processedAt: string): void;
  enqueueQueueInputIfNew(event: SessionEvent): boolean;
  broadcastPendingFrame(event: SessionEvent, threadId: string): void;
  schedule(delayMs: number, callback: string): Promise<unknown>;
  dispatchEventQueue(threadId: string): Promise<void>;
}

/** Session-local adapter for the durable dispatcher/worker split. */
export class SessionToolDispatchController {
  private readonly runs = new Map<string, Promise<void>>();
  private readonly wakePending = new Set<string>();

  constructor(private readonly host: ToolDispatchHost) {}

  dispatcher(threadId: string): ToolDispatcherPort | undefined {
    const state = this.host.state;
    if (!state.tenant_id || !state.session_id) return undefined;
    return {
      dispatch: async (input, signal) => {
        const db = await buildCfTenantDbProvider(this.host.env).resolve(state.tenant_id);
        const store = new SqlToolRequestStore(new CfD1SqlClient(db), { dialect: "sqlite" });
        return new ToolRequestDispatcher({
          store,
          workspaceId: state.tenant_id,
          sessionId: state.session_id,
          sessionThreadId: threadId,
          parkAfterEnqueue: true,
          onEnqueued: (request) => this.wake(request),
        }).dispatch(input, signal);
      },
    };
  }

  private wake(request: ToolRequest): void {
    const existing = this.runs.get(request.sessionId);
    if (existing) {
      this.wakePending.add(request.sessionId);
      return;
    }
    const run = Promise.resolve().then(() => this.runOnce(request.sessionId));
    this.runs.set(request.sessionId, run);
    this.host.ctx.waitUntil(run.catch((error) => {
      console.error("[session_do] tool worker tick failed", error);
    }).finally(() => {
      if (this.runs.get(request.sessionId) !== run) return;
      this.runs.delete(request.sessionId);
      if (this.wakePending.delete(request.sessionId)) this.wake(request);
    }));
  }

  private async runOnce(sessionId: string): Promise<void> {
    const state = this.host.state;
    const db = await buildCfTenantDbProvider(this.host.env).resolve(state.tenant_id);
    const store = new SqlToolRequestStore(new CfD1SqlClient(db), { dialect: "sqlite" });
    const worker = new ToolRequestWorker({
      store,
      workerId: `session-worker:${state.session_id}`,
      leaseTtlMs: 60_000,
      pollLimit: 1,
      pollIntervalMs: 1,
      execute: (request, signal) => this.execute(request, signal),
      onCompleted: (request) => this.publish(request),
    });
    const signal = new AbortController().signal;
    while (await worker.runOnce(signal, { sessionId })) {
      // Drain the admitted batch. The worker enforces concurrency constraints.
    }
  }

  private codemode(): CodemodeRuntime | undefined {
    const namespace = this.host.env.CODEMODE_SANDBOX;
    if (!namespace) return undefined;
    const state = this.host.state;
    return {
      remote: () => namespace.getByName(state.session_id) as unknown as ReturnType<NonNullable<CodemodeRuntime["remote"]>>,
      interruptBudget: 100_000,
      timeoutMs: 300_000,
      memoryLimitBytes: 32 * 1024 * 1024,
      checkpointStore: {
        load: (key) => this.host.ctx.storage.get<CodemodeCheckpoint>(key).then((value) => value ?? null),
        save: (key, checkpoint) => this.host.ctx.storage.put(key, checkpoint),
        clear: (key) => this.host.ctx.storage.delete(key).then(() => undefined),
      },
      checkpointKey: (toolCallId) => `codemode-checkpoint:${state.session_id}:${toolCallId}`,
    };
  }

  private async execute(
    request: ToolRequest,
    signal: AbortSignal,
  ): Promise<Pick<ToolRequestResult, "status" | "content" | "isError">> {
    const state = this.host.state;
    const threadId = request.sessionThreadId ?? "sthr_primary";
    const agent = await this.host.getThreadAgentConfig(threadId);
    if (!agent) throw new Error("Agent not found for tool request");
    const sandbox = this.host.bindSandboxToExecution(
      await this.host.getOrCreateSandbox(), signal, undefined, threadId,
    );
    const credentials = await this.host.resolveModelCardCredentials(this.host.agentModelHandle(agent));
    const environmentConfig = state.environment_id
      ? (await this.host.getEnvConfig(state.environment_id))?.config
      : undefined;
    const tools = await buildTools(agent, sandbox, {
      ...delegationCredentials(credentials),
      TAVILY_API_KEY: this.host.env.TAVILY_API_KEY,
      toMarkdown: cfWorkersAiToMarkdown(this.host.env.AI),
      environmentConfig,
      mcpBinding: this.host.env.MAIN_MCP,
      tenantId: state.tenant_id,
      sessionId: state.session_id,
      codeMode: this.codemode(),
      browser: this.host.getBrowserHarness() ?? undefined,
      broadcastEvent: (event) => this.host.persistAndBroadcastEvent(event, threadId),
      scheduleWakeup: (args) => this.host.scheduleWakeup(args),
      cancelWakeup: (id) => this.host.cancelWakeup(id),
      listWakeups: () => this.host.listWakeups(),
    }, { enforcePermissions: false });
    try {
      const target = resolveProxiedToolCall(request.toolName, request.args);
      const tool = tools[target.toolName];
      if (!tool?.execute) throw new Error(`Tool ${target.toolName} is not executable`);
      const value = await tool.execute(target.args, {
        toolCallId: request.toolUseId,
        messages: [],
        abortSignal: signal,
      });
      return { status: "succeeded", content: value, isError: false };
    } finally {
      await disposeTools(tools);
    }
  }

  private async publish(request: ToolRequest): Promise<void> {
    if (request.result === null) return;
    const state = this.host.state;
    const content = request.result.content;
    const threadId = request.sessionThreadId ?? "sthr_primary";
    const event = {
      id: `tool-result:${request.id}`,
      type: "user.tool_result" as const,
      tool_use_id: request.toolUseId,
      content: [{ type: "text" as const, text: typeof content === "string" ? content : JSON.stringify(content) ?? String(content) }],
      is_error: request.result.isError,
      session_thread_id: threadId,
    } as unknown as UserToolResultEvent & { id: string; processed_at?: string };
    if (this.host.toolUseAlreadyAnswered(request.toolUseId, this.host.openHistory())) return;
    event.processed_at = this.host.processedNow();
    const queued = this.host.enqueueQueueInputIfNew(event);
    if (!queued) return;
    this.host.broadcastPendingFrame(event, threadId);
    try { await this.host.schedule(5, "recoverEventQueue"); } catch {}
    await this.host.dispatchEventQueue(threadId);
  }
}

export function createCodemodeRuntime(
  namespace: { getByName(name: string): unknown } | undefined,
  storage: DurableObjectStorage,
  sessionId: string,
): CodemodeRuntime | undefined {
  if (!namespace) return undefined;
  return {
    remote: () => namespace.getByName(sessionId) as ReturnType<NonNullable<CodemodeRuntime["remote"]>>,
    interruptBudget: 100_000,
    timeoutMs: 300_000,
    memoryLimitBytes: 32 * 1024 * 1024,
    checkpointStore: {
      load: (key) => storage.get<CodemodeCheckpoint>(key).then((value) => value ?? null),
      save: (key, checkpoint) => storage.put(key, checkpoint),
      clear: (key) => storage.delete(key).then(() => undefined),
    },
    checkpointKey: (toolCallId) => `codemode-checkpoint:${sessionId}:${toolCallId}`,
  };
}

export async function acceptToolResultEvent(
  host: ToolResultHost,
  toolResult: UserToolResultEvent,
  history: HistoryStore,
): Promise<Response> {
  const threadId = (toolResult as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
  if (host.toolUseAlreadyAnswered(toolResult.tool_use_id, history)) {
    return host.acceptNoEffectAnswer(toolResult, history);
  }
  if (!host.toolUseExists(toolResult.tool_use_id, history)) {
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
      message: `tool_use_id ${toolResult.tool_use_id} does not match any tool use in this session` } }),
      { status: 400, headers: { "content-type": "application/json" } });
  }
  const stamped = toolResult as UserToolResultEvent & { id?: string; processed_at?: string };
  if (!stamped.id) stamped.id = `sevt_${generateEventId()}`;
  stamped.processed_at = host.processedNow();
  host.markAcceptedEventsProcessed([stamped.id], stamped.processed_at);
  const enqueued = host.enqueueQueueInputIfNew(toolResult);
  if (enqueued) host.broadcastPendingFrame(toolResult, threadId);
  if (enqueued) {
    try { await host.schedule(5, "recoverEventQueue"); } catch {}
  }
  if (enqueued) await host.dispatchEventQueue(threadId);
  return new Response(null, { status: 202 });
}
