// Credentialed github_repository resources on Node (design §0.7 Vault row,
// §8.4): the sandbox never holds the token. Git authenticates with a
// placeholder (Basic auth `x-access-token:<placeholder>` in a command-scoped
// http.<url>.extraHeader); the plan carries one substitution per repository,
// so the forwarder is installed before the clone, and the egress relay
// swaps the real token in, on the repository's host only. Same placeholder
// derivation and substitution code as Vault credentials (sandbox-gateway).

import type { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";
import type { Session } from "@open-managed-agents/managed-agents-application";
import type { Substitution } from "@open-managed-agents/sandbox";
import { placeholderSubstitutions } from "@open-managed-agents/sandbox-port-kit";
import { createVaultPlaceholders, type VaultSubstitutionSecret } from "@open-managed-agents/sandbox-gateway";
import type { SessionResourceSecretSource } from "@open-managed-agents/session-resource-store";
import type { RepositoryBondCredentialSource } from "./node-managed-session-inputs.js";

type Repository = Extract<Session["resources"][number], { type: "github_repository" }>;

export interface RepositoryCredentialSources {
  repositoryCredentials: Pick<SessionResourceSecretSource, "findGithubToken">;
  /** Unset: repositories without a token are cloned anonymously. */
  repositoryBonds?: RepositoryBondCredentialSource;
}

/** No token and no Bonds on this deployment: git gets no credential, so the
 * repository needs no placeholder, substitution or relay. */
export function clonesAnonymously(sources: Pick<RepositoryCredentialSources, "repositoryBonds">, resource: { credentialSource?: string }): boolean {
  return resource.credentialSource === "bond" && sources.repositoryBonds === undefined;
}

/** The repository's token (stored with the resource, or the workspace's Bond). */
export async function repositoryToken(sources: RepositoryCredentialSources, input: { workspaceId: string; sessionId: string }, resource: Repository): Promise<string | null> {
  if (resource.credentialSource !== "bond") {
    return sources.repositoryCredentials.findGithubToken({ workspaceId: input.workspaceId, sessionId: input.sessionId, resourceId: resource.id });
  }
  return sources.repositoryBonds?.repositoryToken({ workspaceId: input.workspaceId, url: resource.url }) ?? null;
}

const NO_PLACEHOLDERS = "Repository credentials reach the sandbox only through credential egress, which needs PLATFORM_ROOT_SECRET";

const repositoriesOf = (session: Pick<Session, "resources">): Repository[] =>
  session.resources.filter((resource): resource is Repository => resource.type === "github_repository");
const envNameOf = (resource: Repository) => `OMA_REPOSITORY_TOKEN_${resource.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
const hostOf = (url: string): string | null => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
};

export function createNodeRepositoryEgress(input: RepositoryCredentialSources & {
  secret: string | undefined;
  findSession(scope: { workspaceId: string; sessionId: string }): Promise<Pick<Session, "resources"> | null>;
}) {
  const placeholders = input.secret ? createVaultPlaceholders(input.secret) : null;
  const placeholder = async (scope: { workspaceId: string; sessionId: string }, resourceId: string) => {
    if (placeholders === null) throw new Error(NO_PLACEHOLDERS);
    return placeholders.placeholder(scope, `repository:${resourceId}`);
  };
  return {
    /** What git sends instead of the token (NodeManagedSessionInputPreparer). */
    placeholder: (scope: { workspaceId: string; sessionId: string; resourceId: string }) => placeholder(scope, scope.resourceId),

    /** The plan's substitutions: the Session's Vault placeholders plus one per repository. */
    async substitutions(context: { workspaceId: string; session: Session }, vault: () => Pick<ManagedCredentialResolver, "placeholderEnvironment">): Promise<Substitution[]> {
      const { workspaceId, session } = context;
      const vaults = session.vaultIds.length === 0 ? [] : placeholderSubstitutions(
        await vault().placeholderEnvironment({ workspaceId, sessionId: session.id, vaultIds: session.vaultIds }), "vault");
      const repositories: Record<string, string> = {};
      for (const resource of repositoriesOf(session)) {
        if (!clonesAnonymously(input, resource)) repositories[envNameOf(resource)] = await placeholder({ workspaceId, sessionId: session.id }, resource.id);
      }
      return [...vaults, ...placeholderSubstitutions(repositories, "repository")];
    },

    /** The relay's credential view: the resolver's plus each repository's
     * token, substituted on that repository's host only. */
    relayCredentials<C extends Pick<ManagedCredentialResolver, "outboundTarget" | "forward" | "sandboxEgress">>(resolver: C): C {
      return Object.assign(Object.create(resolver) as C, {
        sandboxEgress: async (scope: Parameters<C["sandboxEgress"]>[0], hostname: string) => {
          const plan = await resolver.sandboxEgress(scope, hostname);
          const session = await input.findSession(scope);
          if (session === null || placeholders === null) return plan;
          const secrets: VaultSubstitutionSecret[] = [];
          for (const resource of repositoriesOf(session)) {
            const host = hostOf(resource.url);
            if (host === null || clonesAnonymously(input, resource)) continue;
            const value = await repositoryToken(input, scope, resource).catch(() => null);
            secrets.push({ value, substitution: {
              credentialId: `repository:${resource.id}`, envName: envNameOf(resource),
              placeholder: await placeholder(scope, resource.id), hosts: [host], inject: { header: true, body: false },
            } });
          }
          return { ...plan, substitutions: [...plan.substitutions, ...secrets] };
        },
      });
    },
  };
}
