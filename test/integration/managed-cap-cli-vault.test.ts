// @ts-nocheck
// Cloudflare composition for the OpenMA cap_cli extension on the managed
// /v1 Vault stack: credential CRUD, the device-flow routes mounted ahead of
// the official Vault routes, and the managed sandbox placeholder RPC.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const HEADERS = {
  "x-api-key": "test-key",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: unknown) {
  return api(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
}

describe("managed cap_cli Vault credentials (Cloudflare)", () => {
  it("creates, lists and archives cap_cli credentials with secrets hidden", async () => {
    const vault = await post("/v1/vaults", { display_name: "cli vault" });
    expect(vault.status).toBe(201);
    const { id } = await vault.json();

    const created = await post(`/v1/vaults/${id}/credentials`, {
      display_name: "gh",
      auth: { type: "cap_cli", cli_id: "gh", token: "gho_cf_secret", refresh_token: "ghr_cf_secret" },
    });
    const createdText = await created.text();
    expect(created.status, createdText).toBe(201);
    expect(createdText).not.toContain("cf_secret");
    const credential = JSON.parse(createdText);
    expect(credential.auth).toEqual({ type: "cap_cli", cli_id: "gh" });

    const unknown = await post(`/v1/vaults/${id}/credentials`, {
      auth: { type: "cap_cli", cli_id: "not-a-cli", token: "t" },
    });
    expect(unknown.status).toBe(400);

    const listed = await api(`/v1/vaults/${id}/credentials`, { headers: HEADERS });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain("cf_secret");

    const archived = await post(`/v1/vaults/${id}/credentials/${credential.id}/archive`, {});
    expect(archived.status).toBe(200);
  });

  it("serves the device-flow extension without shadowing the official Vault routes", async () => {
    const vault = await post("/v1/vaults", { display_name: "device flow vault" });
    const { id } = await vault.json();

    expect((await post(`/v1/vaults/${id}/cap_cli_device_flow`, { cli_id: "fly" })).status).toBe(400);
    expect((await post(`/v1/vaults/${id}/cap_cli_device_flow`, { cli_id: "nope" })).status).toBe(400);
    expect((await post("/v1/vaults/vlt_missing/cap_cli_device_flow", { cli_id: "gh" })).status).toBe(404);
    expect((await post(`/v1/vaults/${id}/cap_cli_device_flow/poll`, { flow_token: "forged" })).status).toBe(400);
    expect((await api(`/v1/vaults/${id}`, { headers: HEADERS })).status).toBe(200);
  });

  it("reports not_found for a non-managed session from the placeholder RPC", async () => {
    expect(await env.MAIN_MCP.resolveManagedCapCliEnvironment({
      tenantId: "default",
      sessionId: "sess_does_not_exist",
    })).toEqual({ type: "not_found" });
  });
});
