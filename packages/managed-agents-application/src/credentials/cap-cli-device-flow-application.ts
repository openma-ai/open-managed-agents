import type {
  CapCliDeviceFlowApplicationPort,
  PollCapCliDeviceFlowCommand,
  PollCapCliDeviceFlowResult,
  StartCapCliDeviceFlowCommand,
  StartCapCliDeviceFlowResult,
} from "../ports/cap-cli-device-flow";
import type { CredentialsApplicationPort } from "../ports/credentials";
import type {
  CapCliDeviceFlowPort,
  CapCliDeviceFlowState,
  CapCliFlowTokenCipher,
} from "./cap-cli-device-flow";

export interface CapCliDeviceFlowApplicationServiceDependencies {
  workspaceId: string;
  credentials: CredentialsApplicationPort;
  deviceFlow: CapCliDeviceFlowPort;
  cipher: CapCliFlowTokenCipher;
  clock: { now(): Date };
}

interface SealedFlow {
  v: 1;
  workspaceId: string;
  vaultId: string;
  cliId: string;
  state: CapCliDeviceFlowState;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSealedFlow(value: unknown): SealedFlow | null {
  if (typeof value !== "object" || value === null) return null;
  const flow = value as Record<string, unknown>;
  const state = flow.state as Record<string, unknown> | undefined;
  if (
    flow.v !== 1 ||
    !isString(flow.workspaceId) ||
    !isString(flow.vaultId) ||
    !isString(flow.cliId) ||
    typeof state !== "object" ||
    state === null ||
    !isString(state.deviceCode) ||
    !isString(state.userCode) ||
    !isString(state.verificationUri) ||
    (state.verificationUriComplete !== undefined && !isString(state.verificationUriComplete)) ||
    !isNumber(state.intervalSeconds) ||
    !isNumber(state.expiresAtMs)
  ) return null;
  return {
    v: 1,
    workspaceId: flow.workspaceId,
    vaultId: flow.vaultId,
    cliId: flow.cliId,
    state: {
      deviceCode: state.deviceCode,
      userCode: state.userCode,
      verificationUri: state.verificationUri,
      ...(isString(state.verificationUriComplete) && {
        verificationUriComplete: state.verificationUriComplete,
      }),
      intervalSeconds: state.intervalSeconds,
      expiresAtMs: state.expiresAtMs,
    },
  };
}

/**
 * OpenMA extension: OAuth Device Authorization Grant (RFC 8628) that ends
 * in a managed `cap_cli` credential. No server-side flow storage: the
 * device code travels sealed in `flowToken`. On approval the token becomes
 * a new credential and older active `cap_cli` credentials for the same CLI
 * in that Vault are archived, so re-auth leaves one active row.
 */
export class CapCliDeviceFlowApplicationService
  implements CapCliDeviceFlowApplicationPort
{
  constructor(
    private readonly dependencies: CapCliDeviceFlowApplicationServiceDependencies,
  ) {}

  async startDeviceFlow(
    command: StartCapCliDeviceFlowCommand,
  ): Promise<StartCapCliDeviceFlowResult> {
    const vault = await this.dependencies.credentials.listCredentials({
      vaultId: command.vaultId,
      pageSize: 1,
    });
    if (vault.type === "not_found") return { type: "not_found" };
    const started = await this.dependencies.deviceFlow.initiate(command.cliId);
    switch (started.type) {
      case "unknown_cli":
        return {
          type: "invalid_request",
          message: `Unknown cap_cli cli_id "${command.cliId}"`,
        };
      case "no_device_flow":
        return {
          type: "invalid_request",
          message: `CLI "${command.cliId}" has no OAuth device flow; create the credential with a token`,
        };
      case "upstream_error":
        return started;
      case "started": {
        const { state } = started;
        return {
          type: "started",
          flow: {
            cliId: command.cliId,
            flowToken: await this.seal({
              v: 1,
              workspaceId: this.dependencies.workspaceId,
              vaultId: command.vaultId,
              cliId: command.cliId,
              state,
            }),
            userCode: state.userCode,
            verificationUri: state.verificationUri,
            ...(state.verificationUriComplete !== undefined && {
              verificationUriComplete: state.verificationUriComplete,
            }),
            intervalSeconds: state.intervalSeconds,
            expiresAt: new Date(state.expiresAtMs).toISOString(),
          },
        };
      }
    }
  }

  async pollDeviceFlow(
    command: PollCapCliDeviceFlowCommand,
  ): Promise<PollCapCliDeviceFlowResult> {
    const flow = await this.open(command.flowToken);
    if (flow === null) return { type: "invalid_request", message: "Invalid flow_token" };
    if (
      flow.workspaceId !== this.dependencies.workspaceId ||
      flow.vaultId !== command.vaultId
    ) return { type: "not_found" };
    if (this.dependencies.clock.now().getTime() >= flow.state.expiresAtMs) {
      return { type: "expired" };
    }
    const result = await this.dependencies.deviceFlow.poll(flow.cliId, flow.state);
    switch (result.type) {
      case "pending":
      case "expired":
      case "denied":
      case "error":
        return result;
      case "slow_down":
        return {
          type: "slow_down",
          intervalSeconds: result.intervalSeconds,
          flowToken: await this.seal({
            ...flow,
            state: { ...flow.state, intervalSeconds: result.intervalSeconds },
          }),
        };
      case "ready":
        return this.storeToken(flow, result.token);
    }
  }

  private async storeToken(
    flow: SealedFlow,
    token: Extract<Awaited<ReturnType<CapCliDeviceFlowPort["poll"]>>, { type: "ready" }>["token"],
  ): Promise<PollCapCliDeviceFlowResult> {
    const { credentials } = this.dependencies;
    const previous = await this.activeCredentialIds(flow.vaultId, flow.cliId);
    const created = await credentials.createCredential({
      vaultId: flow.vaultId,
      displayName: `${flow.cliId} (OAuth)`,
      auth: {
        type: "cap_cli",
        cliId: flow.cliId,
        token: token.token,
        ...(token.refreshToken !== null && { refreshToken: token.refreshToken }),
        ...(token.expiresAt !== null && { expiresAt: token.expiresAt }),
        ...(Object.keys(token.extras).length > 0 && { extras: token.extras }),
      },
    });
    if (created.type !== "created") return created;
    for (const credentialId of previous) {
      await credentials.archiveCredential({ vaultId: flow.vaultId, credentialId });
    }
    return { type: "ready", credentialId: created.credential.id };
  }

  private async activeCredentialIds(vaultId: string, cliId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.dependencies.credentials.listCredentials({
        vaultId,
        pageSize: 100,
        ...(cursor !== undefined && { cursor }),
      });
      if (page.type !== "page") return ids;
      for (const credential of page.page.credentials) {
        if (
          credential.archivedAt === null &&
          credential.auth.type === "cap_cli" &&
          credential.auth.cliId === cliId
        ) ids.push(credential.id);
      }
      if (page.page.nextCursor === null) return ids;
      cursor = page.page.nextCursor;
    }
  }

  private seal(flow: SealedFlow): Promise<string> {
    return this.dependencies.cipher.encrypt(JSON.stringify(flow));
  }

  private async open(token: string): Promise<SealedFlow | null> {
    try {
      return parseSealedFlow(JSON.parse(await this.dependencies.cipher.decrypt(token)));
    } catch {
      return null;
    }
  }
}
