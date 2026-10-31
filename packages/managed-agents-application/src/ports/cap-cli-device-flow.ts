/**
 * OpenMA extension (not part of the Anthropic Managed Agents contract):
 * OAuth device authorization that ends in a `cap_cli` Vault credential.
 * The in-flight device code is carried by an opaque, sealed `flowToken`
 * bound to the workspace, Vault and CLI.
 */
export interface StartCapCliDeviceFlowCommand {
  vaultId: string;
  cliId: string;
}

export interface CapCliDeviceFlowView {
  cliId: string;
  flowToken: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type StartCapCliDeviceFlowResult =
  | { type: "started"; flow: CapCliDeviceFlowView }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string }
  | { type: "upstream_error"; message: string };

export interface PollCapCliDeviceFlowCommand {
  vaultId: string;
  flowToken: string;
}

export type PollCapCliDeviceFlowResult =
  | { type: "pending" }
  | { type: "slow_down"; intervalSeconds: number; flowToken: string }
  | { type: "expired" }
  | { type: "denied" }
  | { type: "error"; oauthError: string; description?: string }
  | { type: "ready"; credentialId: string }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string };

export interface CapCliDeviceFlowApplicationPort {
  startDeviceFlow(command: StartCapCliDeviceFlowCommand): Promise<StartCapCliDeviceFlowResult>;
  pollDeviceFlow(command: PollCapCliDeviceFlowCommand): Promise<PollCapCliDeviceFlowResult>;
}
