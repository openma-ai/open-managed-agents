import type { AcpSession } from "@openma/common/acp-runtime";
import type { SessionPromptCommand } from "@openma/common/session-kernel";
import type {
  ManagedHarnessControlChannel,
  ManagedHarnessHttpControlOptions,
  ManagedAcpSupervisorHarnessOptions,
  RuntimeResourceScope,
} from "@openma/common/managed-runtime";
import type { HarnessSupervisorHarness } from "@open-managed-agents/harness-supervisor";
import type { WorkWireInput } from "./work-input-adapter.js";

/** Explicit capability injection until common publishes its dispatch-gate API.
 * These structural types use only existing public contracts. Do not pass the
 * 0.13.1 factories: they ignore the gate. No implicit legacy fallback.
 *
 * Exit: once the released common version + lockfile supply the verified hooks,
 * replace the structural Work* contracts below with aliases to its exported
 * ManagedHarness* / AcpPermissionMode contracts. Keep WorkControlRuntime only
 * as the product composition port (or use Pick<typeof common, ...>). Delete
 * candidate-source test loading only after the same suite passes installed.
 * WorkTurnCoordinator remains product-owned: raw CAS, Work authority and HTTP
 * finalization are not generic common-runtime responsibilities. */
export interface WorkControlRuntime {
  createSupervisor(options: WorkSupervisorOptions): HarnessSupervisorHarness;
  createControlChannel(options: WorkHttpControlOptions): WorkControlChannel;
  applyPermissionMode(session: AcpSession, options: {
    harnessId: string;
    mode: WorkPermissionMode;
    abortSignal: AbortSignal;
  }): Promise<
    | { status: "applied"; nativeModeId: string; verification: "session/set_config_option" }
    | { status: "not-configured" }
  >;
}
export type WorkPermissionMode = "always_ask" | "auto" | "always_allow";
export interface WorkInputContext {
  /** Original canonical event id, not source.execution_id or callback turn. */
  eventId: string;
  event: Readonly<Record<string, unknown>>;
  outcome?: { id: string; description: string; rubric: unknown; maxIterations?: number | null };
}
export type WorkPromptCommand = SessionPromptCommand & { input?: WorkInputContext };
export interface WorkControlChannel extends ManagedHarnessControlChannel {
  beforeDispatch?(command: WorkPromptCommand, signal: AbortSignal, kind?: "prompt" | "steer"): Promise<void>;
}
export interface WorkHttpControlOptions extends ManagedHarnessHttpControlOptions {
 publishTurnStartBeforeDispatch: true;
  eventReader: {
    read(input: {
      scope: RuntimeResourceScope;
      cursor: string | null;
      limit: number;
      signal: AbortSignal;
    }): Promise<{ events: WorkWireInput[]; cursor: string | null; hasMore: boolean }>;
  };
  onBeforeDispatch(input: {
    scope: RuntimeResourceScope;
    command: WorkPromptCommand;
    kind: "prompt" | "steer";
    input: { eventId: string; event: Readonly<Record<string, unknown>> };
    signal: AbortSignal;
  }): Promise<void>;
  onFallbackOwner?(input: {command: WorkPromptCommand; signal: AbortSignal}): Promise<string | null>;
  onConsumed?(input: {
    scope: RuntimeResourceScope;
    command: WorkPromptCommand;
    input: { eventId: string; event: Readonly<Record<string, unknown>> };
    acceptance: "prompt-dispatched" | "injected" | "startedNewTurn";
  }): Promise<void>;
  onInputSettled(input: {
    scope: RuntimeResourceScope;
    input: { eventId: string; event: Readonly<Record<string, unknown>> };
    turnId: string;
    reason: "partial" | "closed";
    signal: AbortSignal;
  }): Promise<void>;
  onToolConfirmation(input: {
    scope: RuntimeResourceScope;
    event: WorkWireInput;
    activeTurnId: string | null;
    signal: AbortSignal;
  }): Promise<"answered" | "rejected">;
}

export interface WorkFinalizationContext {
  command: WorkPromptCommand;
  signal: AbortSignal;
  flush(): Promise<void>;
}
export interface WorkFinalizationPort {
  drainTurn(context: WorkFinalizationContext): Promise<void>;
  afterTerminal(context: WorkFinalizationContext & {
    completion: { type: "session.complete"; sessionId: string; turnId: string };
  }): Promise<void>;
}
export interface WorkTurnCompletion extends WorkFinalizationContext {
  runRevision(input: { turnId: string; text: string }): Promise<void>;
  cancel(): Promise<void>;
}
export interface WorkSupervisorOptions extends ManagedAcpSupervisorHarnessOptions {
  finalization: WorkFinalizationPort;
  onTurnComplete?(turn: WorkTurnCompletion): Promise<void>;
}
