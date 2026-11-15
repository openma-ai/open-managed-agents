import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import { createVaultPlaceholders } from "@open-managed-agents/sandbox-gateway/vault-substitution";
import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";

// Pure data and immutable: built once, validated once.
const capRegistry = createSpecRegistry(builtinSpecs);

/**
 * Managed credentials live in `managed_credentials` (the official v1 Vault
 * API store); the legacy `Services.credentials` adapter reads a different
 * table and encryption context. v1 Sessions only read the former, through
 * the shared {@link ManagedCredentialResolver}.
 */
export function createManagedCredentialResolver(
  env: Env,
  tenantDb: D1Database,
): ManagedCredentialResolver {
  if (!env.PLATFORM_ROOT_SECRET) {
    throw new Error("PLATFORM_ROOT_SECRET is required for managed Vault credentials");
  }
  const crypto = new WebCryptoAesGcm(
    env.PLATFORM_ROOT_SECRET,
    "managed.vault.credentials",
  );
  const store = new SqlCredentialStore(new CfD1SqlClient(tenantDb), {
    seal: async ({ plaintext }) => ({ ciphertext: await crypto.encrypt(plaintext) }),
    open: async ({ ciphertext }) => ({ plaintext: await crypto.decrypt(ciphertext) }),
  });
  return new ManagedCredentialResolver({
    credentials: store,
    vaults: new SqlVaultStore(new CfD1SqlClient(tenantDb)),
    fetch: (input, init) => fetch(input, init),
    clock: { now: () => new Date() },
    log: { warn: (fields, message) => logWarn(fields, message) },
    placeholders: createVaultPlaceholders(env.PLATFORM_ROOT_SECRET),
  }, capRegistry);
}
