// POST /v1/sessions on the Node control plane with a Vault holding an
// environment_variable credential (design §0.7, §8.0): the only egress path
// is the in-sandbox forwarder to the HTTPS relay, so a deployment without
// one refuses the Session with 400 instead of creating it (e2e
// session__ie7dakcwG71DL90IVY3t was created and leaked the placeholder).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";

const KEY = "node-vault-admission-key";
const BETA = "managed-agents-2026-04-01";
const opened: Array<{ cp: NodeControlPlane; dir: string }> = [];
afterEach(async () => {
  for (const { cp, dir } of opened.splice(0)) { await cp.stop("test"); rmSync(dir, { recursive: true, force: true }); }
});

async function controlPlane(publicBaseUrl: string | undefined) {
  const root = resolve(".test-artifacts");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "vault-admission-"));
  const config = loadNodeConfig({
    NODE_ENV: "test", AUTH_DISABLED: "1", MEMORY_QUEUE: "disabled", API_KEY: KEY,
    PLATFORM_ROOT_SECRET: "node-vault-admission-root-secret-0123456789",
    ...(publicBaseUrl === undefined ? {} : { PUBLIC_BASE_URL: publicBaseUrl }),
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    DATABASE_PATH: join(dir, "oma.db"), AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"), MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"), SESSION_OUTPUTS_DIR: join(dir, "outputs"),
  });
  const cp = await createNodeControlPlane(await nodeDefaults(config, {
    auth: { description: "test", handler: () => new Response("not found", { status: 404 }),
      resolveSession: async () => null, findUser: async () => null },
  }));
  opened.push({ cp, dir });
  const call = async (path: string, body: unknown) => {
    const response = await cp.fetch(new Request(`http://cp${path}`, {
      method: "POST", headers: { "x-api-key": KEY, "anthropic-beta": BETA, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  return call;
}

async function sessionWithVaultCredential(call: Awaited<ReturnType<typeof controlPlane>>) {
  const agent = await call("/v1/agents", { name: "vault-admission", model: "claude-sonnet-4-6", system: "test", tools: [] });
  const environment = await call("/v1/environments", { name: "vault-admission", config: { type: "cloud", networking: { type: "unrestricted" } } });
  const vault = await call("/v1/vaults", { display_name: "vault-admission" });
  const credential = await call(`/v1/vaults/${vault.json.id}/credentials`, { display_name: "envvar", auth: {
    type: "environment_variable", secret_name: "OMA_SECRET", secret_value: "not-a-real-secret",
    networking: { type: "limited", allowed_hosts: ["httpbin.org"] },
  } });
  expect([agent.status, environment.status, vault.status, credential.status]).toEqual([201, 201, 201, 201]);
  return call("/v1/sessions", { agent: agent.json.id, environment_id: environment.json.id, vault_ids: [vault.json.id] });
}

describe("Node Session create with Vault sandbox credentials", () => {
  it.each([
    { name: "no PUBLIC_BASE_URL", url: undefined },
    { name: "a plain-HTTP PUBLIC_BASE_URL", url: "http://localhost:8787" },
  ])("is refused with 400 when the deployment has no egress path ($name)", async ({ url }) => {
    const created = await sessionWithVaultCredential(await controlPlane(url));
    expect(created.status).toBe(400);
    expect(JSON.stringify(created.json)).toMatch(/does not support sandbox credentials/u);
  });

  it("is created when the forwarder relay has an HTTPS origin", async () => {
    const created = await sessionWithVaultCredential(await controlPlane("https://oma.example"));
    expect(created.status).toBe(201);
  });
});
