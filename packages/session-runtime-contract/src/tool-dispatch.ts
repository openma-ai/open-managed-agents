/**
 * Durable tool-request lifecycle shared by a model dispatcher and external
 * tool workers. The contract deliberately contains no SQL or queue client
 * types. Storage adapters implement these CAS operations for their backend.
 */

export type ToolExecutionConcurrency =
  | "parallel_safe"
  | "resource_serial"
  | "exclusive";

/** The small boundary used by a model dispatcher. The host supplies session
 * identity and request IDs, while the harness only supplies the tool call. */
export interface ToolDispatchInput {
  toolCallId: string;
  toolName: string;
  args: unknown;
  concurrency: ToolExecutionConcurrency;
  resourceKey?: string;
}

export type ToolDispatchOutcome = Pick<ToolRequestResult, "status" | "content" | "isError"> & {
  /** The request was durably queued and the model turn must park. */
  pending?: boolean;
  requestId?: string;
};

export interface ToolDispatcherPort {
  dispatch(input: ToolDispatchInput, signal: AbortSignal): Promise<ToolDispatchOutcome>;
}

export type ToolRequestState =
  | "queued"
  | "claimed"
  | "completed"
  | "cancelled";

export interface ToolRequestInput {
  id: string;
  idempotencyKey: string;
  workspaceId: string;
  sessionId: string;
  sessionThreadId?: string;
  toolUseId: string;
  toolName: string;
  args: unknown;
  concurrency: ToolExecutionConcurrency;
  /** Calls using the same resource key are serialized. */
  resourceKey?: string;
  createdAt: string;
  availableAt?: string;
}

