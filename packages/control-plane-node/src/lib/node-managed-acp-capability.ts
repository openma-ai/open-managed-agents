import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import {
  sealedSandboxBearerCodec,
  type EnvironmentWorkSessionTokenCrypto,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionExecution, SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import { sessionExecutionLeasesFrom } from "@open-managed-agents/session-runtime/execution-lease";
import {
  issueSandboxToken,
  sandboxHarnessPlacement,
  sandboxTokenAuthDecision,
  sandboxTokenScopeFor,
  type SandboxBearerAuthority,
  type SandboxGatewayStores,
  type SandboxTokenStore,
  type SessionExecutionAttemptRef,
} from "@open-managed-agents/sandbox-gateway";
import { createSqlSandboxTokenStore } from "@open-managed-agents/sandbox-gateway-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** The sandbox token (#561) on Node: issued per execution attempt into the
 * attempt row and checked by the shared @open-managed-agents/sandbox-gateway
 * code (design §0.0 rule 10) on every request, one database read, no cache.
 * The scope follows where the harness runs (sandboxHarnessPlacement). */
export function createNodeManagedAcpCapabilities(dependencies: {
  /** Opens pre-#561 sealed execution tokens (DEPLOY TRANSITION ONLY, verify-only). */
  crypto: EnvironmentWorkSessionTokenCrypto | null;
  gatewayBaseUrl?: string;
  now(): Date;
  /** The token store (tests pass one); else SQL over `sql`. */
  tokens?: SandboxTokenStore;
  sql?: SqlClient;
  findExecution(input: { workspaceId: string; executionId: string }): Promise<SessionExecution | null>;
  findSession(input: { workspaceId: string; sessionId: string }): Promise<Session | null>;
}) {
  const now = () => dependencies.now().getTime();
  const tokens = dependencies.tokens ?? (dependencies.sql === undefined ? null : createSqlSandboxTokenStore(dependencies.sql));
  if (tokens === null) throw new Error("Node sandbox tokens need a store or a SQL client");
  const stores: SandboxGatewayStores = () => ({
    leases: sessionExecutionLeasesFrom((input) => dependencies.findExecution(input)),
    findSession: (input) => dependencies.findSession(input),
  });
  // DEPLOY TRANSITION ONLY — remove in the next release with sandbox-bearer's `execution` branch.
  const execution = dependencies.crypto === null ? null : { codec: sealedSandboxBearerCodec(dependencies.crypto, dependencies.now), stores };
  return {
    stores,
    tokens,
    /** The in-sandbox ACP harness's channels: scope `all`. */
    async issue(input: { workspaceId: string; session: Session; environment: Environment; executionFence?: SessionExecutionFence }) {
      if (!dependencies.gatewayBaseUrl) throw new Error("PUBLIC_BASE_URL is required for Node ACP sandbox capabilities (must be reachable from the sandbox)");
      const fence = input.executionFence;
      if (fence !== undefined && (fence.workspaceId !== input.workspaceId || fence.sessionId !== input.session.id)) {
        throw new Error("Sandbox token fence does not name this Session");
      }
      const sessionsToken = await issueSandboxToken(tokens, fence, {
        scope: sandboxTokenScopeFor(sandboxHarnessPlacement(input.session.agent.openma?.harness)),
        expected: { environmentId: input.environment.id, agent: { id: input.session.agent.id, version: input.session.agent.version } },
        now,
      });
      return { gatewayBaseUrl: dependencies.gatewayBaseUrl, sessionsToken };
    },
    /** A token for the in-sandbox egress forwarder of `attempt`; `harness`
     * is the Session agent's harness name (scope all / egress). */
    async issueEgress(attempt: SessionExecutionAttemptRef, harness: string | null | undefined) {
      return issueSandboxToken(tokens, attempt, { scope: sandboxTokenScopeFor(sandboxHarnessPlacement(harness)), now });
    },
    /** authMiddleware: the sandbox token on the model gateway, MCP gateway and sandbox API. */
    authenticateToken(request: { headers: Headers; method: string; path: string }) {
      return sandboxTokenAuthDecision(tokens, request, now);
    },
    /** The sealed bearer authority: legacy execution token, then `work`. */
    authority(work: SandboxBearerAuthority["work"]): SandboxBearerAuthority {
      return { execution, work, now };
    },
  };
}
