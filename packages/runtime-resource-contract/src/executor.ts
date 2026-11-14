import type { RuntimeResourceFence } from "./fence";
import type { ManagedSandboxLease } from "./sandbox";
import type { RuntimeResourceScope } from "./scope";
import type { AbsoluteWorkspacePath } from "./session-resource-facts";
import type {
  HarnessDriverDeclaration,
  RuntimeProcessDeclaration,
} from "./profile";
import type { SandboxHarnessDriverCapabilities } from "./capabilities";

export type ManagedWorkExecutionResult =
  | { type: "completed" }
  | { type: "aborted" };

export type HarnessSupervisorCommand =
  | {
      type: "start";
      scope: RuntimeResourceScope;
      harness: { id: string; version: string };
      workspacePath: AbsoluteWorkspacePath;
      outputPath: "/mnt/session/outputs" | null;
    }
  | { type: "drain" }
  /** A cadence hint only: the supervisor waits for the harness' next safe point. */
  | { type: "checkpoint.request"; requestId: string }
  | { type: "checkpoint.commit"; checkpointId: string }
  | { type: "checkpoint.reject"; checkpointId: string; message: string }
  | { type: "stop"; reason: "aborted" | "failed" };

export type HarnessSupervisorEvent =
  | { type: "ready"; protocol: "openma-harness-supervisor-v1" }
  | { type: "heartbeat"; sequence: number }
  /** The supervisor has applied checkpoint.commit and cleared its pending request. */
  | { type: "checkpoint.committed"; requestId: string }
  | {
      type: "checkpoint";
      checkpointId: string;
      sessionId: string;
      turnId?: string;
      /** Present when this harness safe point fulfills a host request. */
      requestId?: string;
    }
  | { type: "completed"; exitCode: number }
  | { type: "drained" }
  | { type: "error"; message: string };

export interface HarnessSupervisorChannel {
  send(command: HarnessSupervisorCommand): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<HarnessSupervisorEvent>;
  close(): Promise<void>;
}

/** Provider transport for the same supervisor protocol (stdio, RPC, etc.). */
export interface HarnessSupervisorTransportPort {
  open(input: {
    scope: RuntimeResourceScope;
    sandbox: ManagedSandboxLease;
    process: RuntimeProcessDeclaration;
    signal: AbortSignal;
  }): Promise<HarnessSupervisorChannel>;
}

/** Runs the hand/harness in already-prepared compute. */
export interface SandboxHarnessDriverPort {
  driverCapabilities(
    scope: RuntimeResourceScope,
  ): Promise<SandboxHarnessDriverCapabilities>;
  run(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    sandbox: ManagedSandboxLease;
    workspacePath: AbsoluteWorkspacePath;
    outputPath: "/mnt/session/outputs" | null;
    driver: HarnessDriverDeclaration;
    /** Commit a live turn boundary under the current resource fence. */
    checkpoint?(input: {
      checkpointId: string;
      sessionId: string;
      turnId?: string;
    }): Promise<void>;
    /** Register a host-side request path after the supervisor becomes ready.
     * A request waits for a harness safe-point checkpoint; it never snapshots
     * a running turn directly. The promise settles when that checkpoint is
     * committed or when the supervisor exits without reaching a safe point. */
    onCheckpointRequester?(request: () => Promise<void>): void;
    signal: AbortSignal;
  }): Promise<ManagedWorkExecutionResult>;
}

/** @deprecated Use SandboxHarnessDriverPort. */
export type ManagedWorkExecutorPort = SandboxHarnessDriverPort;
