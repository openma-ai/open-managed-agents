// A shared ManagedCredentialResolver over a fake managed credential store,
// for tests of the proxies that call it.
import { builtinSpecs, createSpecRegistry } from "../../../packages/cap/src/index";
import type {
  CredentialStore,
  ReplaceCredential,
  ReplaceCredentialResult,
  StoredCredential,
} from "@open-managed-agents/credential-store";
import { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";

export interface FakeManagedCredentials {
  /** Records of the requested Vaults, in order; archived ones included. */
  listByVaults(input: { workspaceId: string; vaultIds: string[] }): Promise<StoredCredential[]>;
  find?(input: { workspaceId: string; vaultId: string; credentialId: string }): Promise<StoredCredential | null>;
  replace?(input: ReplaceCredential): Promise<ReplaceCredentialResult>;
}

export function managedResolver(fake: FakeManagedCredentials): ManagedCredentialResolver {
  const store: CredentialStore = {
    insert: async () => { throw new Error("unused"); },
    archive: async () => ({ type: "not_found" }),
    delete: async () => ({ type: "not_found" }),
    // One page per Vault: whatever the fake returns for that Vault.
    list: async ({ workspaceId, vaultId }) => fake.listByVaults({ workspaceId, vaultIds: [vaultId] }),
    find: async (input) => fake.find?.(input) ?? null,
    replace: async (input) => fake.replace?.(input) ?? { type: "not_found" },
  };
  return new ManagedCredentialResolver({
    credentials: store,
    fetch: (input, init) => fetch(input, init),
    clock: { now: () => new Date() },
    log: { warn: () => {} },
  }, createSpecRegistry(builtinSpecs));
}
