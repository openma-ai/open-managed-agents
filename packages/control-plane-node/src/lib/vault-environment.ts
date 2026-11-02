import type { SandboxExecutor } from "@open-managed-agents/sandbox";

/** The part of a stored credential this step reads. */
export interface VaultCredentialRecord {
  readonly credential: {
    readonly archivedAt: string | null;
    readonly auth:
      | { readonly type: "environment_variable"; readonly secretName: string; readonly secretValue: string | null }
      | { readonly type: string };
  };
}

export interface VaultCredentialLister {
  list(input: {
    workspaceId: string;
    vaultId: string;
    includeArchived: boolean;
    limit: number;
  }): Promise<readonly VaultCredentialRecord[]>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The `environment_variable` credentials of a session's Vaults, by name. An
 * earlier Vault wins when two define the same name, the same order MCP
 * credentials are matched in.
 */
export async function vaultEnvironmentVariables(
  store: VaultCredentialLister,
  workspaceId: string,
  vaultIds: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const vaultId of vaultIds) {
    const records = await store.list({ workspaceId, vaultId, includeArchived: false, limit: 100 });
    for (const { credential } of records) {
      const auth = credential.auth;
      if (credential.archivedAt !== null || auth.type !== "environment_variable") continue;
      const { secretName, secretValue } = auth as { secretName: string; secretValue: string | null };
      if (secretValue === null || !ENV_NAME.test(secretName) || secretName in out) continue;
      out[secretName] = secretValue;
    }
  }
  return out;
}

/**
 * Put a session's Vault environment variables into its sandbox, so commands
 * the Agent runs see them. The sandbox holds the real values: there is no
 * egress proxy that would substitute them on the way out.
 */
export async function injectVaultEnvironment(
  sandbox: Pick<SandboxExecutor, "setEnvVars">,
  variables: Record<string, string>,
): Promise<string[]> {
  const names = Object.keys(variables);
  if (names.length === 0) return [];
  if (sandbox.setEnvVars === undefined) {
    throw new Error(`This sandbox cannot set environment variables, so Vault credentials ${names.join(", ")} cannot reach it`);
  }
  await sandbox.setEnvVars(variables);
  return names;
}
