import type { ClientCallbacks } from "@openma/common/acp-runtime";
import type { ManagedRuntimeEventWire, RuntimeResourceScope } from "@openma/common/managed-runtime";
import { immutableJson } from "@openma/common/session-events/openma";

/** Trusted owner identity, never taken from an input event or ACP metadata. */
export interface WorkPermissionScope extends RuntimeResourceScope {
  generation: number;
  holder: string;
}
type RequestPermission = NonNullable<ClientCallbacks["requestPermission"]>;
type PermissionResponse = Awaited<ReturnType<RequestPermission>>;

export interface WorkPermissionBridgeOptions {
  scope: WorkPermissionScope;
  /** Owning ACP prompt identity (lifetime/correlation only). This is NOT the
   * canonical confirmation consumption identity; never pass it to consume. */
  turnId: string;
  acpSessionId: string;
  /** Exact server-stamped bytes read after root consumption. When present,
   * confirmation dispatch identity is preserved but its consumer is this root. */
  rootProof?: { inputId: string; turnId: string; expectedDocument: string };
  /** Abort on interrupt, turn end, Work cancellation, or claim/provider loss. */
  signal: AbortSignal;
  nextEventId(): string;
  now(): Date;
  /** Publish one ordered canonical batch through the fenced private runtime-events
   * channel. Resolve only after durable acceptance; reject on unknown acceptance.
   * Must share serialization with the parent projector, and honor signal. */
  publish(input: {
    scope: Readonly<WorkPermissionScope>;
    events: ManagedRuntimeEventWire[];
    signal: AbortSignal;
  }): Promise<void>;
  /** Existing private inputs-consume CAS: fence + exact document in one transaction.
   * Resolve only on a validated before_dispatch receipt; never retry here. */
  consume(input: {
    inputId: string;
    /** Canonical source_position.execution_id ?? inputId, not the ACP turn. */
    turnId: string;
    expectedDocument: string;
    consumingTurnId?: string;
    rootInputId?: string;
    expectedRootDocument?: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkPermissionBridge {
  /** Assign directly to common's public clientCallbacks.requestPermission. The
   * callback Promise itself retains JSON-RPC correlation; no synthetic RPC id. */
  requestPermission: RequestPermission;
  /** Takes the exact private Work input document (domain camelCase fields).
   * Rejected confirmations MUST NOT fall through to session.prompt/steer. */
  confirm(input: { scope: WorkPermissionScope; document: string }): Promise<"answered" | "rejected">;
  /** Parent projector suppresses the duplicate tool_use and remaps its later
   * tool_result to this id. Mapping lasts through the owning turn. */
  toolUseIdFor(acpToolCallId: string): string | undefined;
  /** Invalidate this turn's callbacks only; does not stop Work or release leases. */
  close(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const cancelled = (): PermissionResponse => ({ outcome: { outcome: "cancelled" } });
const scopeKeys = ["workspaceId", "environmentId", "sessionId", "workId", "generation", "holder"] as const;

interface Pending {
  id: string;
  published: boolean;
  allowId?: string;
  denyId?: string;
  resolve(response: PermissionResponse): void;
}

/** One original prompt and one Work claim generation. No model/prompt/tool runner,
 * timer, transport retries, mode selection, aux review, or lease ownership here.
 * common 0.13.1 exposes the ACP callback but NOT an HTTP confirmation interceptor:
 * this module is deliberately not auto-installed into its control channel. */
export function createWorkPermissionBridge(options: WorkPermissionBridgeOptions): WorkPermissionBridge {
  const scope = Object.freeze({ ...options.scope });
  if (scopeKeys.some(key => key !== "generation" && !text(scope[key])) ||
      !Number.isSafeInteger(scope.generation) || scope.generation < 1 ||
      !text(options.turnId) || !text(options.acpSessionId)) {
    throw new TypeError("Invalid Work permission scope");
  }
  const acpSessionId = options.acpSessionId;
  const controller = new AbortController();
  const pending = new Map<string, Pending>();
  const toolIds = new Map<string, string>();
  const eventIds = new Set<string>();
  const answeredIds = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  let stopped!: () => void;
  const closed = new Promise<void>(resolve => { stopped = resolve; });
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    options.signal.removeEventListener("abort", close);
    for (const entry of pending.values()) entry.resolve(cancelled());
    pending.clear();
    stopped();
  };
  if (options.signal.aborted) close();
  else options.signal.addEventListener("abort", close, { once: true });

  function nextId(): string {
    const id = options.nextEventId();
    if (!text(id) || eventIds.has(id)) throw new Error("Invalid permission event identity");
    eventIds.add(id);
    return id;
  }
  function event(type: string, fields: Record<string, unknown> = {}, id = nextId()): ManagedRuntimeEventWire {
    return { id, type, processed_at: options.now().toISOString(), ...fields };
  }
  function status(id?: string): ManagedRuntimeEventWire {
    const ids = [...pending.values()].filter(entry => entry.published).map(entry => entry.id);
    return ids.length === 0
      ? event("session.status_running", {}, id)
      : event("session.status_idle", { stop_reason: { type: "requires_action", event_ids: ids } }, id);
  }
  async function publish(events: ManagedRuntimeEventWire[]): Promise<void> {
    controller.signal.throwIfAborted();
    await options.publish({ scope, events, signal: controller.signal });
    controller.signal.throwIfAborted();
  }
  // Serialize publications and confirmations, NOT the unresolved callback Promises.
  // An abort resolves the public wait even when an external IO port is stuck.
  function enqueue<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const work = tail.then(async () => {
      if (controller.signal.aborted) return fallback;
      try { return await operation(); }
      catch { close(); return fallback; }
    });
    tail = work;
    return Promise.race([work, closed.then(() => fallback)]);
  }

  const requestPermission: RequestPermission = request => {
    if (controller.signal.aborted) return Promise.resolve(cancelled());
    try {
      if (!isRecord(request) || request.sessionId !== acpSessionId || !isRecord(request.toolCall) ||
          !text(request.toolCall.toolCallId) || !Array.isArray(request.options) || request.options.length === 0) {
        return Promise.resolve(cancelled());
      }
      const nativeId = request.toolCall.toolCallId;
      if (toolIds.has(nativeId)) { close(); return Promise.resolve(cancelled()); }
      const optionIds = new Set<string>();
      for (const option of request.options) {
        if (!isRecord(option) || !text(option.optionId) || optionIds.has(option.optionId) ||
            !["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind)) {
          return Promise.resolve(cancelled());
        }
        optionIds.add(option.optionId);
      }
      const raw = request.toolCall.rawInput;
      const input = immutableJson(isRecord(raw) ? raw : { raw_input: raw ?? null });
      const id = nextId();
      const statusId = nextId();
      const tool = event("agent.tool_use", {
        name: text(request.toolCall.title) ? request.toolCall.title : "ACP tool",
        input, evaluated_permission: "ask",
      }, id);
      let resolve!: Pending["resolve"];
      const response = new Promise<PermissionResponse>(done => { resolve = done; });
      const entry: Pending = {
        id, published: false, resolve,
        allowId: request.options.find(option => option.kind === "allow_once")?.optionId,
        denyId: request.options.find(option => option.kind === "reject_once")?.optionId,
      };
      toolIds.set(nativeId, id);
      pending.set(id, entry);
      void enqueue(async () => {
        entry.published = true;
        await publish([tool, status(statusId)]);
      }, undefined);
      return response;
    } catch {
      close();
      return Promise.resolve(cancelled());
    }
  };

  return {
    requestPermission,
    toolUseIdFor: nativeId => toolIds.get(nativeId),
    close,
    async confirm(input) {
      if (controller.signal.aborted || !isRecord(input.scope) ||
          scopeKeys.some(key => input.scope[key] !== scope[key])) return "rejected";
      // Parse one immutable string, never a caller's mutable event mirror. Private
      // input documents intentionally differ from public snake_case wire events.
      const document = input.document;
      let value: unknown;
      try { value = JSON.parse(document); } catch { return "rejected"; }
      if (!isRecord(value) || value.type !== "user.tool_confirmation" || !text(value.id) ||
          !text(value.toolUseId) || (value.result !== "allow" && value.result !== "deny") ||
          (value.sessionThreadId != null && value.sessionThreadId !== "sthr_primary") ||
          value.processedAt !== null || !isRecord(value.source_position) ||
          !Number.isSafeInteger(value.source_position.revision) || Number(value.source_position.revision) < 1 ||
          !Number.isSafeInteger(value.source_position.index) || Number(value.source_position.index) < 0) return "rejected";
      const { id: inputId, toolUseId, result } = value;
      // Real writer contract: managed cloud confirmations are accepted with
      // processedAt:null (SessionEventsApplicationService.toSentEvent). The SQL
      // processed_at column is an ordering stamp, NOT that processing marker.
      // self_hosted receipt-stamped confirmations remain unsupported by the
      // current SqlWorkInputs CAS; do not broaden acceptance here.
      const source = value.source_position;
      if ((Object.hasOwn(source, "execution_id") && !text(source.execution_id)) ||
          Object.hasOwn(source, "consumed_by_execution_id")) return "rejected";
      // SqlSessionEventStore.append omits execution_id; appendWithExecutionOutbox
      // assigns the canonical input batch id. SqlWorkInputs.consume enforces this
      // identity AND byte-exact CAS. Reading metadata is not authentication: a
      // forged document must still be rejected by that unchanged server fence.
      const consumptionId = typeof source.execution_id === "string" ? source.execution_id : inputId;
      return enqueue(async () => {
        const entry = pending.get(toolUseId);
        if (!entry?.published || answeredIds.has(inputId)) return "rejected" as const;
        // Reserve before IO; no second answer can win while CAS is in flight.
        answeredIds.add(inputId);
        await options.consume({ inputId, turnId: consumptionId, expectedDocument: document, signal: controller.signal,
          ...(options.rootProof ? {consumingTurnId:options.rootProof.turnId,rootInputId:options.rootProof.inputId,expectedRootDocument:options.rootProof.expectedDocument} : {}),
        });
        controller.signal.throwIfAborted();
        entry.published = false;
        try { await publish([status()]); }
        catch (error) { entry.resolve(cancelled()); throw error; }
        pending.delete(toolUseId);
        // Exact offered one-time option only; deny never selects an allow option.
        const optionId = result === "allow" ? entry.allowId : entry.denyId;
        entry.resolve(optionId === undefined ? cancelled() : { outcome: { outcome: "selected", optionId } });
        return "answered" as const;
      }, "rejected" as const);
    },
  };
}