export interface ToolRequestClaim {
  ownerId: string;
  attemptId: string;
  generation: number;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface ToolRequestResult {
  status: "succeeded" | "failed";
  content?: unknown;
  isError: boolean;
  completedAt: string;
  /** The request idempotency key that produced this result. */
  idempotencyKey: string;
}

export interface ToolRequest extends ToolRequestInput {
  state: ToolRequestState;
  attemptCount: number;
  revision: number;
  claim: ToolRequestClaim | null;
  result: ToolRequestResult | null;
  cancelledAt: string | null;
}

export interface ToolRequestFence {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
}

export interface PollToolRequests {
  workerId: string;
  now: string;
  leaseTtlMs: number;
  limit?: number;
  workspaceId?: string;
  sessionId?: string;
  toolNames?: readonly string[];
}

export type PollToolRequestsResult =
  | { type: "claimed"; leases: Array<{ request: ToolRequest; fence: ToolRequestFence }> }
  | { type: "empty" };

export type RenewToolRequestResult =
  | { type: "renewed"; fence: ToolRequestFence }
  | { type: "lost" };

export type CompleteToolRequestResult =
  | { type: "completed"; request: ToolRequest }
  /** A retry after a successful commit returns the durable result. */
  | { type: "replayed"; request: ToolRequest }
  | { type: "lost" };

export type CancelToolRequestResult =
  | { type: "cancelled"; request: ToolRequest }
  | { type: "already_settled"; request: ToolRequest }
  | { type: "lost" };

export interface ToolRequestStorePort {
  enqueue(input: ToolRequestInput): Promise<
    | { type: "enqueued"; request: ToolRequest }
    | { type: "replayed"; request: ToolRequest }
    | { type: "conflict"; request: ToolRequest }
  >;
  poll(input: PollToolRequests): Promise<PollToolRequestsResult>;
  renew(input: {
    fence: ToolRequestFence;
    renewedAt: string;
    leaseTtlMs: number;
  }): Promise<RenewToolRequestResult>;
  complete(input: {
    fence: ToolRequestFence;
    result: Omit<ToolRequestResult, "idempotencyKey">;
  }): Promise<CompleteToolRequestResult>;
  cancel(input: {
    requestId: string;
    cancelledAt: string;
    fence?: ToolRequestFence;
  }): Promise<CancelToolRequestResult>;
  find(input: { requestId: string }): Promise<ToolRequest | null>;
}

export interface ToolRequestDispatcherOptions {
  store: ToolRequestStorePort;
  workspaceId: string;
  sessionId: string;
  sessionThreadId?: string;
  requestId?: (input: ToolDispatchInput) => string;
  idempotencyKey?: (input: ToolDispatchInput) => string;
  pollIntervalMs?: number;
  now?: () => string;
  /** CMA mode returns after enqueue so the Session can emit requires_action. */
  parkAfterEnqueue?: boolean;
  /** Wake a worker after a new durable request is observed. */
  onEnqueued?: (request: ToolRequest) => Promise<void> | void;
}

function dispatcherDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Model-loop side of the dispatcher/worker split. It writes one durable
 * request and waits for the worker's committed result. A second dispatch with
 * the same tool-call ID observes the same result instead of executing again. */
export class ToolRequestDispatcher implements ToolDispatcherPort {
  private readonly now: () => string;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: ToolRequestDispatcherOptions) {
    if (!options.workspaceId || !options.sessionId) throw new Error("workspaceId and sessionId are required");
    this.now = options.now ?? (() => new Date().toISOString());
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new RangeError("pollIntervalMs must be a positive integer");
    }
  }

  async dispatch(input: ToolDispatchInput, signal: AbortSignal): Promise<ToolDispatchOutcome> {
    const id = this.options.requestId?.(input) ?? `${this.options.sessionId}:tool:${input.toolCallId}`;
    const idempotencyKey = this.options.idempotencyKey?.(input) ?? id;
    const enqueued = await this.options.store.enqueue({
      id,
      idempotencyKey,
      workspaceId: this.options.workspaceId,
      sessionId: this.options.sessionId,
      sessionThreadId: this.options.sessionThreadId,
      toolUseId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      concurrency: input.concurrency,
      resourceKey: input.resourceKey,
      createdAt: this.now(),
      availableAt: this.now(),
    });
    if (enqueued.type === "conflict") throw new Error(`Tool request idempotency conflict for ${idempotencyKey}`);
    if (signal.aborted) {
      await this.options.store.cancel({ requestId: id, cancelledAt: this.now() });
      return { status: "failed", isError: true, content: "Tool request dispatch was interrupted" };
    }
    if (enqueued.request.state === "queued" && this.options.onEnqueued) {
      void this.options.onEnqueued(enqueued.request);
    }
    if (this.options.parkAfterEnqueue === true) {
      if (enqueued.type === "replayed" && enqueued.request.state === "completed" && enqueued.request.result !== null) {
        return {
          status: enqueued.request.result.status,
          content: enqueued.request.result.content,
          isError: enqueued.request.result.isError,
        };
      }
      return {
        status: "succeeded",
        content: "Tool request queued; waiting for worker result",
        isError: false,
        pending: true,
        requestId: id,
      };
    }
    while (true) {
      const request = await this.options.store.find({ requestId: id });
      if (request?.state === "completed" && request.result !== null) {
        return {
          status: request.result.status,
          content: request.result.content,
          isError: request.result.isError,
        };
      }
      if (request?.state === "cancelled") {
        return { status: "failed", isError: true, content: "Tool request was cancelled" };
      }
      if (signal.aborted) {
        const cancelled = await this.options.store.cancel({ requestId: id, cancelledAt: this.now() });
        if (cancelled.type === "cancelled") {
          return { status: "failed", isError: true, content: "Tool request was cancelled" };
        }
        return { status: "failed", isError: true, content: "Tool request dispatch was interrupted" };
      }
      await dispatcherDelay(this.pollIntervalMs, signal);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requestFingerprint(input: ToolRequestInput): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sessionThreadId: input.sessionThreadId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    args: input.args,
    concurrency: input.concurrency,
    resourceKey: input.resourceKey,
  });
}

