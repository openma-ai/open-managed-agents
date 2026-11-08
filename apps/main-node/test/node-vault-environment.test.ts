import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinSpecs, createSpecRegistry } from "../../../packages/cap/src/index.js";
import { ManagedCredentialResolver } from "../../../packages/managed-credential-resolver/src/index.js";
import { createVaultPlaceholders } from "../../../packages/sandbox-gateway/src/vault-substitution.js";

// Design §0.5 (research/sandbox-sdk-v2-design.md:366) and §8.8 (:1215): the
// Node sandbox no longer receives Vault environment_variable values. Every
// harness gets the per-Session placeholders the forwarder writes
// (refreshSandboxEnvironment → prepareSandboxEgress → placeholderEnvironment).
type Auth = { type: string; [key: string]: unknown };
const at = "2026-11-01T00:00:00.000Z";
const env = (id: string, vaultId: string, secretName: string, secretValue: string | null, archivedAt: string | null = null) => ({
  revision: 1,
  credential: { id, vaultId, archivedAt, createdAt: at, updatedAt: at, metadata: {}, auth: {
    type: "environment_variable", secretName, secretValue,
    networking: { type: "limited", allowedHosts: ["api.example.com"] }, injectionLocation: { header: true, body: false },
  } as Auth },
});
const other = (id: string, vaultId: string) => ({ revision: 1, credential: { id, vaultId, archivedAt: null, createdAt: at, updatedAt: at, metadata: {}, auth: { type: "static_bearer", token: "mcp-value-1234", mcpServerUrl: "https://mcp.example/mcp" } as Auth } });

function resolver(records: ReturnType<typeof env>[]) {
  const asked: string[] = [];
  return {
    asked,
    resolver: new ManagedCredentialResolver({
      credentials: { list: async ({ workspaceId, vaultId }: { workspaceId: string; vaultId: string }) => { asked.push(`${workspaceId}/${vaultId}`); return records.filter((r) => r.credential.vaultId === vaultId); } } as never,
      vaults: { find: async () => ({ vault: { archivedAt: null } }) },
      fetch, clock: { now: () => new Date(at) }, log: { warn() {} },
      placeholders: createVaultPlaceholders("node-vault-environment-secret"),
    }, createSpecRegistry(builtinSpecs)),
  };
}

describe("Vault environment variables on Node", () => {
  it("gives the sandbox placeholders for the session's environment_variable credentials, earlier Vaults first, never values", async () => {
    const f = resolver([
      env("cred_a", "vlt_a", "API_TOKEN", "value-from-a"),
      other("cred_mcp", "vlt_a"),
      env("cred_old", "vlt_a", "OLD", "value-gone", "2026-01-01T00:00:00Z"),
      env("cred_empty", "vlt_a", "EMPTY", null),
      env("cred_bad", "vlt_a", "bad-name", "value-bad"),
      env("cred_b", "vlt_b", "API_TOKEN", "value-from-b"),
      env("cred_region", "vlt_b", "REGION", "value-region"),
    ]);
    const scope = { workspaceId: "ws_1", sessionId: "sess_1", vaultIds: ["vlt_a", "vlt_b"] };
    const sandboxEnv = await f.resolver.placeholderEnvironment(scope);
    expect(Object.keys(sandboxEnv).sort()).toEqual(["API_TOKEN", "REGION"]);
    const placeholders = createVaultPlaceholders("node-vault-environment-secret");
    expect(sandboxEnv.API_TOKEN).toBe(await placeholders.placeholder(scope, "cred_a"));
    expect(JSON.stringify(sandboxEnv)).not.toMatch(/value-|mcp-value/u);
    expect(f.asked).toEqual(["ws_1/vlt_a", "ws_1/vlt_b"]);
    expect(await f.resolver.placeholderEnvironment({ ...scope, vaultIds: [] })).toEqual({});
  });

  it("has no plaintext injection path left", () => {
    expect(existsSync(fileURLToPath(new URL("../../../packages/control-plane-node/src/lib/vault-environment.ts", import.meta.url)))).toBe(false);
  });
});
