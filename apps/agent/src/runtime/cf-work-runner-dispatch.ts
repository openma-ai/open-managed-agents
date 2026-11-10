import { sessionExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import { environmentWorkSandboxTokenRef } from "@open-managed-agents/sandbox-gateway-sql";
import { sandboxTokenSha256, type AttemptSandboxTokens } from "@open-managed-agents/sandbox-gateway";
import type { EnvironmentWorkRuntimeDelivery } from "@open-managed-agents/runtime-resource-contract";
import type { CloudflareSandbox } from "./sandbox";

type Authorized = {
  generation: number;
  environment: { config: { type: string } };
  session: { id: string; environmentId: string; agent: { openma?: { harness?: string | null } | null } };
  harness: { id: string; version: string };
};
type Delivery = EnvironmentWorkRuntimeDelivery & { signal: AbortSignal };
export interface CfWorkRunnerDispatchDependencies {
  command: string;
  /** Operator-owned installed inventory, same declaration as supervisor. */
  installedHarnesses?: string;
  /** Existing Work claim validation + pinned Session read; never caller selection. */
  authorize(input: EnvironmentWorkRuntimeDelivery, signal?: AbortSignal): Promise<Authorized | null>;
  /** The existing owner-scoped holder, shared with every egress attach. */
  tokens: AttemptSandboxTokens;
  issueToken(input: EnvironmentWorkRuntimeDelivery & { generation: number }, scope: "all"): Promise<string>;
  sandbox(input: EnvironmentWorkRuntimeDelivery): Promise<Pick<CloudflareSandbox, "runtimeHandle" | "setOutboundContext" | "startWorkRunner">>;
}

/** CF management composition only. Work runner owns ACK/heartbeat and ACP HTTP.
 * No dispatch ledger, no ACK here, no legacy egress-first token issuance. */
export function createCfWorkRunnerDispatch(deps: CfWorkRunnerDispatchDependencies) {
  return {
    async dispatch(input: Delivery): Promise<{ created: boolean }> {
      const { signal } = input;
      const delivery: EnvironmentWorkRuntimeDelivery = { workspaceId: input.workspaceId, environmentId: input.environmentId, sessionId: input.sessionId, workId: input.workId, apiBaseUrl: input.apiBaseUrl, workSecret: input.workSecret };
      signal.throwIfAborted();
      for (const value of [delivery.workspaceId, delivery.environmentId, delivery.sessionId, delivery.workId, delivery.workSecret]) if (typeof value !== "string" || !value.trim()) throw new TypeError("Work delivery scope is incomplete");
      const origin = new URL(delivery.apiBaseUrl);
      if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== delivery.apiBaseUrl) throw new TypeError("Work delivery requires a control-plane origin");
      const authorized = await deps.authorize(delivery, signal);
      signal.throwIfAborted();
      if (!authorized || authorized.session.id !== delivery.sessionId || authorized.session.environmentId !== delivery.environmentId || !Number.isSafeInteger(authorized.generation) || authorized.generation < 1) throw new Error("Current Work claim and pinned Session are required");
      const placement = sessionExecutionPlacement(authorized.environment, authorized.session);
      if (placement.authority !== "environment_work" || placement.harnessPlacement !== "in_sandbox" || placement.sandboxTokenScope !== "all") throw new Error("Work runner cannot start an outside Session brain");
      const harness = { ...authorized.harness };
      if (!harness.id || !harness.version) throw new Error("Pinned harness identity is required");
      const generation = authorized.generation;
      const assertCurrent = async () => {
        signal.throwIfAborted();
        const current = await deps.authorize(delivery, signal);
        signal.throwIfAborted();
        if (!current || current.generation !== generation || current.session.id !== delivery.sessionId || current.session.environmentId !== delivery.environmentId || current.harness.id !== harness.id || current.harness.version !== harness.version || sessionExecutionPlacement(current.environment, current.session).harnessPlacement !== "in_sandbox") throw new Error("Work bootstrap authority was lost");
      };
      const runtime = await deps.sandbox(delivery);
      await assertCurrent();
      signal.throwIfAborted();
      const fence = environmentWorkSandboxTokenRef({ ...delivery, generation });
      const token = await deps.tokens.relayDelivery(fence, () => deps.issueToken({ ...delivery, generation }, "all"), runtime.runtimeHandle().runtimeId);
      signal.throwIfAborted();
      const tokenSha256 = await sandboxTokenSha256(token);
      if (!tokenSha256) throw new Error("Work runner requires the existing sandbox token holder");
      await assertCurrent();
      await runtime.setOutboundContext({ tenantId: delivery.workspaceId, environmentId: delivery.environmentId, sessionId: delivery.sessionId, workId: delivery.workId, tokenSha256, required: true, controlPlaneBaseUrl: delivery.apiBaseUrl });
      signal.throwIfAborted();
      await assertCurrent();
      await runtime.startWorkRunner({ beforeLaunch: assertCurrent, signal, command: deps.command, controlPlaneOrigin: delivery.apiBaseUrl, env: {
        ANTHROPIC_BASE_URL: delivery.apiBaseUrl, ANTHROPIC_ENVIRONMENT_ID: delivery.environmentId,
        ANTHROPIC_SESSION_ID: delivery.sessionId, ANTHROPIC_WORK_ID: delivery.workId,
        ANTHROPIC_WORK_SECRET: delivery.workSecret, OPENMA_WORKSPACE_ID: delivery.workspaceId,
        OPENMA_HARNESS_ID: harness.id, OPENMA_HARNESS_VERSION: harness.version,
        OPENMA_SANDBOX_TOKEN: token,
        ...(deps.installedHarnesses ? { OPENMA_ACP_HARNESSES: deps.installedHarnesses } : {}),
      } });
      // A late abort must remain unknown, never a safe-to-retry launch failure.
      signal.throwIfAborted();
      return { created: true };
    },
  };
}
