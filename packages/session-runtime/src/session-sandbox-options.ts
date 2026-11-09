// What a host composes the Session sandbox core from
// (research/sandbox-sdk-v2-design.md §0.0 rule 15, §0.1): the Sandbox SDK v2
// Ports, its view of a runtime, the handle record, the scope and plan, and
// the execution fence and idle timer. Shared by the Cloudflare SessionDO and
// the Node Session runner.

import type {
  MemoryStoreBinding,
  ProcessHandle,
  ResumeRef,
  SandboxDuplexProcess,
  SandboxDuplexProcessSpec,
  SandboxExecutor,
  SandboxHandle,
  SandboxPlan,
  SandboxPorts,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";

/** What a Session host calls on a sandbox runtime. */
export type SessionSandboxExecutor = Pick<SandboxExecutor, "exec" | "readFile" | "writeFile"> & {
  startProcess(command: string): Promise<ProcessHandle | null>;
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<string>;
  setEnvVars(env: Record<string, string>): Promise<void>;
};

/** The handle record: what a new owner of the Session needs to find its sandbox. */
export interface SessionSandboxState {
  /** The Session's sandbox (running or paused); absent after a failed
   * execution released it. */
  handle?: SandboxHandle;
  stores: MemoryStoreBinding[];
  outputs: boolean;
  /** Start (epoch ms) of the sandbox's current continuous run. */
  runStartedAt?: number;
  /** Restore point recorded by the idle pause (design §0.1 step 8). */
  resumeRef?: ResumeRef;
  /** The idle pause stopped the sandbox: attaching wakes it and starts a new run. */
  paused?: boolean;
}

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
  schedule(delayMs: number): void | Promise<void>;
  cancel(): void | Promise<void>;
}

export interface PortsSessionSandboxOptions<R> {
  compose(): Promise<{ ports: SandboxPorts<R> }>;
  /** The host's view of a runtime (exec output in the `exit=N\n...` shape). */
  executor(runtime: R): SessionSandboxExecutor;
  state: {
    load(): Promise<SessionSandboxState | undefined>;
    save(state: SessionSandboxState): Promise<void>;
    clear(): Promise<void>;
  };
  scope(): RuntimeResourceScope;
  /** `stores`: stores already mounted through this runtime. */
  plan(input: { scope: RuntimeResourceScope; generation: string; stores: MemoryStoreBinding[] }): Promise<SandboxPlan>;
  /** Latest published restore point, or null. */
  resumeRef(): Promise<ResumeRef | null>;
  /** A host that records this in the event log uses sessionSandboxWarningEvent (./session-warning). */
  warn(message: string): void;
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
}
