import { describe, expect, it } from "vitest";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import type { CredentialStore, StoredCredential } from "@open-managed-agents/credential-store";
import type { CredentialAuth } from "@open-managed-agents/domain/credentials";
import { ManagedCredentialResolver, createCredentialEgressCore } from "../src/index";

// Vault sandbox credentials as compiled into the sandbox and the gateway
// (design §0.7 "Vault 占位符替换"). Values here are test fixtures.
const at = "2026-11-01T00:00:00.000Z";
const record = (id: string, auth: CredentialAuth): StoredCredential => ({
  revision: 1,
  credential: { id, vaultId: "vlt_1", archivedAt: null, createdAt: at, updatedAt: at, metadata: {}, auth },
});
const envVar = record("cred_env", {
  type: "environment_variable", secretName: "API_TOKEN", secretValue: "env-secret-value",
  networking: { type: "limited", allowedHosts: ["api.example.com"] }, injectionLocation: { header: true, body: false },
});
const gh = record("cred_gh", { type: "cap_cli", cliId: "gh", token: "gh-real-token" });

function resolver(records: StoredCredential[]) {
  const credentials = { list: async ({ vaultId }: { vaultId: string }) => records.filter((r) => r.credential.vaultId === vaultId) } as unknown as CredentialStore;
  return new ManagedCredentialResolver({
    vaults: { find: async () => ({ vault: { archivedAt: null } }) }, credentials,
    fetch, clock: { now: () => new Date(at) }, log: { warn() {} },
  }, createSpecRegistry(builtinSpecs));
}
const scope = { workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt_1"] };

describe("Vault sandbox credentials", () => {
  it("writes the cap_cli spec's fixed placeholder and nothing for environment_variable", async () => {
    const env = await resolver([envVar, gh]).placeholderEnvironment(scope);
    expect(env).toEqual({ GITHUB_TOKEN: "__cap_managed__" });
    expect(JSON.stringify(env)).not.toContain("env-secret-value");
  });

  it("has no gateway target for an environment_variable host, so it is never substituted", async () => {
    const r = resolver([envVar]);
    expect(await r.outboundTarget(scope, "api.example.com")).toBeNull();
    const sent: Request[] = [];
    const core = createCredentialEgressCore({ credentials: r, send: async (request) => { sent.push(request); return new Response("ok"); } });
    expect(await (await core.resolve(scope, "https://api.example.com/v1")).json()).toEqual({ inject: false });
    const denied = await core.forward(scope, { target: "https://api.example.com/v1", method: "GET", headers: new Headers({ authorization: "Bearer x" }), body: null });
    expect(denied.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("injects cap_cli by spec host regardless of the placeholder the sandbox sent", async () => {
    const sent: Request[] = [];
    const core = createCredentialEgressCore({ credentials: resolver([gh]), send: async (request) => { sent.push(request); return new Response("ok"); } });
    expect(await (await core.resolve(scope, "https://api.github.com/user")).json()).toEqual({ inject: true });
    const response = await core.forward(scope, { target: "https://api.github.com/user", method: "GET", headers: new Headers({ authorization: "Bearer __cap_managed__" }), body: null });
    expect(response.status).toBe(200);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer gh-real-token");
  });
});
