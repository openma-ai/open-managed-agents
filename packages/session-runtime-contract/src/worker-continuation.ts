import { answeredToolCallIds, requiresActionStopReason, toolResultIds, type WireEvent } from "./requires-action";

export interface WorkerPendingCall {
  toolCallId: string;
  execution?: "worker" | "client";
}

export interface EarlyCustomToolResultEvent {
  type: "user.custom_tool_result";
  custom_tool_use_id: string;
  content?: readonly { type: string; text?: string }[];
}

export interface WorkerToolResultEvent {
  type: "user.tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
  session_thread_id?: string;
}

/** Build the model-facing result for a durable public worker receipt. */
export function workerToolResultTranscript(result: WorkerToolResultEvent): Record<string, unknown> {
  return {
    type: "agent.tool_result",
    tool_use_id: result.tool_use_id,
    content: result.content,
    parent_event_id: result.tool_use_id,
    ...(result.is_error === true ? { is_error: true } : {}),
    ...(result.session_thread_id !== undefined && result.session_thread_id !== "sthr_primary"
      ? { session_thread_id: result.session_thread_id }
      : {}),
  };
}

export function customToolResultTranscript(result: {
  custom_tool_use_id: string;
  content?: readonly { type: string; text?: string }[];
}): Record<string, unknown> {
  return {
    type: "agent.tool_result",
    tool_use_id: result.custom_tool_use_id,
    content: (result.content ?? []).map((block) => block.type === "text" ? block.text ?? "" : "").join(""),
    parent_event_id: result.custom_tool_use_id,
    transcript_only: true,
  };
}

/** Select custom answers accepted while a durable worker is still running. */
export function acceptedEarlyCustomToolResults(
  events: readonly WireEvent[],
  batch: readonly WireEvent[],
  pendingCustomIds: ReadonlySet<string>,
  pending: readonly WorkerPendingCall[],
  answerRemaining: readonly string[] | null,
): EarlyCustomToolResultEvent[] {
  const knownCustomIds = new Set(events
    .filter((event) => event.type === "agent.custom_tool_use")
    .map((event) => event.id)
    .filter((id): id is string => typeof id === "string"));
  const hasPendingWorker = pending.some((call) => call.execution === "worker");
  if (answerRemaining !== null && !hasPendingWorker) return [];
  return batch.filter((event): event is WireEvent & EarlyCustomToolResultEvent =>
    event.type === "user.custom_tool_result" &&
    typeof event.custom_tool_use_id === "string" &&
    knownCustomIds.has(event.custom_tool_use_id) &&
    (pendingCustomIds.has(event.custom_tool_use_id) || hasPendingWorker));
}

export interface EarlyCustomContinuationPlan {
  transcripts: Record<string, unknown>[];
  pending: WorkerPendingCall[];
}

export function planEarlyCustomContinuation(
  events: readonly WireEvent[],
  batch: readonly WireEvent[],
  pendingCustomIds: ReadonlySet<string>,
  pending: readonly WorkerPendingCall[],
  answerRemaining: readonly string[] | null,
): EarlyCustomContinuationPlan | null {
  const accepted = acceptedEarlyCustomToolResults(events, batch, pendingCustomIds, pending, answerRemaining);
  if (accepted.length === 0) return null;
  const answered = new Set(accepted.map((event) => event.custom_tool_use_id));
  return {
    transcripts: accepted.filter((event) => !toolUseIsAnswered(event.custom_tool_use_id, events))
      .map(customToolResultTranscript),
    pending: pending.filter((call) => !answered.has(call.toolCallId)),
  };
}

/** Model history filter for a custom answer admitted in the current batch. */
export function historyForRequiresAction(
  events: readonly WireEvent[],
  batch: readonly WireEvent[],
): WireEvent[] {
  const currentEventIds = new Set(batch
    .map((event) => event.id)
    .filter((id): id is string => typeof id === "string"));
  const currentCustomIds = new Set(batch
    .filter((event) => event.type === "user.custom_tool_result")
    .map((event) => event.custom_tool_use_id)
    .filter((id): id is string => typeof id === "string"));
  const priorCustomIds = new Set(events
    .filter((event) => event.type === "user.custom_tool_result" && !currentEventIds.has(event.id as string))
    .map((event) => event.custom_tool_use_id)
    .filter((id): id is string => typeof id === "string"));
  return events.filter((event) =>
    !(event.type === "user.tool_result" && currentEventIds.has(event.id as string)) &&
    !(event.type === "user.custom_tool_result" && currentEventIds.has(event.id as string)) &&
    !(event.type === "agent.tool_result" &&
      event.transcript_only === true &&
      typeof event.tool_use_id === "string" &&
      currentCustomIds.has(event.tool_use_id) &&
      !priorCustomIds.has(event.tool_use_id)),
  );
}

export function shouldAppendWorkerAgentResult(toolUseId: string, events: readonly WireEvent[]): boolean {
  const hasTranscript = events.some((event) =>
    event.type === "agent.tool_result" && event.tool_use_id === toolUseId);
  const hasWorkerAnswer = events.some((event) =>
    event.type === "user.tool_result" && event.tool_use_id === toolUseId);
  return !hasTranscript && hasWorkerAnswer;
}

