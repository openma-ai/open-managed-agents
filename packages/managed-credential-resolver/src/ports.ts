import type { CredentialStore } from "@open-managed-agents/credential-store";

/**
 * Platform dependencies of the resolver. Storage and its encryption are one
 * port: `CredentialStore` (e.g. `SqlCredentialStore` over D1 or a Node SQL
 * client, sealed with the platform's cipher). Everything else the resolver
 * touches outside memory is injected here.
 */
export interface ManagedCredentialResolverPorts {
  credentials: CredentialStore;
  /** Current Vault authority, deliberately narrower than its persistence Port. */
  vaults: { find(input: { workspaceId: string; vaultId: string }): Promise<{ vault: { archivedAt: string | null } } | null> };
  /** Transport for OAuth token endpoints. */
  fetch: typeof fetch;
  clock: { now(): Date };
  log: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
}
