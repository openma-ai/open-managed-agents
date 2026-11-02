import { describe, expect, it } from "vitest";
import {
  injectVaultEnvironment,
  vaultEnvironmentVariables,
  type VaultCredentialRecord,
} from "../../../packages/control-plane-node/src/lib/vault-environment.js";

const env = (secretName: string, secretValue: string | null, archivedAt: string | null = null): VaultCredentialRecord => ({
  credential: { archivedAt, auth: { type: "environment_variable", secretName, secretValue } },
});

const store = (vaults: Record<string, VaultCredentialRecord[]>) => {
  const asked: string[] = [];
  return {
    asked,
    list: async ({ workspaceId, vaultId }: { workspaceId: string; vaultId: string }) => {
      asked.push(`${workspaceId}/${vaultId}`);
      return vaults[vaultId] ?? [];
    },
  };
};

describe("Vault environment variables", () => {
  it("collects the session's environment_variable credentials, earlier Vaults first", async () => {
    const s = store({
      vlt_a: [
        env("API_TOKEN", "from-a"),
        { credential: { archivedAt: null, auth: { type: "static_bearer" } } },
        env("OLD", "gone", "2026-01-01T00:00:00Z"),
        env("EMPTY", null),
        env("bad-name", "x"),
      ],
      vlt_b: [env("API_TOKEN", "from-b"), env("REGION", "cn")],
    });
    expect(await vaultEnvironmentVariables(s, "ws_1", ["vlt_a", "vlt_b"])).toEqual({ API_TOKEN: "from-a", REGION: "cn" });
    expect(s.asked).toEqual(["ws_1/vlt_a", "ws_1/vlt_b"]);
    expect(await vaultEnvironmentVariables(s, "ws_1", [])).toEqual({});
  });

  it("sets them in the sandbox, and fails when the sandbox cannot take them", async () => {
    const set: Record<string, string>[] = [];
    const sandbox = { setEnvVars: async (vars: Record<string, string>) => void set.push(vars) };
    expect(await injectVaultEnvironment(sandbox, { API_TOKEN: "t" })).toEqual(["API_TOKEN"]);
    expect(set).toEqual([{ API_TOKEN: "t" }]);
    expect(await injectVaultEnvironment(sandbox, {})).toEqual([]);
    expect(set).toHaveLength(1);
    await expect(injectVaultEnvironment({}, { API_TOKEN: "t" })).rejects.toThrow(/API_TOKEN/);
    await expect(injectVaultEnvironment({}, {})).resolves.toEqual([]);
  });
});
