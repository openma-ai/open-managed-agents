import type { AcpSession, AcpPermissionMode } from "@openma/common/acp-runtime";
import type {
  ManagedHarnessControlChannel,
  ManagedHarnessHttpControlOptions,
  ManagedAcpSupervisorHarnessOptions,
  ManagedHarnessInputContext,
  ManagedHarnessPromptCommand,
  ManagedHarnessFinalizationContext,
  ManagedHarnessFinalizationPort,
  ManagedHarnessTurnCompletion,
} from "@openma/common/managed-runtime";
import type { HarnessSupervisorHarness } from "@open-managed-agents/harness-supervisor";

/** Product composition port backed by the formally published common contracts.
 * Raw input CAS, Work authority and HTTP finalization remain product-owned. */
export interface WorkControlRuntime {
  createSupervisor(options: WorkSupervisorOptions): HarnessSupervisorHarness;
  createControlChannel(options: WorkHttpControlOptions): WorkControlChannel;
  applyPermissionMode(session: AcpSession, options: {
    harnessId: string;
    mode: WorkPermissionMode;
    /** Explicit per-tool policies (common ignores; ungated profiles refuse stricter ones). */
    toolModes?: readonly string[];
    abortSignal: AbortSignal;
  }): Promise<
    | { status: "applied"; nativeModeId: string; verification: "session/set_config_option" }
    /** Certified ungated harness running always_allow: no native mode exists. */
    | { status: "inherent"; verification: "ungated-harness-profile" }
    | { status: "not-configured" }
  >;
}
export type WorkPermissionMode = AcpPermissionMode;
export type WorkInputContext = ManagedHarnessInputContext;
export type WorkPromptCommand = ManagedHarnessPromptCommand;
export type WorkControlChannel = ManagedHarnessControlChannel;
export type WorkHttpControlOptions = ManagedHarnessHttpControlOptions & {
  publishTurnStartBeforeDispatch: true;
} & Required<Pick<ManagedHarnessHttpControlOptions,
  "eventReader" | "onBeforeDispatch" | "onInputSettled" | "onToolConfirmation"
>>;
export type WorkFinalizationContext = ManagedHarnessFinalizationContext;
export type WorkFinalizationPort = ManagedHarnessFinalizationPort;
export type WorkTurnCompletion = ManagedHarnessTurnCompletion;
export type WorkSupervisorOptions = ManagedAcpSupervisorHarnessOptions & {
  finalization: WorkFinalizationPort;
};