function epoch(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid tool request timestamp ${value}`);
  return parsed;
}

function scopeKey(request: ToolRequest): string {
  return `${request.workspaceId}/${request.sessionId}`;
}

function resourceKey(request: ToolRequest): string {
  return request.resourceKey ?? scopeKey(request);
}

function sameFence(request: ToolRequest, fence: ToolRequestFence): boolean {
  return request.state === "claimed" && request.claim !== null &&
    request.id === fence.requestId && request.workspaceId === fence.workspaceId &&
    request.sessionId === fence.sessionId && request.claim.ownerId === fence.ownerId &&
    request.claim.attemptId === fence.attemptId && request.claim.generation === fence.generation &&
    request.claim.leaseExpiresAt === fence.expiresAt;
}

/**
 * Deterministic in-memory implementation for conformance tests and local
 * development. Production adapters should preserve the same compare-and-set
 * boundaries when mapping these operations to D1/PostgreSQL/MySQL.
 */
export class InMemoryToolRequestStore implements ToolRequestStorePort {
  private readonly requests = new Map<string, ToolRequest>();
  private readonly idempotency = new Map<string, string>();

  async enqueue(input: ToolRequestInput) {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.requests.get(existingId);
      if (existing === undefined) throw new Error("Tool request idempotency index is inconsistent");
      return {
        type: requestFingerprint(existing) === requestFingerprint(input) ? "replayed" as const : "conflict" as const,
        request: clone(existing),
      };
    }
    if (this.requests.has(input.id)) {
      return { type: "conflict" as const, request: clone(this.requests.get(input.id)!) };
    }
    const request: ToolRequest = {
      ...clone(input),
      availableAt: input.availableAt ?? input.createdAt,
      state: "queued",
      attemptCount: 0,
      revision: 1,
      claim: null,
      result: null,
      cancelledAt: null,
    };
    this.requests.set(request.id, request);
    this.idempotency.set(request.idempotencyKey, request.id);
    return { type: "enqueued" as const, request: clone(request) };
  }

  async poll(input: PollToolRequests): Promise<PollToolRequestsResult> {
    const now = epoch(input.now);
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    const limit = input.limit ?? 1;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive integer");
    this.requeueExpired(now);
    const names = input.toolNames === undefined ? null : new Set(input.toolNames);
    const candidates = [...this.requests.values()]
      .filter((request) => request.state === "queued")
      .filter((request) => input.workspaceId === undefined || request.workspaceId === input.workspaceId)
      .filter((request) => input.sessionId === undefined || request.sessionId === input.sessionId)
      .filter((request) => names === null || names.has(request.toolName))
      .filter((request) => epoch(request.availableAt ?? request.createdAt) <= now)
      .sort((left, right) => epoch(left.createdAt) - epoch(right.createdAt) || left.id.localeCompare(right.id));
    const leases: Array<{ request: ToolRequest; fence: ToolRequestFence }> = [];
    for (const request of candidates) {
      if (leases.length >= limit || !this.canClaim(request)) continue;
      const generation = request.attemptCount + 1;
      request.state = "claimed";
      request.attemptCount += 1;
      request.revision += 1;
      request.claim = {
        ownerId: input.workerId,
        attemptId: `${input.workerId}:${request.id}:${generation}`,
        generation,
        claimedAt: input.now,
        leaseExpiresAt: new Date(now + input.leaseTtlMs).toISOString(),
      };
      const fence: ToolRequestFence = {
        requestId: request.id,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        attemptId: request.claim.attemptId,
        ownerId: request.claim.ownerId,
        generation,
        expiresAt: request.claim.leaseExpiresAt,
      };
      leases.push({ request: clone(request), fence });
    }
    return leases.length === 0 ? { type: "empty" } : { type: "claimed", leases };
  }

  async renew(input: { fence: ToolRequestFence; renewedAt: string; leaseTtlMs: number }): Promise<RenewToolRequestResult> {
    const request = this.requests.get(input.fence.requestId);
    if (!request || !sameFence(request, input.fence) || epoch(input.fence.expiresAt) <= epoch(input.renewedAt)) return { type: "lost" };
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) throw new RangeError("leaseTtlMs must be a positive integer");
    const claim = request.claim;
    if (claim === null) return { type: "lost" };
    request.revision += 1;
    claim.leaseExpiresAt = new Date(epoch(input.renewedAt) + input.leaseTtlMs).toISOString();
    return {
      type: "renewed",
      fence: { ...input.fence, expiresAt: claim.leaseExpiresAt },
    };
  }

  async complete(input: { fence: ToolRequestFence; result: Omit<ToolRequestResult, "idempotencyKey"> }): Promise<CompleteToolRequestResult> {
    const request = this.requests.get(input.fence.requestId);
    if (!request) return { type: "lost" };
    if (request.state === "completed" && request.result !== null) return { type: "replayed", request: clone(request) };
    if (!sameFence(request, input.fence) || epoch(input.fence.expiresAt) <= epoch(input.result.completedAt)) return { type: "lost" };
    request.state = "completed";
    request.revision += 1;
    request.claim = null;
    request.result = { ...clone(input.result), idempotencyKey: request.idempotencyKey };
    return { type: "completed", request: clone(request) };
  }

  async cancel(input: { requestId: string; cancelledAt: string; fence?: ToolRequestFence }): Promise<CancelToolRequestResult> {
    const request = this.requests.get(input.requestId);
    if (!request) return { type: "lost" };
    if (request.state === "completed" || request.state === "cancelled") return { type: "already_settled", request: clone(request) };
    if (request.state === "claimed" && (!input.fence || !sameFence(request, input.fence) || epoch(input.fence.expiresAt) <= epoch(input.cancelledAt))) return { type: "lost" };
    request.state = "cancelled";
    request.cancelledAt = input.cancelledAt;
    request.claim = null;
    request.revision += 1;
    return { type: "cancelled", request: clone(request) };
  }

  async find(input: { requestId: string }): Promise<ToolRequest | null> {
    const request = this.requests.get(input.requestId);
    return request === undefined ? null : clone(request);
  }

  private requeueExpired(now: number): void {
    for (const request of this.requests.values()) {
      if (request.state !== "claimed" || request.claim === null || epoch(request.claim.leaseExpiresAt) > now) continue;
      request.state = "queued";
      request.claim = null;
      request.availableAt = new Date(now).toISOString();
      request.revision += 1;
    }
  }

  private canClaim(candidate: ToolRequest): boolean {
    const active = [...this.requests.values()].filter((request) => request.state === "claimed");
    const candidateScope = scopeKey(candidate);
    const candidateResource = resourceKey(candidate);
    return active.every((request) => {
      if (scopeKey(request) !== candidateScope) return true;
      if (candidate.concurrency === "exclusive" || request.concurrency === "exclusive") return false;
      if (candidate.concurrency === "resource_serial" || request.concurrency === "resource_serial") {
        return resourceKey(request) !== candidateResource;
      }
      return true;
    });
  }
}

export interface ToolRequestWorkerOptions {
  store: ToolRequestStorePort;
  workerId: string;
  leaseTtlMs: number;
  pollLimit?: number;
  pollIntervalMs?: number;
  now?: () => string;
  execute: (
    request: ToolRequest,
    signal: AbortSignal,
  ) => Promise<Pick<ToolRequestResult, "status" | "content" | "isError">>;
  onCompleted?: (request: ToolRequest) => Promise<void> | void;
}

function sleepWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls durable tool requests and executes each claimed lease. The store owns
 * concurrency admission and fencing. This runner owns only the worker-side
 * heartbeat and the callback that publishes a completed user.tool_result.
 */
export class ToolRequestWorker {
  private readonly options: Required<Pick<ToolRequestWorkerOptions, "pollLimit" | "pollIntervalMs">> & ToolRequestWorkerOptions;
  private readonly now: () => string;

  constructor(options: ToolRequestWorkerOptions) {
    if (!options.workerId) throw new Error("workerId is required");
    if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    this.options = { pollLimit: 8, pollIntervalMs: 1_000, ...options };
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce(signal);
      if (!worked) {
        await sleepWithSignal(this.options.pollIntervalMs, signal);
      }
    }
  }

  /** Execute one bounded poll tick. Hosts may use this from a durable
   * wake-up after enqueueing without keeping a process-level loop alive. */
  async runOnce(
    signal: AbortSignal,
    scope: Pick<PollToolRequests, "workspaceId" | "sessionId" | "toolNames"> = {},
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const claimed = await this.options.store.poll({
      workerId: this.options.workerId,
      now: this.now(),
      leaseTtlMs: this.options.leaseTtlMs,
      limit: this.options.pollLimit,
      ...scope,
    });
    if (claimed.type === "empty") return false;
    await Promise.all(claimed.leases.map((lease) => this.executeLease(lease, signal)));
    return true;
  }

  private async executeLease(
    lease: { request: ToolRequest; fence: ToolRequestFence },
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    let fence = lease.fence;
    let lost = false;
    const executionController = new AbortController();
    const stop = () => executionController.abort(new Error("Tool request lease lost"));
    if (shutdownSignal.aborted) return;
    shutdownSignal.addEventListener("abort", stop, { once: true });
    const heartbeatInterval = Math.max(1, Math.floor(this.options.leaseTtlMs / 3));
    const heartbeat = setInterval(() => {
      void this.options.store.renew({
        fence,
        renewedAt: this.now(),
        leaseTtlMs: this.options.leaseTtlMs,
      }).then((renewed) => {
        if (renewed.type === "lost") {
          lost = true;
          stop();
        } else {
          fence = renewed.fence;
        }
      }).catch(() => {
        lost = true;
        stop();
      });
    }, heartbeatInterval);
    try {
      let result: Pick<ToolRequestResult, "status" | "content" | "isError">;
      try {
        result = await this.options.execute(lease.request, executionController.signal);
      } catch (error) {
        result = {
          status: "failed",
          isError: true,
          content: error instanceof Error ? error.message : String(error),
        };
      }
      if (shutdownSignal.aborted || lost) return;
      const completed = await this.options.store.complete({
        fence,
        result: { ...result, completedAt: this.now() },
      });
      if (completed.type === "completed" || completed.type === "replayed") {
        await this.options.onCompleted?.(completed.request);
      }
    } finally {
      clearInterval(heartbeat);
      shutdownSignal.removeEventListener("abort", stop);
    }
  }
}
