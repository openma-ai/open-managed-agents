import type { SessionExecutionFence } from "./coordination";

export interface SessionSandboxScope {
  workspaceId: string;
  sessionId: string;
}

/** JSON-only identity. Configuration references and routing metadata must never
 * contain credentials. The provider resolves credentials at the boundary. */
export interface SessionSandboxHandle {
  provider: string;
  runtimeId: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SessionSandboxBinding extends SessionSandboxScope {
  allocationId: string | null;
  revision: number;
  /** Terminal Session retirement. Late provisioning may never recreate it. */
  closed: boolean;
}

/** Resource-management authority only; never permission to run a harness/tool. */
export interface SessionSandboxManagementFence extends SessionSandboxScope {
  allocationId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
}

/** Reference to the one canonical execution authority, not a second lease.
 * Expiry of that execution does not prove its provider operations have drained. */
export type SessionSandboxUse = Pick<
  SessionExecutionFence,
  "executionId" | "attemptId" | "ownerId" | "generation"
>;

export interface SessionSandboxResource extends SessionSandboxScope {
  /** Immutable incarnation and provider create/recovery idempotency key. */
  allocationId: string;
  provider: string;
  /** Stable non-secret provider account/endpoint/configuration namespace.
   * Defaulting to provider assumes one such namespace per workspace/provider. */
  providerNamespace: string;
  handle: SessionSandboxHandle | null;
  configFingerprint: string;
  desiredState: "active" | "retired";
  observedState: "intent" | "allocated" | "ready" | "lost" | "deleting" | "deleted";
  readiness: "none" | "created" | "prepared";
  management: {
    ownerId: string | null;
    generation: number;
    leaseExpiresAt: string | null;
  };
  use: SessionSandboxUse | null;
  useOutcome: "active" | "unknown" | null;
  failure: string | null;
  retryAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface SessionSandboxBindingSnapshot {
  binding: SessionSandboxBinding;
  resource: SessionSandboxResource | null;
}

export interface SessionSandboxMutation {
  fence: SessionSandboxManagementFence;
  expectedRevision: number;
  now: string;
}

export type SessionSandboxMutationResult =
  | {
      type: "updated";
      resource: SessionSandboxResource;
      fence: SessionSandboxManagementFence | null;
    }
  | { type: "conflict" };

export type SessionSandboxClaimResult =
  | {
      type: "claimed";
      resource: SessionSandboxResource;
      fence: SessionSandboxManagementFence;
    }
  | { type: "conflict" };

export interface SessionSandboxUseMutation {
  fence: SessionExecutionFence;
  allocationId: string;
  expectedRevision: number;
  now: string;
}

export interface SessionSandboxBindingPort {
  /** Session lifecycle authority (archive/delete), not an attempt cleanup.
   * Keeps all outstanding uses; physical deletion must still wait for drain. */
  closeSession(input: SessionSandboxScope & { now: string }): Promise<void>;
  getCurrent(scope: SessionSandboxScope): Promise<SessionSandboxBindingSnapshot | null>;
  find(input: SessionSandboxScope & { allocationId: string }): Promise<SessionSandboxResource | null>;
  /** Includes unresolved allocation intents and retired resources. A current
   * pointer never replaces the inventory needed to recover/reap old resources. */
  list(input: SessionSandboxScope & { includeDeleted?: boolean }): Promise<SessionSandboxResource[]>;
  /** Durable work discovery across restarts. Returns due retired resources and
   * incomplete intents, excluding held/unknown uses and active ready resources.
   * Delete scans select only retired rows with a known handle. Purpose and
   * provider filters apply before LIMIT so unrelated/unknown work cannot starve cleanup.
   * A scan grants no authority: the manager must claim and reconcile each row. */
  listPending(input: {
    now: string;
    limit?: number;
    workspaceId?: string;
    provider?: string;
    providerNamespace?: string;
    purpose?: "reconcile" | "delete";
  }): Promise<SessionSandboxResource[]>;
  /** Persist BEFORE calling provider create. A lost create response must be
   * reconciled by allocationId through provider lookup/idempotency/reliable TTL;
   * an empty handle is never evidence that no physical resource exists. */
  createIntent(input: SessionSandboxScope & {
    allocationId: string;
    provider: string;
    providerNamespace?: string;
    configFingerprint: string;
    expectedBindingRevision: number | null;
    ownerId: string;
    now: string;
    leaseTtlMs: number;
  }): Promise<
    | {
        type: "created";
        binding: SessionSandboxBinding;
        resource: SessionSandboxResource;
        fence: SessionSandboxManagementFence;
      }
    | { type: "conflict" }
  >;
  /** Exclusive resource mutation: cannot be claimed while any use is held.
   * Provider TTL heartbeats are separate from this database management lease. */
  claimManagement(input: SessionSandboxScope & {
    allocationId: string;
    expectedRevision: number;
    ownerId: string;
    now: string;
    leaseTtlMs: number;
  }): Promise<SessionSandboxClaimResult>;
  renewManagement(input: {
    fence: SessionSandboxManagementFence;
    now: string;
    leaseTtlMs: number;
  }): Promise<SessionSandboxMutationResult>;
  releaseManagement(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult>;
  recordHandle(input: SessionSandboxMutation & { handle: SessionSandboxHandle }): Promise<SessionSandboxMutationResult>;
  markReady(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult>;
  /** Atomically detaches the current pointer and irrevocably retires this
   * incarnation. Never clears a different/newer current allocation. */
  retire(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult>;
  /** Durable authorization for cleanup of this retired incarnation. Provider
   * deletion still needs incarnation isolation/fencing at its effect boundary. */
  beginDelete(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult>;
  /** Only after provider confirms deletion/absence (or an authoritative TTL).
   * Unknown create/delete outcomes must remain discoverable for reconciliation. */
  markDeleted(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult>;
  recordFailure(input: SessionSandboxMutation & {
    failure: string;
    retryAt?: string | null;
    lost?: boolean;
  }): Promise<SessionSandboxMutationResult>;
  /** Atomically checks the canonical execution lease and current ready binding.
   * Requires management to have been explicitly released, even if it expired.
   * Never steals an old use, including one whose execution lease has expired. */
  claimUse(input: SessionSandboxUseMutation): Promise<SessionSandboxMutationResult>;
  /** Caller must have confirmed all operations from this exact use drained.
   * Expiry, cancellation, disconnection, or a read-only ownership check is not
   * that confirmation. A late release cannot clear a different holder. */
  releaseUse(input: SessionSandboxUseMutation): Promise<SessionSandboxMutationResult>;
  /** Preserves the holder after an uncertain provider effect. Even the same
   * attempt cannot re-claim an unknown use until its operations are resolved. */
  markUseUnknown(input: SessionSandboxUseMutation): Promise<SessionSandboxMutationResult>;
}
