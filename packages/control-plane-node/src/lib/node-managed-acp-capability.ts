import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import {
  SealedEnvironmentWorkSessionCredentialIssuer,
  sealedSandboxBearerCodec,
  type EnvironmentWorkSessionTokenCrypto,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionExecution, SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import { sessionExecutionLeasesFrom } from "@open-managed-agents/session-runtime/execution-lease";
import {
  authenticateSandboxBearer,
  authorizeExecutionCredential,
  type SandboxBearerAuthority,
  type SandboxGatewayStores,
} from "@open-managed-agents/sandbox-gateway";

/** Reuse the Work credential envelope for Node-owned execution attempts. A
 * separate crypto purpose plus a proxy-only gate prevents this capability from
 * authorizing Work lifecycle, Session writes, or any standing workspace API.
 * The checks are the shared @open-managed-agents/sandbox-gateway ones
 * (design §0.0 rule 10): the execution lease row is the authority. */
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
  const now = () => dependencies.now().getTime();
  const stores: SandboxGatewayStores = () => ({
    leases: sessionExecutionLeasesFrom((input) => dependencies.findExecution(input)),
    findSession: (input) => dependencies.findSession(input),
  });
  const execution = dependencies.crypto === null ? null : { codec: sealedSandboxBearerCodec(dependencies.crypto, dependencies.now), stores };
  return {
    stores,
    async issue(input: { workspaceId: string; session: Session; environment: Environment; executionFence?: SessionExecutionFence }) {
      if (!issuer) throw new Error("PLATFORM_ROOT_SECRET is required for Node ACP sandbox capabilities");
      if (!dependencies.gatewayBaseUrl) throw new Error("PUBLIC_BASE_URL is required for Node ACP sandbox capabilities (must be reachable from the sandbox)");
      const lease = await authorizeExecutionCredential(stores, input.executionFence, {
        workspaceId: input.workspaceId, sessionId: input.session.id, environmentId: input.environment.id,
        agent: { id: input.session.agent.id, version: input.session.agent.version },
      }, now);
      const issued = await issuer.issue({ workspaceId: input.workspaceId, session: input.session, environment: input.environment, workId: lease.executionId });
      if (issued.type !== "issued") throw new Error(issued.message);
      const bound = await issuer.bindToClaim({ secret: issued.secret, claimedAt: new Date(lease.claimedAtMs).toISOString(), generation: lease.generation });
      return { gatewayBaseUrl: dependencies.gatewayBaseUrl, sessionsToken: bound.secret.sessionsToken };
    },
    /** The execution token only (model gateway / MCP proxy). */
    async authenticate(input: { token: string; method: string; path: string }) {
      return authenticateSandboxBearer({ execution, work: null, now }, input);
    },
    /** The full sandbox bearer authority: execution token, then `work`. */
    authority(work: SandboxBearerAuthority["work"]): SandboxBearerAuthority {
      return { execution, work, now };
    },
  };
}