export function missingWorkerToolResultTranscripts(
  batch: readonly WireEvent[],
  events: readonly WireEvent[],
): Record<string, unknown>[] {
  const existing = new Set(events
    .filter((event) => event.type === "agent.tool_result")
    .map((event) => event.tool_use_id)
    .filter((id): id is string => typeof id === "string"));
  return batch
    .filter((event): event is WireEvent & WorkerToolResultEvent =>
      event.type === "user.tool_result" && typeof event.tool_use_id === "string")
    .filter((event) => !existing.has(event.tool_use_id))
    .map(workerToolResultTranscript);
}

/** Whether an answer or custom receipt already closes a tool call. */
export function toolUseIsAnswered(toolUseId: string, events: readonly WireEvent[]): boolean {
  return toolResultIds(events).has(toolUseId) || events.some((event) =>
    event.type === "user.custom_tool_result" && event.custom_tool_use_id === toolUseId,
  );
}

/** Resolve pending worker/client calls after a durable worker result arrives. */
export function workerContinuationAction(
  events: readonly WireEvent[],
  pending: readonly WorkerPendingCall[],
): "waiting" | string[] | null {
  const answeredIds = answeredToolCallIds(events);
  const pendingWorkerCalls = pending.filter((call) => call.execution === "worker");
  if (pendingWorkerCalls.length > 0) return "waiting";

  const openMcpWorkerCall = events.some((event) =>
    event.type === "agent.mcp_tool_use" &&
    typeof event.id === "string" &&
    !answeredIds.has(event.id),
  );
  if (openMcpWorkerCall) return "waiting";

  const answeredCustomIds = new Set(events
    .filter((event) => event.type === "user.custom_tool_result")
    .map((event) => event.custom_tool_use_id)
    .filter((id): id is string => typeof id === "string"));
  const openCustomCalls = events
    .filter((event) => event.type === "agent.custom_tool_use")
    .map((event) => event.id)
    .filter((id): id is string => typeof id === "string")
    .filter((id) => !answeredIds.has(id) && !answeredCustomIds.has(id));
  const pendingClientCalls = pending
    .filter((call) => call.execution !== "worker")
    .map((call) => call.toolCallId);
  const clientCallIds = pendingClientCalls.length > 0 ? pendingClientCalls : openCustomCalls;
  return clientCallIds.length > 0 ? clientCallIds : null;
}

export interface WorkerContinuationPlan {
  pending: WorkerPendingCall[];
  action: "waiting" | string[] | null;
  customCallIds: string[];
  stopIds: "waiting" | string[] | null;
}

/** Resolve a batch of durable worker results without mutating session state. */
export function planWorkerContinuation(
  events: readonly WireEvent[],
  batch: readonly WireEvent[],
  pending: readonly WorkerPendingCall[],
): WorkerContinuationPlan {
  const answered = new Set(batch
    .filter((event) => event.type === "user.tool_result")
    .map((event) => event.tool_use_id)
    .filter((id): id is string => typeof id === "string"));
  const pendingAfter = pending.filter((call) => !answered.has(call.toolCallId));
  const action = workerContinuationAction(events, pendingAfter);
  const plan = {
    pending: pendingAfter,
    action,
    customCallIds: events
      .filter((event) => event.type === "agent.custom_tool_use")
      .map((event) => event.id)
      .filter((id): id is string => typeof id === "string"),
  };
  return { ...plan, stopIds: workerContinuationStopIds(plan) };
}

export function workerContinuationStopIds(
  plan: Omit<WorkerContinuationPlan, "stopIds">,
): "waiting" | string[] | null {
  if (plan.action === "waiting") return "waiting";
  if (plan.action !== null) return plan.action;
  return plan.customCallIds.length > 0 ? plan.customCallIds : null;
}

export function workerContinuationIdleEvent(stopIds: readonly string[]): Record<string, unknown> {
  return { type: "session.status_idle", stop_reason: requiresActionStopReason(stopIds) };
}

export interface AcceptedWorkerBatchPlan {
  hasWorkerResult: boolean;
  earlyCustom: EarlyCustomContinuationPlan | null;
  worker: WorkerContinuationPlan | null;
}

export function planAcceptedWorkerBatch(
  events: readonly WireEvent[],
  batch: readonly WireEvent[],
  pendingCustomIds: ReadonlySet<string>,
  pending: readonly WorkerPendingCall[],
  answerRemaining: readonly string[] | null,
): AcceptedWorkerBatchPlan {
  const hasWorkerResult = batch.some((event) => event.type === "user.tool_result");
  return {
    hasWorkerResult,
    earlyCustom: planEarlyCustomContinuation(events, batch, pendingCustomIds, pending, answerRemaining),
    worker: hasWorkerResult ? planWorkerContinuation(events, batch, pending) : null,
  };
}

export interface PendingWorkerCallEvent {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Convert a harness tool-use event into the durable pending-call shape. */
export function pendingCallFromEvent(
  event: PendingWorkerCallEvent,
  pendingDispatches: ReadonlySet<string>,
): (WorkerPendingCall & { toolName: string; args: Record<string, unknown> }) | null {
  if ((event.type !== "agent.tool_use" && event.type !== "agent.custom_tool_use") ||
      typeof event.id !== "string" || typeof event.name !== "string") return null;
  return {
    toolCallId: event.id,
    toolName: event.name,
    args: event.input ?? {},
    execution: pendingDispatches.has(event.id) ? "worker" : "client",
  };
}
