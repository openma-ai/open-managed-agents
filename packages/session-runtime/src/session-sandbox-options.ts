// What a host composes the Session sandbox core from
// (research/sandbox-sdk-v2-design.md §0.0 rule 15, §0.1): the Sandbox SDK v2
// Ports, its view of a runtime, the handle record, the scope and plan, and
// the execution fence and idle timer. Shared by the Cloudflare SessionDO and
// the Node Session runner.

import type {
  Acquired,
  MemoryStoreBinding,
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessSpec,
  SandboxExecutor,
  SandboxPlan,
  SandboxPorts,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { SessionSandboxState, SnapshotRef } from "./session-sandbox-state";

/** What a Session host calls on a sandbox runtime. */
export type SessionSandboxExecutor = Pick<SandboxExecutor, "exec" | "readFile" | "writeFile"> & {
  startProcess(command: string): Promise<ProcessHandle | null>;
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<string>;
  setEnvVars(env: Record<string, string>): Promise<void>;
};

/** A Session execution attempt (managed_session_executions): the one fence
 * (design §0.0 rule 10). */
export interface SessionSandboxExecution {
  executionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  /** Lease expiry (ISO); absent = not carried. */
  expiresAt?: string;
}

/** The host's idle timer (CF: a DO alarm; Node: a process timer). */
export interface SessionSandboxIdleTimer {
  /** idlePauseMs (design §0.0 rule 11). */
  pauseMs: number;
  /** Call idlePause() once, `delayMs` from now, replacing a pending one. */
  schedule(delayMs: number, version?: number): void | Promise<void>;
  cancel(): void | Promise<void>;
}

/** The environment cache for this Session (session-sandbox-environment-cache). */
export interface SessionEnvironmentCache<R> {
  /** Replaces sandbox.acquire: from the environment snapshot, else the image. */
  acquire(input: { scope: RuntimeResourceScope; plan: SandboxPlan; signal: AbortSignal }): Promise<Acquired<R> | "gone">;
  /** The Session's own setup succeeded: its snapshot may now be built. */
  prepared(scope: RuntimeResourceScope): void;
}

export interface PortsSessionSandboxOptions<R> {
  compose(): Promise<{ ports: SandboxPorts<R> }>;
  /** The host's view of a runtime (exec output in the `exit=N\n...` shape). */
  executor(runtime: R): SessionSandboxExecutor;
  state: {
    load(): Promise<SessionSandboxState | undefined>;
    /** Atomic compare-and-set (design §0.0b A.10): stores `state` (its
     * version is `expected` + 1) only when the stored version (no record = 0)
     * is still `expected`; false = another writer got there first and nothing
     * was written. */
    save(state: SessionSandboxState, expected: number): Promise<boolean>;
  };
  scope(): RuntimeResourceScope;
  /** `stores`: stores already mounted through this runtime. */
  plan(input: { scope: RuntimeResourceScope; generation: string; stores: MemoryStoreBinding[] }): Promise<SandboxPlan>;
  /** The latest snapshot the host publishes itself (Cloudflare: D1
   * workspace_backups, where its snapshots are recorded too); preferred over
   * the record's latestSnapshot. null = only the record's. */
  resumeRef(): Promise<SnapshotRef | null>;
  /** Snapshot in a tool-call gap at most this often, and only when a call
   * ran since the last one (default SNAPSHOT_INTERVAL_MS). Every execution
   * end and idle pause also snapshots a changed sandbox. */
  snapshotIntervalMs?: number;
  /** Lifecycle progress (snapshots, restores); not a warning. Omitted = dropped. */
  info?(message: string): void;
  /** A host that records this in the event log uses sessionSandboxWarningEvent (./session-warning). */
  warn(message: string): void | Promise<void>;
  outputDurability(): { durability: "durable" | "best_effort" } | null;
  /** egress.attach again this often at exec boundaries (an expiring
   * credential in the egress, e.g. the E2B relay pass); null = never. */
  egressRenewMs: number | null;
  now?(): number;
  /** The Session execution attempt this owner runs; undefined between
   * executions. Every Port call carries it as the fence, and egress.attach
   * runs again at the next exec boundary when it changes. Omitted =
   * SessionDO's single-writer placeholder fence. */
  execution?(): SessionSandboxExecution | undefined;
  /** Whether `execution` (undefined = the owner between executions) still
   * holds the Session (design §0.0 rule 10); checked before pause and
   * before a new "changes" handle is recorded. Default: always. */
  isCurrent?(execution: SessionSandboxExecution | undefined): Promise<boolean>;
  /** Idle pause (design §0.0 rule 11). Omitted = never pauses. */
  idle?: SessionSandboxIdleTimer;
  /** sandbox.keepAlive this often at exec boundaries (design §0.1 step 5,
   * a provider lease); null or omitted = never (Cloudflare: the alarm
   * calls renewActivityTimeout). */
  keepAliveMs?: number | null;
  /** Omitted = every acquire starts from the plan's image. */
  environmentCache?: SessionEnvironmentCache<R>;
}
