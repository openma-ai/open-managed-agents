import { describe, expect, it, vi } from "vitest";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { substituteVaultPlaceholders } from "../../../packages/sandbox-gateway/src/index.js";

import { createNodeRepositoryEgress } from "../../../packages/control-plane-node/src/lib/node-repository-egress.js";

const scope = { workspaceId: "ws_1", sessionId: "sess_1" };
const repository = {
  id: "res_repo", type: "github_repository", url: "https://github.com/acme/app.git", mountPath: "/workspace/app",
  createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
} as unknown as Session["resources"][number];
const session = { id: "sess_1", vaultIds: [], resources: [repository] } as unknown as Session;
const basic = (secret: string) => `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;

function egress(secret: string | undefined = "root-secret-for-tests") {
  return createNodeRepositoryEgress({
    secret,
    repositoryCredentials: { findGithubToken: vi.fn(async () => "ghp_repository_token") },
    findSession: async () => session,
  });
}
const resolver = {
  outboundTarget: vi.fn(),
  forward: vi.fn(),
  sandboxEgress: vi.fn(async () => ({ target: null, substitutions: [] })),
};

describe("Node repository credential egress", () => {
  it("gives git a placeholder and the plan one header-only substitution per repository", async () => {
    const repos = egress();
    const placeholder = await repos.placeholder({ ...scope, resourceId: "res_repo" });
    expect(placeholder).toMatch(/^oma_vault_/);
    expect(placeholder).not.toContain("ghp_");
    const substitutions = await repos.substitutions({ workspaceId: "ws_1", session }, () => { throw new Error("no Vaults, no resolver"); });
    expect(substitutions).toHaveLength(1);
    expect(JSON.stringify(substitutions)).toContain(placeholder);
    expect(JSON.stringify(substitutions)).not.toContain("ghp_repository_token");
  });

  it("swaps the token in on the repository's host only", async () => {
    const repos = egress();
    const placeholder = await repos.placeholder({ ...scope, resourceId: "res_repo" });
    const credentials = repos.relayCredentials(resolver as never) as unknown as typeof resolver;
    const onGithub = await credentials.sandboxEgress(scope as never, "github.com");
    const swapped = substituteVaultPlaceholders({
      host: "github.com", headers: new Headers({ authorization: basic(placeholder) }), body: null, secrets: onGithub.substitutions,
    });
    expect(swapped.ok && swapped.headers.get("authorization")).toBe(basic("ghp_repository_token"));
    const elsewhere = substituteVaultPlaceholders({
      host: "evil.example", headers: new Headers({ authorization: basic(placeholder) }), body: null,
      secrets: (await credentials.sandboxEgress(scope as never, "evil.example")).substitutions,
    });
    expect(elsewhere).toMatchObject({ ok: false, rule: "credential_host_mismatch" });
  });

  it("has no placeholders without the platform root secret", async () => {
    await expect(egress("").placeholder({ ...scope, resourceId: "res_repo" })).rejects.toThrow(/PLATFORM_ROOT_SECRET/);
  });
});
