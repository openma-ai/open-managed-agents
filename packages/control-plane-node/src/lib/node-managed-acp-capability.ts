import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import {
  attemptSandboxTokens,
  issueSandboxToken,
  sandboxHarnessPlacement,
  sandboxTokenAuthDecision,
  sandboxTokenScopeFor,
  type SandboxTokenStore,
  type SessionExecutionAttemptRef,
} from "@open-managed-agents/sandbox-gateway";
import { createSqlGatewaySandboxTokenStore } from "@open-managed-agents/sandbox-gateway-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** The sandbox token (#561) on Node: issued once per execution attempt into the
 * attempt row and checked by the shared @open-managed-agents/sandbox-gateway
 * code (design §0.0 rule 10) on every request, one database read, no cache.
 * The scope follows where the harness runs (sandboxHarnessPlacement). */
export function createNodeManagedAcpCapabilities(dependencies: {
  gatewayBaseUrl?: string;
  now(): Date;
  /** The token store (tests pass one); else SQL over `sql`, verifying both
   * lanes (execution attempt, Environment Work claim). */
  tokens?: SandboxTokenStore;
  sql?: SqlClient;
}) {
  const now = () => dependencies.now().getTime();
  const tokens = dependencies.tokens ?? (dependencies.sql === undefined ? null : createSqlGatewaySandboxTokenStore(dependencies.sql));
  if (tokens === null) throw new Error("Node sandbox tokens need a store or a SQL client");
  // One token per attempt, shared by the harness channels and the relay.
  const attemptTokens = attemptSandboxTokens();
  return {
    tokens,
    /** The in-sandbox ACP harness's channels: scope `all`. */
    async issue(input: { workspaceId: string; session: Session; executionSession?: Session; environment: Environment; executionFence?: SessionExecutionFence }) {
      if (!dependencies.gatewayBaseUrl) throw new Error("PUBLIC_BASE_URL is required for ACP sandbox model and MCP channels (must be reachable from the sandbox)");
      const session = input.executionSession ?? input.session;
      if (session.id !== input.session.id || session.environmentId !== input.session.environmentId) throw new Error("Child must share the execution Session and environment");
      const fence = input.executionFence;
      if (fence !== undefined && (fence.workspaceId !== input.workspaceId || fence.sessionId !== input.session.id)) {
        throw new Error("Sandbox token fence does not name this Session");
      }
      if (fence === undefined) throw new Error("Sandbox token requires a current Session Execution fence");
      const sessionsToken = await attemptTokens.token(fence, () => issueSandboxToken(tokens, fence, {
        scope: sandboxTokenScopeFor(sandboxHarnessPlacement(session.agent.openma?.harness)),
        expected: { environmentId: input.environment.id, agent: { id: session.agent.id, version: session.agent.version } },
        now,
      }));
      return { gatewayBaseUrl: dependencies.gatewayBaseUrl, sessionsToken };
    },
    /** The token for one delivery to the in-sandbox egress forwarder of
     * `attempt` (shared with the harness, rotated only for a new sandbox); `harness` is
     * the Session agent's harness name (scope all / egress). */
    async issueEgress(attempt: SessionExecutionAttemptRef, harness: string | null | undefined, sandbox?: object | string) {
      return attemptTokens.relayDelivery(attempt, () => issueSandboxToken(tokens, attempt, { scope: sandboxTokenScopeFor(sandboxHarnessPlacement(harness)), now }), sandbox);
    },
    /** authMiddleware: the sandbox token on the model gateway, MCP gateway and sandbox API. */
    authenticateToken(request: { headers: Headers; method: string; path: string }) {
      return sandboxTokenAuthDecision(tokens, request, now);
    },
  };
}
