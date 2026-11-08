import type { SpecRegistry } from "@open-managed-agents/cap";
import type { StoredCredential } from "@open-managed-agents/credential-store";
import type { ManagedCredentialResolverPorts } from "./ports";
import { findActiveCredential, refreshCredential } from "./refresh";
import {
  compileVaultSubstitutions,
  vaultSandboxCredentialIds,
  type VaultSubstitutionSecret,
} from "@open-managed-agents/sandbox-gateway/vault-substitution";
import {
  selectMcpTarget,
  selectOutboundTarget,
  type ManagedCredentialTarget,
} from "./selection";

const PAGE_SIZE = 100;

export interface ManagedSessionScope {
  workspaceId: string;
  sessionId: string;
  vaultIds: readonly string[];
}

export interface ForwardOutcome {
  response: Response;
  refreshed: boolean;
  refreshFailed: boolean;
  refreshFailureCode: string | null;
}

/**
 * Managed Vault credentials for a Session, shared by every proxy that injects
 * them (Cloudflare MCP proxy and sandbox egress, Node MCP proxy). Platform
 * specifics arrive through {@link ManagedCredentialResolverPorts}.
 */
export class ManagedCredentialResolver {
  constructor(
    private readonly ports: ManagedCredentialResolverPorts,
    private readonly registry: SpecRegistry,
  ) {}

  /**
   * All credentials (archived included; selection skips them) of the
   * Session's Vaults, in Vault order. A store failure is not "no
   * credentials": it is logged and rethrown so the caller fails instead of
   * forwarding without the Vault credential.
   */
  async listForSession(scope: ManagedSessionScope): Promise<StoredCredential[]> {
    try {
      const records: StoredCredential[] = [];
      for (const vaultId of scope.vaultIds) {
        const current = await this.ports.vaults.find({ workspaceId: scope.workspaceId, vaultId });
        if (current === null || current.vault.archivedAt !== null) continue;
        let position: { createdAt: string; credentialId: string } | undefined;
        for (;;) {
          const page = await this.ports.credentials.list({
            workspaceId: scope.workspaceId,
            vaultId,
            includeArchived: true,
            limit: PAGE_SIZE,
            ...(position !== undefined && { position }),
          });
          records.push(...page);
          if (page.length < PAGE_SIZE) break;
          const last = page.at(-1)!;
          position = { createdAt: last.credential.createdAt, credentialId: last.credential.id };
        }
      }
      return records;
    } catch (error) {
      this.ports.log.warn(
        {
          op: "managed_credentials.unavailable",
          tenant_id: scope.workspaceId,
          session_id: scope.sessionId,
          error: error instanceof Error ? error.name : "Error",
        },
        "managed Vault credentials could not be read",
      );
      throw error;
    }
  }

  async mcpTarget(scope: ManagedSessionScope, serverUrl: string): Promise<ManagedCredentialTarget | null> {
    if (scope.vaultIds.length === 0) return null;
    return selectMcpTarget(await this.listForSession(scope), serverUrl);
  }

  async outboundTarget(scope: ManagedSessionScope, hostname: string): Promise<ManagedCredentialTarget | null> {
    if (scope.vaultIds.length === 0) return null;
    return selectOutboundTarget(await this.listForSession(scope), hostname, this.registry);
  }

  /** What the sandbox env gets: placeholders for environment_variable and
   * cap_cli credentials (never their values) plus non-secret CLI bootstrap
   * values. CF SessionDO, the CF E2B forwarder and the Node forwarder all
   * write exactly this (design §0.1, §8.0). */
  async placeholderEnvironment(scope: ManagedSessionScope): Promise<Record<string, string>> {
    const { secrets, env } = await this.compile(scope, await this.recordsFor(scope));
    return { ...env, ...Object.fromEntries(secrets.map(({ substitution }) => [substitution.envName, substitution.placeholder])) };
  }

  /** Gateway view of one egress request: the cap_cli / MCP injection target
   * for `hostname` and every substitution of the Session (to refuse a
   * placeholder sent to a host its credential does not allow). One listing. */
  async sandboxEgress(scope: ManagedSessionScope, hostname: string): Promise<{
    target: ManagedCredentialTarget | null;
    substitutions: VaultSubstitutionSecret[];
  }> {
    const records = await this.recordsFor(scope);
    return {
      target: records.length === 0 ? null : selectOutboundTarget(records, hostname, this.registry),
      substitutions: (await this.compile(scope, records)).secrets,
    };
  }

  /** Credentials of the Session's Vaults that only work through egress substitution. */
  async sandboxCredentialIds(scope: Pick<ManagedSessionScope, "workspaceId" | "vaultIds">): Promise<string[]> {
    return vaultSandboxCredentialIds(await this.recordsFor({ ...scope, sessionId: "" }));
  }

  private async recordsFor(scope: ManagedSessionScope): Promise<StoredCredential[]> {
    return scope.vaultIds.length === 0 ? [] : this.listForSession(scope);
  }

  private async compile(scope: ManagedSessionScope, records: readonly StoredCredential[]) {
    if (this.ports.placeholders === undefined) {
      if (vaultSandboxCredentialIds(records).length > 0) {
        throw new Error("Vault environment_variable and cap_cli credentials need sandbox placeholders (PLATFORM_ROOT_SECRET)");
      }
      return { secrets: [], env: {} };
    }
    return compileVaultSubstitutions({ scope, records, specs: this.registry, placeholders: this.ports.placeholders });
  }

  /** New token after the upstream rejected `staleToken`, or null. */
  refresh(
    workspaceId: string,
    target: ManagedCredentialTarget,
    staleToken: string,
    failure?: { code: string | null },
  ): Promise<string | null> {
    if (target.refresh === undefined) return Promise.resolve(null);
    return refreshCredential(this.ports, workspaceId, target.refresh, staleToken, failure);
  }

  /**
   * One upstream exchange with refresh: `send` injects the given token. A
   * 401 from a refreshable target refreshes the credential; only a
   * successful refresh retries, once, with the new token. A 403 is a
   * permission decision, not an expired token, and is returned as is. A refused refresh
   * returns the first response untouched, so a non-idempotent request is
   * never sent twice with the same token. `send` may run twice, so callers
   * must hand it a buffered (replayable) body.
   */
  async forward(
    workspaceId: string,
    target: ManagedCredentialTarget,
    send: (token: string) => Promise<Response>,
  ): Promise<ForwardOutcome> {
    const first = await send(target.upstreamToken);
    if (first.status !== 401 || target.refresh === undefined) {
      return { response: first, refreshed: false, refreshFailed: false, refreshFailureCode: null };
    }
    const failure: { code: string | null } = { code: null };
    const fresh = await this.refresh(workspaceId, target, target.upstreamToken, failure);
    if (fresh === null || await findActiveCredential(this.ports, {
      workspaceId, vaultId: target.refresh.vaultId, credentialId: target.refresh.credentialId,
    }) === null) {
      return { response: first, refreshed: false, refreshFailed: true, refreshFailureCode: failure.code };
    }
    // No awaited cleanup between the final authority check and dispatch. This
    // does not cancel calls already dispatched when a later archive completes.
    try {
      return { response: await send(fresh), refreshed: true, refreshFailed: false, refreshFailureCode: null };
    } finally {
      try {
        await first.body?.cancel();
      } catch {
        /* already consumed */
      }
    }
  }
}
