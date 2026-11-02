import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import {
  authenticateEnvironmentWorkSessionBearer,
  SealedEnvironmentWorkSessionCredentialIssuer,
  type EnvironmentWorkSessionTokenCrypto,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionExecution, SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";

/** Reuse the Work credential envelope for Node-owned execution attempts. A
 * separate crypto purpose plus a proxy-only gate prevents this capability from
 * authorizing Work lifecycle, Session writes, or any standing workspace API. */
export function createNodeManagedAcpCapabilities(dependencies: {
  crypto: EnvironmentWorkSessionTokenCrypto | null;
  gatewayBaseUrl?: string;
  now(): Date;
  findExecution(input: { workspaceId: string; executionId: string }): Promise<SessionExecution | null>;
  findSession(input: { workspaceId: string; sessionId: string }): Promise<Session | null>;
}) {
  const issuer = dependencies.crypto === null ? null : new SealedEnvironmentWorkSessionCredentialIssuer({
    crypto: dependencies.crypto, now: dependencies.now, apiBaseUrl: dependencies.gatewayBaseUrl,
  });
  return {
    async issue(input: { workspaceId: string; session: Session; environment: Environment; executionFence?: SessionExecutionFence }) {
      if (!issuer) throw new Error("PLATFORM_ROOT_SECRET is required for Node ACP sandbox capabilities");
      if (!dependencies.gatewayBaseUrl) throw new Error("PUBLIC_BASE_URL is required for Node ACP sandbox capabilities (must be reachable from the sandbox)");
      const fence = input.executionFence;
      if (!fence || fence.workspaceId !== input.workspaceId || fence.sessionId !== input.session.id || !(Date.parse(fence.expiresAt) > dependencies.now().getTime())) {
        throw new Error("Node ACP sandbox requires a current Session Execution fence");
      }
      const execution = await dependencies.findExecution({ workspaceId: input.workspaceId, executionId: fence.executionId });
      const session = await dependencies.findSession({ workspaceId: input.workspaceId, sessionId: input.session.id });
      if (!session) throw new Error(`Session ${input.session.id} was not found`);
      if (session.archivedAt !== null) throw new Error(`Session ${input.session.id} is archived and cannot receive new events`);
      if (session.environmentId !== input.environment.id) {
        throw new Error("Node ACP sandbox requires the Session environment (child ACP capabilities are not supported)");
      }
      if (session.agent.id !== input.session.agent.id || session.agent.version !== input.session.agent.version) {
        throw new Error("Node ACP sandbox requires the pinned Session agent (child ACP capabilities are not supported)");
      }
      if (execution?.state !== "running" || execution.sessionId !== fence.sessionId || execution.attempt?.id !== fence.attemptId || execution.attempt.ownerId !== fence.ownerId || execution.attempt.generation !== fence.generation || !(Date.parse(execution.attempt.leaseExpiresAt) > dependencies.now().getTime())) {
        throw new Error("Node ACP sandbox Session Execution fence is stale");
      }
      const issued = await issuer.issue({ workspaceId: input.workspaceId, session: input.session, environment: input.environment, workId: execution.id });
      if (issued.type !== "issued") throw new Error(issued.message);
      const bound = await issuer.bindToClaim({ secret: issued.secret, claimedAt: execution.attempt.claimedAt, generation: execution.attempt.generation });
      return { gatewayBaseUrl: dependencies.gatewayBaseUrl, sessionsToken: bound.secret.sessionsToken };
    },
    async authenticate(input: { token: string; method: string; path: string }) {
      if (!dependencies.crypto || !/^\/v1\/oma\/(?:mcp-proxy|inference-proxy)\//u.test(input.path)) return null;
      return authenticateEnvironmentWorkSessionBearer({
        ...input, crypto: dependencies.crypto, now: dependencies.now,
        isCurrent: async claim => {
          const execution = await dependencies.findExecution({ workspaceId: claim.workspaceId, executionId: claim.workId });
          if (execution?.state !== "running" || execution.sessionId !== claim.sessionId || execution.attempt?.generation !== claim.generation || execution.attempt.claimedAt !== claim.claimedAt || !(Date.parse(execution.attempt.leaseExpiresAt) > dependencies.now().getTime())) return false;
          const session = await dependencies.findSession({ workspaceId: claim.workspaceId, sessionId: claim.sessionId });
          return session !== null && session.archivedAt === null && session.environmentId === claim.environmentId;
        },
      });
    },
  };
}
