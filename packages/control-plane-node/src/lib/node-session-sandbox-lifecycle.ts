import { randomUUID } from "node:crypto";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { withSandboxExecutionGuard } from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type {
  SessionSandboxBindingPort,
  SessionSandboxHandle,
  SessionSandboxManagementFence,
  SessionSandboxMutation,
  SessionSandboxMutationResult,
  SessionSandboxResource,
  SessionSandboxScope,
} from "@open-managed-agents/session-runtime-contract/sandbox-binding";

export type NodeSessionSandboxLifecycleErrorCode =
  | "unsupported" | "busy" | "unknown_create" | "unknown_management"
  | "configuration_changed" | "not_ready" | "management_lost" | "use_conflict"
  | "resource_missing" | "handle_mismatch" | "cleanup_unavailable" | "conflict" | "closed";

export class NodeSessionSandboxLifecycleError extends Error {
  constructor(readonly code: NodeSessionSandboxLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeSessionSandboxLifecycleError";
  }
}

type ResumeSandbox = (
  handle: SessionSandboxHandle,
  allocationId: string,
  signal: AbortSignal,
  resource: SessionSandboxResource,
) => Promise<SandboxExecutor>;

export interface OpenNodeSessionSandbox {
  scope: SessionSandboxScope;
  configFingerprint: string;
  create(allocationId: string, signal: AbortSignal): Promise<SandboxExecutor>;
  resume: ResumeSandbox;
  handle(sandbox: SandboxExecutor): SessionSandboxHandle;
  prepare(
    sandbox: SandboxExecutor,
    allocationId: string,
    signal: AbortSignal,
    authorization: { fresh: boolean; fence: SessionSandboxManagementFence; isCurrent(): Promise<boolean> },
  ): Promise<void>;
  /** Cancels only this wait. Session provisioning has its own management lease. */
  waitSignal?: AbortSignal;
}

export interface OpenedNodeSessionSandbox {
  sandbox: SandboxExecutor;
  allocationId: string;
  resource: SessionSandboxResource;
}

export interface NodeSessionSandboxLifecycleOptions {
  store: SessionSandboxBindingPort;
  provider: string;
  providerNamespace?: string;
  ownerId: string;
  allocationIsolation: boolean;
  /** Must come from the factory's explicit declaration, never RPC probing. */
  runtimeBindingSupported?: boolean;
  now?: () => Date;
  id?: () => string;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  maxCasRetries?: number;
  isAvailable?(resource: SessionSandboxResource): Promise<boolean>;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Grace period for owned resource work before shutdown aborts local waits. */
  drainTimeoutMs?: number;
  renewProviderLease?(resource: SessionSandboxResource, ttlMs: number, signal: AbortSignal): Promise<void>;
  reaper?: {
    /** Resolve the original configuration from this durable descriptor. Do not
     * substitute the current Session configuration if its fingerprint differs. */
    resume(resource: SessionSandboxResource, signal: AbortSignal): Promise<SandboxExecutor>;
    handle?(sandbox: SandboxExecutor): SessionSandboxHandle;
  };
}

interface Management {
  readonly signal: AbortSignal;
  readonly fence: SessionSandboxManagementFence;
  readonly resource: SessionSandboxResource;
  write(operation: (input: SessionSandboxMutation) => Promise<SessionSandboxMutationResult>): Promise<SessionSandboxResource>;
  isCurrent(): Promise<boolean>;
}

