import type { SqlClient } from "@open-managed-agents/sql-client";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import { isCurrentEnvironmentWorkClaim } from "@open-managed-agents/environment-work-store";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";
import { parseAcpRegistryRef } from "@open-managed-agents/acp-runtime/registry-pins";
import { sessionExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import type { Session } from "@open-managed-agents/domain/sessions";
import type { EnvironmentWorkRuntimeDelivery } from "@open-managed-agents/runtime-resource-contract";

/** Trusted adapter: uses the existing stored claim, not a caller selection or
 * environment key. The poll secret must equal the current encrypted row secret. */
export function createCfWorkRunnerAuthority(input: {
  sql: SqlClient;
  work: EnvironmentWorkStore;
  controlPlaneOrigin: string;
  now?: () => Date;
  /** Command-based pins must match the existing installed harness inventory. */
  resolveInstalledHarness?(session: Session): Promise<{ id: string; version: string } | null>;
}) {
  return async (delivery: EnvironmentWorkRuntimeDelivery) => {
    for (const value of [delivery.workspaceId, delivery.environmentId, delivery.sessionId, delivery.workId, delivery.workSecret]) if (typeof value !== "string" || !value.trim()) return null;
    if (delivery.apiBaseUrl !== input.controlPlaneOrigin) return null;
    const capability = managedMcpProxyFromWorkEnvironment({ ANTHROPIC_BASE_URL: delivery.apiBaseUrl, ANTHROPIC_WORK_SECRET: delivery.workSecret });
    if (!capability || capability.gatewayBaseUrl !== input.controlPlaneOrigin || !capability.sessionsToken.startsWith("sk-ant-req-v1.")) return null;
    const stored = await input.work.find(delivery);
    if (!stored?.claim || !["queued", "starting", "active"].includes(stored.work.state) || stored.secret.sessionsToken !== capability.sessionsToken) return null;
    const current = await isCurrentEnvironmentWorkClaim({ store: input.work, now: input.now ?? (() => new Date()) }, {
      ...delivery, generation: stored.claim.generation, claimedAt: stored.claim.claimedAt,
      token: capability.sessionsToken, method: "POST",
      path: "/v1/environments/" + encodeURIComponent(delivery.environmentId) + "/work/" + encodeURIComponent(delivery.workId) + "/ack",
    });
    if (!current) return null;
    const [session, environment] = await Promise.all([
      new SqlSessionSource(input.sql).find({ workspaceId: delivery.workspaceId, sessionId: delivery.sessionId }),
      new SqlSessionEnvironmentSource(input.sql).find({ workspaceId: delivery.workspaceId, environmentId: delivery.environmentId }),
    ]);
    if (!session || session.archivedAt !== null || session.environmentId !== delivery.environmentId || !environment || environment.archivedAt !== null) return null;
    const selection = sessionExecutionPlacement(environment, session);
    if (selection.authority !== "environment_work" || selection.harnessPlacement !== "in_sandbox") return null;
    const registry = session.agent.openma?.acp?.agent.registry;
    const harness = registry ? parseAcpRegistryRef(registry) : await input.resolveInstalledHarness?.(session);
    if (!harness?.id || !harness.version) return null;
    return { generation: stored.claim.generation, environment, session, harness };
  };
}

/** Actual CF SQL composition; the caller must supply its existing owner-scoped
 * holder and selected sandbox. No second token cache or claim lifecycle. */
export async function createCfSqlWorkRunnerDispatch(input: Parameters<typeof createCfWorkRunnerAuthority>[0] & {
  command: string;
  tokens: import("@open-managed-agents/sandbox-gateway").AttemptSandboxTokens;
  sandbox: import("../../../agent/src/runtime/cf-work-runner-dispatch").CfWorkRunnerDispatchDependencies["sandbox"];
}) {
  const { createCfWorkRunnerDispatch } = await import("../../../agent/src/runtime/cf-work-runner-dispatch");
  const { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } = await import("@open-managed-agents/sandbox-gateway-sql");
  const { issueSandboxToken } = await import("@open-managed-agents/sandbox-gateway");
  return createCfWorkRunnerDispatch({ command: input.command, tokens: input.tokens, sandbox: input.sandbox,
    authorize: createCfWorkRunnerAuthority(input),
    issueToken: (delivery, scope) => issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(input.sql), environmentWorkSandboxTokenRef(delivery), { scope }),
  });
}