function scopeKey(scope: SessionSandboxScope): string {
  return JSON.stringify([scope.workspaceId, scope.sessionId]);
}
function matchesUse(resource: SessionSandboxResource, fence: SessionExecutionFence): boolean {
  return resource.use?.executionId === fence.executionId && resource.use.attemptId === fence.attemptId
    && resource.use.ownerId === fence.ownerId && resource.use.generation === fence.generation;
}
function sameHandle(a: SessionSandboxHandle, b: SessionSandboxHandle): boolean {
  return a.provider === b.provider && a.runtimeId === b.runtimeId;
}
function error(code: NodeSessionSandboxLifecycleErrorCode, message: string): NodeSessionSandboxLifecycleError {
  return new NodeSessionSandboxLifecycleError(code, message);
}
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function onlyWait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Session-owned sandbox lifecycle. All correctness comes from the durable
 * binding and CAS operations; these SDK objects and promises are disposable.
 * There is no execution scheduler or second execution lease in this service. */
export class NodeSessionSandboxLifecycle {
  private readonly store: SessionSandboxBindingPort;
  private readonly namespace: string;
  private readonly now: () => Date;
  private readonly nextId: () => string;
  private readonly ttl: number;
  private readonly renewalMs: number;
  private readonly retries: number;
  private readonly opening = new Map<string, { fingerprint: string; promise: Promise<OpenedNodeSessionSandbox> }>();
  private readonly managing = new Set<Promise<unknown>>();
  private readonly managementControllers = new Set<AbortController>();
  private readonly shutdown = new AbortController();
  private accepting = true;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: NodeSessionSandboxLifecycleOptions) {
    // Database disposal may immediately follow close(). Block calls from late
    // continuations of a provider operation that ignored its aborted signal.
    const call = <T>(operation: () => Promise<T>): Promise<T> => {
      this.shutdown.signal.throwIfAborted();
      return operation();
    };
    this.store = {
      closeSession: input => call(() => options.store.closeSession(input)),
      getCurrent: input => call(() => options.store.getCurrent(input)),
      find: input => call(() => options.store.find(input)),
      list: input => call(() => options.store.list(input)),
      listPending: input => call(() => options.store.listPending(input)),
      createIntent: input => call(() => options.store.createIntent(input)),
      claimManagement: input => call(() => options.store.claimManagement(input)),
      renewManagement: input => call(() => options.store.renewManagement(input)),
      releaseManagement: input => call(() => options.store.releaseManagement(input)),
      recordHandle: input => call(() => options.store.recordHandle(input)),
      markReady: input => call(() => options.store.markReady(input)),
      retire: input => call(() => options.store.retire(input)),
      beginDelete: input => call(() => options.store.beginDelete(input)),
      markDeleted: input => call(() => options.store.markDeleted(input)),
      recordFailure: input => call(() => options.store.recordFailure(input)),
      claimUse: input => call(() => options.store.claimUse(input)),
      releaseUse: input => call(() => options.store.releaseUse(input)),
      markUseUnknown: input => call(() => options.store.markUseUnknown(input)),
    };
    this.namespace = options.providerNamespace ?? options.provider;
    this.now = options.now ?? (() => new Date());
    this.nextId = options.id ?? randomUUID;
    this.ttl = options.leaseTtlMs ?? 30_000;
    this.renewalMs = options.renewIntervalMs ?? Math.max(1, Math.floor(this.ttl / 3));
    this.retries = options.maxCasRetries ?? 8;
    if (!Number.isSafeInteger(this.ttl) || this.ttl <= 0 || this.renewalMs <= 0 || this.renewalMs >= this.ttl) {
      throw new Error("Sandbox management renewal must be positive and shorter than its lease TTL");
    }
    if (!Number.isSafeInteger(options.drainTimeoutMs ?? 5_000) || (options.drainTimeoutMs ?? 5_000) < 0) {
      throw new Error("Sandbox shutdown drain timeout must be a nonnegative integer");
    }
  }

  /** Connection status only; this snapshot grants no permission to use the SDK. */
  async describe(scope: SessionSandboxScope): Promise<SessionSandboxResource | null> {
    this.requireAccepting();
    return (await this.store.getCurrent(scope))?.resource ?? null;
  }

  async open(input: OpenNodeSessionSandbox): Promise<OpenedNodeSessionSandbox> {
    this.requireAccepting();
    this.requireSupport();
    // Even coalesced/cache hits first consult the authoritative pointer.
    const current = await this.store.getCurrent(input.scope);
    this.requireAccepting();
    if (current?.binding.closed) throw error("not_ready", "Session sandbox resources have been permanently retired");
    if (current?.resource) this.checkConfiguration(current.resource);
    const key = scopeKey(input.scope);
    const existing = this.opening.get(key);
    if (existing && existing.fingerprint !== input.configFingerprint) {
      throw error("configuration_changed", "Another sandbox configuration is being prepared for this Session");
    }
    const promise = existing?.promise ?? this.openManaged(input);
    if (!existing) {
      this.opening.set(key, { fingerprint: input.configFingerprint, promise });
      void promise.finally(() => {
        if (this.opening.get(key)?.promise === promise) this.opening.delete(key);
      }).catch(() => {});
    }
    const opened = await onlyWait(promise, input.waitSignal);
    const final = await this.store.getCurrent(input.scope);
    if (!final?.resource || final.binding.allocationId !== opened.allocationId) {
      throw error("conflict", "Session sandbox changed while waiting for readiness");
    }
    this.checkConfiguration(final.resource, input.configFingerprint);
    this.requireReady(final.resource);
    return { ...opened, resource: final.resource };
  }

  private async openManaged(input: OpenNodeSessionSandbox): Promise<OpenedNodeSessionSandbox> {
    const deadline = Date.now() + (this.options.waitTimeoutMs ?? 60_000);
    for (;;) {
      const snapshot = await this.store.getCurrent(input.scope);
      if (snapshot?.binding.closed) throw error("not_ready", "Session sandbox resources have been permanently retired");
      const resource = snapshot?.resource;
      if (!resource) {
        const inventory = await this.store.list(input.scope);
        const unresolved = inventory.find(value => value.handle === null && value.observedState !== "deleted");
        if (unresolved) {
          throw error("unknown_create", unresolved.failure ?? "An earlier sandbox allocation still has an unknown creation result; reconcile it before allocating another");
        }
        const intent = await this.store.createIntent({
          ...input.scope, allocationId: this.nextId(), provider: this.options.provider,
          providerNamespace: this.namespace, configFingerprint: input.configFingerprint,
          expectedBindingRevision: snapshot?.binding.revision ?? null,
          ownerId: this.options.ownerId, now: this.timestamp(), leaseTtlMs: this.ttl,
        });
        if (intent.type === "conflict") { await this.poll(deadline); continue; }
        const sandbox = await this.manage(intent.resource, intent.fence, "provision", async management => {
          const created = await input.create(intent.resource.allocationId, management.signal);
          management.signal.throwIfAborted();
          const handle = this.validateHandle(input.handle(created));
          await management.write(mutation => this.store.recordHandle({ ...mutation, handle }));
          // Durable registration precedes any package, checkpoint or file preparation.
          await input.prepare(created, intent.resource.allocationId, management.signal, {
            fresh: true, fence: management.fence, isCurrent: () => management.isCurrent(),
          });
          management.signal.throwIfAborted();
          await management.write(mutation => this.store.markReady(mutation));
          return created;
        });
        return { sandbox, allocationId: intent.resource.allocationId, resource: intent.resource };
      }
      this.checkConfiguration(resource);
      if (resource.use !== null) throw error("use_conflict", "Sandbox still has an active or unresolved execution use");
      if (this.managementActive(resource)) { await this.poll(deadline); continue; }
      if (resource.configFingerprint !== input.configFingerprint && resource.management.ownerId === null
        && resource.handle !== null && resource.observedState === "ready"
        && resource.readiness === "prepared" && resource.failure === null) {
        // Config changes within one provider/account rotate physical allocations.
        // The retired resource stays in inventory and cannot become current again.
        try { await this.retire({ ...input.scope, allocationId: resource.allocationId }); }
        catch (failure) {
          if (!(failure instanceof NodeSessionSandboxLifecycleError) || !["conflict", "busy"].includes(failure.code)) throw failure;
          await this.poll(deadline);
        }
        continue;
      }
      const claimed = await this.store.claimManagement({
        ...input.scope, allocationId: resource.allocationId, expectedRevision: resource.revision,
        ownerId: this.options.ownerId, now: this.timestamp(), leaseTtlMs: this.ttl,
      });
      if (claimed.type === "conflict") { await this.poll(deadline); continue; }
      const sandbox = await this.manage(claimed.resource, claimed.fence, "rebind", async management => {
        // Expired management may still have an in-flight provider operation.
        // Merely obtaining its lease is not proof that those effects drained.
        if (resource.handle === null) throw error("unknown_create", resource.failure ?? "Sandbox creation has an unknown result; reconcile this allocation before retrying");
        if (resource.management.ownerId !== null || resource.observedState !== "ready"
          || resource.readiness !== "prepared" || resource.failure !== null) {
          throw error("unknown_management", resource.failure ?? "Sandbox preparation or prior management did not finish; this allocation requires reconciliation");
        }
        await management.write(mutation => this.store.recordFailure({
          ...mutation, failure: "Sandbox rebind_in_progress; an expired manager does not prove this operation drained",
        }));
        const resumed = await input.resume(resource.handle, resource.allocationId, management.signal, resource);
        management.signal.throwIfAborted();
        if (!sameHandle(this.validateHandle(input.handle(resumed)), resource.handle)) {
          throw error("handle_mismatch", "Sandbox resume returned a different physical resource");
        }
        // Existing workspace files are canonical. Only rehydrate this client's
        // transient configuration; do not repeat initial workspace restoration.
        await input.prepare(resumed, resource.allocationId, management.signal, {
          fresh: false, fence: management.fence, isCurrent: () => management.isCurrent(),
        });
        management.signal.throwIfAborted();
        await management.write(mutation => this.store.markReady(mutation));
        return resumed;
      });
      return { sandbox, allocationId: resource.allocationId, resource };
    }
  }

  /** Resource-worker operation. It is independent of execution use and must
   * never resolve a missing handle by allocating another sandbox. */
  async renewProviderLease(resource: SessionSandboxResource, ttlMs: number, signal: AbortSignal): Promise<void> {
    this.requireAccepting();
    signal.throwIfAborted();
    const current = await this.store.find(resource);
    if (!current || current.desiredState !== "active" || current.observedState !== "ready" || !current.handle) return;
    if (!this.options.renewProviderLease) throw error("unsupported", "Provider has no handle-based lease renewal operation");
    await this.options.renewProviderLease(current, ttlMs, signal);
  }

  async borrow(input: { executionFence: SessionExecutionFence; allocationId: string }): Promise<SessionSandboxResource> {
    this.requireAccepting();
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const snapshot = await this.store.getCurrent(input.executionFence);
      const resource = snapshot?.resource;
      if (!resource || resource.allocationId !== input.allocationId) throw error("conflict", "Sandbox allocation is no longer current");
      this.requireReady(resource, input.executionFence);
      if (this.options.isAvailable && !await this.options.isAvailable(resource)) throw error("not_ready", "Sandbox is currently unavailable");
      const result = await this.store.claimUse({
        fence: input.executionFence, allocationId: input.allocationId,
        expectedRevision: resource.revision, now: this.timestamp(),
      });
      if (result.type === "updated") return result.resource;
    }
    throw error("use_conflict", "Sandbox use could not be claimed under the canonical execution lease");
  }

  async release(input: { executionFence: SessionExecutionFence; allocationId: string; unknown: boolean }): Promise<SessionSandboxResource> {
    this.requireAccepting();
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const resource = await this.store.find({ ...input.executionFence, allocationId: input.allocationId });
      if (!resource) throw error("resource_missing", "Sandbox allocation no longer exists in the inventory");
      if (resource.use === null) {
        if (input.unknown) throw error("use_conflict", "Cannot record an uncertain operation after its sandbox use was released");
        return resource;
      }
      if (!matchesUse(resource, input.executionFence)) throw error("use_conflict", "A stale execution cannot release another sandbox user");
      if (input.unknown && resource.useOutcome === "unknown") return resource;
      const mutation = { fence: input.executionFence, allocationId: input.allocationId, expectedRevision: resource.revision, now: this.timestamp() };
      const result = input.unknown ? await this.store.markUseUnknown(mutation) : await this.store.releaseUse(mutation);
      if (result.type === "updated") return result.resource;
    }
    throw error("use_conflict", "Sandbox use release conflicted repeatedly; the durable holder remains protected");
  }

  /** Authenticated Session file APIs have resource authority, not an execution
   * lease. Serialize the entire provider operation with preparation and use;
   * returning a cached SDK object to the caller would bypass that boundary. */
  async operate<T>(
    input: { scope: SessionSandboxScope; allocationId: string },
    operation: (sandbox: SandboxExecutor, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requireAccepting();
    this.requireSupport();
    const snapshot = await this.store.getCurrent(input.scope);
    const resource = snapshot?.resource;
    if (!resource || resource.allocationId !== input.allocationId) {
      throw error("conflict", "Session file operation refers to a sandbox that is no longer current");
    }
    this.checkConfiguration(resource);
    this.requireReady(resource);
    const claim = await this.claim(resource);
    return this.manage(claim.resource, claim.fence, "operate", async management => {
      await management.write(mutation => this.store.recordFailure({
        ...mutation, failure: "Sandbox operation_in_progress; its provider effect must finish before execution can borrow it",
      }));
      if (!this.options.reaper) throw error("unsupported", "No resolver is configured to reopen this Session's sandbox");
      const sandbox = await this.options.reaper.resume(resource, management.signal);
      management.signal.throwIfAborted();
      if (this.options.reaper?.handle && !sameHandle(this.validateHandle(this.options.reaper.handle(sandbox)), resource.handle!)) {
        throw error("handle_mismatch", "Session file operation resolved a different physical sandbox");
      }
      const result = await operation(withSandboxExecutionGuard(sandbox, { signal: management.signal }), management.signal);
      management.signal.throwIfAborted();
      await management.write(mutation => this.store.markReady(mutation));
      return result;
    });
  }

  /** Irrevocable detach, separate from releasing a client or an execution use. */
  async retire(input: SessionSandboxScope & { allocationId: string }): Promise<SessionSandboxResource> {
    this.requireAccepting();
    const resource = await this.requireResource(input);
    if (resource.observedState === "deleted" || resource.desiredState === "retired") return resource;
    if (resource.handle === null) throw error("unknown_create", "Cannot retire an unresolved creation intent without identifying or confirming absence of its provider resource");
    if (resource.use !== null) throw error("use_conflict", "Cannot retire a sandbox while execution operations may still be running");
    const claim = await this.claim(resource);
    await this.manage(claim.resource, claim.fence, "retire", async management => {
      await management.write(mutation => this.store.retire(mutation));
    });
    return this.requireResource(input);
  }

  /** Archive/delete closes the Session resource namespace permanently. This
   * never clears a live/unknown use or treats cancellation as physical drain. */
  async closeSession(scope: SessionSandboxScope): Promise<void> {
    this.requireAccepting();
    await this.store.closeSession({ ...scope, now: this.timestamp() });
  }

  async reap(input: SessionSandboxScope & {
    allocationId: string;
    resume?: ResumeSandbox;
    handle?(sandbox: SandboxExecutor): SessionSandboxHandle;
  }): Promise<SessionSandboxResource> {
    this.requireAccepting();
    const resource = await this.requireResource(input);
    if (resource.observedState === "deleted") return resource;
    if (resource.desiredState !== "retired") throw error("not_ready", "Only an irrevocably retired sandbox may be deleted");
    if (!this.options.allocationIsolation) throw error("unsupported", "Sandbox deletion requires independent physical allocations");
    if (resource.use !== null) throw error("use_conflict", "Sandbox still has an unresolved execution use");
    const claim = await this.claim(resource);
    await this.manage(claim.resource, claim.fence, "reap", async management => {
      if (!resource.handle) throw error("unknown_create", "Retired sandbox has an unknown creation result; deletion cannot be confirmed");
      const resume = input.resume ?? (this.options.reaper
        ? (_handle: SessionSandboxHandle, _allocation: string, signal: AbortSignal, descriptor: SessionSandboxResource) => this.options.reaper!.resume(descriptor, signal)
        : undefined);
      if (!resume) throw error("cleanup_unavailable", "No resolver is configured for the retired sandbox's original provider configuration");
      await management.write(mutation => this.store.beginDelete(mutation));
      const sandbox = await resume(resource.handle, resource.allocationId, management.signal, resource);
      management.signal.throwIfAborted();
      const identify = input.handle ?? this.options.reaper?.handle;
      if (identify && !sameHandle(this.validateHandle(identify(sandbox)), resource.handle)) {
        throw error("handle_mismatch", "Cleanup resolver returned a different physical resource");
      }
      if (!sandbox.destroy) throw error("cleanup_unavailable", "Sandbox does not support confirmed physical deletion");
      await sandbox.destroy();
      management.signal.throwIfAborted();
      await management.write(mutation => this.store.markDeleted(mutation));
    });
    return this.requireResource(input);
  }

  /** Inventory scanning survives process restarts. Each result still has to
   * acquire its own management claim; a list result is never deletion authority. */
  async reconcile(input: {
    scope?: SessionSandboxScope;
    limit?: number;
    resume?: ResumeSandbox;
    handle?(sandbox: SandboxExecutor): SessionSandboxHandle;
  } = {}): Promise<Array<{ allocationId: string; deleted: boolean; error?: unknown }>> {
    this.requireAccepting();
    const resources = input.scope
      ? await this.store.list(input.scope)
      : await this.store.listPending({ now: this.timestamp(), limit: input.limit,
        purpose: "delete", provider: this.options.provider, providerNamespace: this.namespace });
    const results: Array<{ allocationId: string; deleted: boolean; error?: unknown }> = [];
    for (const resource of resources) {
      if (resource.desiredState !== "retired" || resource.provider !== this.options.provider
        || resource.providerNamespace !== this.namespace || resource.use !== null
        || this.managementActive(resource) || (resource.retryAt !== null && Date.parse(resource.retryAt) > this.now().getTime())) continue;
      try {
        const reaped = await this.reap({ ...resource, resume: input.resume, handle: input.handle });
        results.push({ allocationId: resource.allocationId, deleted: reaped.observedState === "deleted" });
      } catch (failure) {
        results.push({ allocationId: resource.allocationId, deleted: false, error: failure });
      }
    }
    return results;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = this.drain();
    return this.closing;
  }

  private async drain(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = () => [...this.managing, ...Array.from(this.opening.values(), value => value.promise)];
    const settled = async () => {
      for (let work = pending(); work.length > 0; work = pending()) await Promise.allSettled(work);
    };
    try {
      await Promise.race([
        settled(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.drainTimeoutMs ?? 5_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      const reason = error("closed", "Sandbox lifecycle is closed; unfinished provider outcomes remain protected in durable inventory");
      this.shutdown.abort(reason);
      for (const controller of this.managementControllers) controller.abort(reason);
      // Aborted local waits normally settle immediately. A driver already
      // inside an uninterruptible call must not make shutdown wait forever.
      await Promise.race([settled(), wait(0)]);
    }
  }

  private requireAccepting(): void {
    if (!this.accepting) throw error("closed", "Sandbox lifecycle is closing and cannot accept new operations");
  }

  private requireSupport(): void {
    if (this.options.runtimeBindingSupported !== true || !this.options.allocationIsolation) {
      throw error("unsupported", `Sandbox provider ${this.options.provider} must explicitly support durable rebinding and independent allocations`);
    }
  }
  private checkConfiguration(resource: SessionSandboxResource, fingerprint?: string): void {
    if (resource.provider !== this.options.provider || resource.providerNamespace !== this.namespace
      || (fingerprint !== undefined && resource.configFingerprint !== fingerprint)) {
      throw error("configuration_changed", "Sandbox provider configuration differs from its persisted binding; retire or reconcile the original allocation first");
    }
    if (resource.desiredState !== "active") throw error("not_ready", "Session sandbox allocation is retired");
  }
  private requireReady(resource: SessionSandboxResource, sameUser?: SessionExecutionFence): void {
    if (resource.desiredState !== "active" || resource.observedState !== "ready"
      || resource.readiness !== "prepared" || !resource.handle || resource.failure !== null) {
      throw error("not_ready", "Sandbox has not completed durable preparation");
    }
    if (resource.management.ownerId !== null) throw error("busy", "Sandbox resource management is still in progress");
    if (resource.use !== null && (!sameUser || !matchesUse(resource, sameUser) || resource.useOutcome !== "active")) {
      throw error("use_conflict", "Sandbox has an active or unresolved execution use");
    }
  }
  private validateHandle(handle: SessionSandboxHandle): SessionSandboxHandle {
    if (handle.provider !== this.options.provider || !handle.runtimeId) throw error("handle_mismatch", "Sandbox factory returned an incompatible physical resource handle");
    return JSON.parse(JSON.stringify(handle)) as SessionSandboxHandle;
  }
  private managementActive(resource: SessionSandboxResource): boolean {
    return resource.management.ownerId !== null && resource.management.leaseExpiresAt !== null
      && Date.parse(resource.management.leaseExpiresAt) > this.now().getTime();
  }
  private timestamp(): string { return this.now().toISOString(); }
  private async poll(deadline: number): Promise<void> {
    this.shutdown.signal.throwIfAborted();
    if (Date.now() >= deadline) throw error("busy", "Timed out waiting for Session sandbox resource management");
    await wait(this.options.pollIntervalMs ?? 50);
    this.shutdown.signal.throwIfAborted();
  }
  private async requireResource(input: SessionSandboxScope & { allocationId: string }): Promise<SessionSandboxResource> {
    const resource = await this.store.find(input);
    if (!resource) throw error("resource_missing", "Sandbox allocation was not found in durable inventory");
    if (resource.provider !== this.options.provider || resource.providerNamespace !== this.namespace) {
      throw error("configuration_changed", "Sandbox allocation belongs to another provider configuration");
    }
    return resource;
  }
  private async claim(resource: SessionSandboxResource) {
    if (this.managementActive(resource)) throw error("busy", "Sandbox resource management is already claimed");
    const claimed = await this.store.claimManagement({
      ...resource, expectedRevision: resource.revision, ownerId: this.options.ownerId,
      now: this.timestamp(), leaseTtlMs: this.ttl,
    });
    if (claimed.type === "conflict") throw error("conflict", "Sandbox resource changed before management could be claimed");
    return claimed;
  }

  private manage<T>(
    initial: SessionSandboxResource,
    initialFence: SessionSandboxManagementFence,
    operation: "provision" | "rebind" | "operate" | "retire" | "reap",
    action: (management: Management) => Promise<T>,
  ): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    const promise = this.manageOwned(initial, initialFence, operation, action);
    this.managing.add(promise);
    void promise.finally(() => this.managing.delete(promise)).catch(() => {});
    return promise;
  }

  private async manageOwned<T>(
    initial: SessionSandboxResource,
    initialFence: SessionSandboxManagementFence,
    operation: "provision" | "rebind" | "operate" | "retire" | "reap",
    action: (management: Management) => Promise<T>,
  ): Promise<T> {
    let resource = initial;
    let fence: SessionSandboxManagementFence | null = initialFence;
    let sequence = Promise.resolve();
    let running = true;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    this.managementControllers.add(controller);
    const lost = () => error("management_lost", "Sandbox resource management lease was lost; its operation outcome must be reconciled");
    const assertLive = () => {
      controller.signal.throwIfAborted();
      if (!fence || Date.parse(fence.expiresAt) <= this.now().getTime()) throw lost();
    };
    const serial = <R>(fn: () => Promise<R>): Promise<R> => {
      const result = sequence.then(fn);
      sequence = result.then(() => {}, () => {});
      return result;
    };
    const armExpiry = () => {
      clearTimeout(expiry);
      if (!fence) return;
      expiry = setTimeout(() => controller.abort(lost()), Math.max(1, Date.parse(fence.expiresAt) - this.now().getTime()));
      expiry.unref?.();
    };
    const accept = (result: SessionSandboxMutationResult) => {
      if (result.type === "conflict") throw lost();
      resource = result.resource;
      if (result.fence) { Object.assign(initialFence, result.fence); fence = initialFence; }
      else fence = null;
      armExpiry();
      return resource;
    };
    const management: Management = {
      signal: controller.signal,
      get fence() { return initialFence; },
      get resource() { return resource; },
      write: mutation => serial(async () => {
        assertLive();
        return accept(await mutation({ fence: fence!, expectedRevision: resource.revision, now: this.timestamp() }));
      }),
      isCurrent: async () => {
        try {
          assertLive();
          const current = await this.store.getCurrent(initial);
          const value = current?.resource;
          return !!value && current?.binding.allocationId === initial.allocationId
            && value.desiredState === "active" && value.use === null
            && value.management.ownerId === fence?.ownerId && value.management.generation === fence?.generation
            && this.managementActive(value) && !controller.signal.aborted;
        } catch { return false; }
      },
    };
    const renew = () => {
      if (!running || !fence) return;
      heartbeat = setTimeout(() => {
        void serial(async () => {
          if (!running || !fence) return;
          assertLive();
          accept(await this.store.renewManagement({ fence, now: this.timestamp(), leaseTtlMs: this.ttl }));
        }).then(renew, failure => controller.abort(new NodeSessionSandboxLifecycleError(
          "management_lost", "Sandbox resource management renewal failed; its operation outcome must be reconciled", { cause: failure },
        )));
      }, this.renewalMs);
      heartbeat.unref?.();
    };
    armExpiry();
    renew();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    let failed = false;
    try {
      return await Promise.race([action(management), aborted]);
    } catch (failure) {
      failed = true;
      if (!controller.signal.aborted && fence) {
        await management.write(mutation => this.store.recordFailure({
          ...mutation,
          failure: failure instanceof NodeSessionSandboxLifecycleError ? failure.message
            : `Sandbox ${operation} did not complete; its provider outcome requires reconciliation${failure instanceof Error ? `: ${failure.message}` : ""}`,
          lost: ["provision", "rebind", "operate"].includes(operation) && resource.handle !== null,
          retryAt: operation === "reap" ? new Date(this.now().getTime() + this.ttl).toISOString() : null,
        })).catch(() => {});
      }
      throw failure;
    } finally {
      running = false;
      clearTimeout(heartbeat);
      clearTimeout(expiry);
      try {
        if (fence && !controller.signal.aborted) {
          try { await management.write(mutation => this.store.releaseManagement(mutation)); }
          catch (failure) { if (!failed) throw failure; }
        }
      } finally {
        clearTimeout(expiry);
        controller.abort(lost());
        this.managementControllers.delete(controller);
      }
    }
  }
}
