import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryAgentStore } from "@open-managed-agents/agent-store-memory";

import { loadNodeConfig, type NodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults, type NodeAuth, type NodeComponents, type NodeSecrets } from "../src/components";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(overrides: Record<string, string | undefined> = {}): NodeConfig {
  const dir = mkdtempSync(join(tmpdir(), "oma-components-"));
  dirs.push(dir);
  return loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
    ...overrides,
  });
}

async function boot(components: NodeComponents): Promise<NodeControlPlane> {
  const cp = await createNodeControlPlane(components);
  created.push(cp);
  return cp;
}

const v1 = { "anthropic-beta": "managed-agents-2026-04-01", "content-type": "application/json" };

describe("nodeDefaults", () => {
  it("builds every component from the config and reports what it chose", async () => {
    const components = await nodeDefaults(testConfig());
    expect(components.database.dialect).toBe("sqlite");
    expect(components.database.description).toMatch(/^sqlite /);
    expect(components.secrets).toBeNull(); // no PLATFORM_ROOT_SECRET
    expect(components.auth).toBeNull(); // AUTH_DISABLED
    expect(components.email).toBeNull();
    expect(components.realtime.description).toBe("in-process");
    expect(components.realtime.replicaSync).toBeNull();
    expect(components.blobs.memory.description).toMatch(/^localfs /);
    expect(components.blobs.files.description).toMatch(/^localfs /);
    expect(typeof components.sandbox).toBe("function");
    await components.database.stop?.();
  });

  it("keeps a component the caller already chose instead of building its own", async () => {
    const realtime = { hub: new InProcessEventStreamHub(), replicaSync: null, description: "mine" };
    const components = await nodeDefaults(testConfig(), { realtime, email: null });
    expect(components.realtime).toBe(realtime);
    await components.database.stop?.();
  });

  it("derives secrets from PLATFORM_ROOT_SECRET, one cipher per purpose", async () => {
    const components = await nodeDefaults(testConfig({ PLATFORM_ROOT_SECRET: "root-secret-0123456789" }));
    const a = components.secrets!.cipherFor("managed.vault.credentials");
    const b = components.secrets!.cipherFor("managed.deployments.resources");
    const sealed = await a.encrypt("hello");
    expect(await a.decrypt(sealed)).toBe("hello");
    await expect(b.decrypt(sealed)).rejects.toThrow(); // purposes are isolated
    await components.database.stop?.();
  });
});

describe("createNodeControlPlane(components)", () => {
  it("serves from whatever components it is handed", async () => {
    const cp = await boot(await nodeDefaults(testConfig()));
    const health = await cp.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", backends: { hub: "in-process" } });
  });

  it("uses a caller-supplied store for a resource instead of the SQL one", async () => {
    const agents = new MemoryAgentStore();
    const config = testConfig();
    const cp = await boot(await nodeDefaults(config, { stores: { agents } }));

    const created = await cp.fetch(new Request("http://localhost/v1/agents", {
      method: "POST", headers: v1,
      body: JSON.stringify({ name: "composed", model: "claude-sonnet-4-6", system: "hi" }),
    }));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };

    // The memory store has it; the SQL table does not.
    expect(await agents.findCurrent({ workspaceId: "default", agentId: id })).not.toBeNull();
    const row = await cp.components.database.sql.prepare("SELECT COUNT(*) AS n FROM managed_agents").first<{ n: number }>();
    expect(Number(row!.n)).toBe(0);
  });

  it("lets the realtime component decide whether /v1 streams tail the SQL projection", async () => {
    const config = testConfig();
    // Same in-process hub, but declared multi-replica: the control plane must
    // tail SQL for official streams, which is visible on /health.
    const cp = await boot(await nodeDefaults(config, {
      realtime: { hub: new InProcessEventStreamHub(), replicaSync: { pollIntervalMs: 50 }, description: "declared-multi" },
    }));
    const health = await (await cp.fetch(new Request("http://localhost/health"))).json() as {
      backends: { hub: string; v1_stream: string };
    };
    expect(health.backends.hub).toBe("declared-multi");
    expect(health.backends.v1_stream).toBe("sql-replicated");

    const single = await boot(await nodeDefaults(testConfig(), {
      realtime: { hub: new InProcessEventStreamHub(), replicaSync: null, description: "single" },
    }));
    const singleHealth = await (await single.fetch(new Request("http://localhost/health"))).json() as {
      backends: { v1_stream: string };
    };
    expect(singleHealth.backends.v1_stream).toBe("in-memory");
  });

  it("routes secret sealing through the caller-supplied secrets component", async () => {
    const purposes: string[] = [];
    const secrets: NodeSecrets = {
      cipherFor(purpose) {
        purposes.push(purpose);
        return {
          encrypt: async (plaintext) => `sealed:${purpose}:${plaintext}`,
          decrypt: async (ciphertext) => ciphertext.slice(`sealed:${purpose}:`.length),
        };
      },
    };
    const cp = await boot(await nodeDefaults(testConfig(), { secrets }));

    const vault = await cp.fetch(new Request("http://localhost/v1/vaults", {
      method: "POST", headers: v1, body: JSON.stringify({ display_name: "v" }),
    }));
    expect(vault.status).toBe(201);
    const { id } = await vault.json() as { id: string };
    const credential = await cp.fetch(new Request(`http://localhost/v1/vaults/${id}/credentials`, {
      method: "POST", headers: v1,
      body: JSON.stringify({
        display_name: "k",
        auth: { type: "static_bearer", token: "s3cret", mcp_server_url: "https://mcp.example.com" },
      }),
    }));
    expect(credential.status, await credential.text()).toBe(201);
    expect(purposes).toContain("managed.vault.credentials");
    const row = await cp.components.database.sql.prepare("SELECT sealed_document FROM managed_credentials").first<{ sealed_document: string }>();
    expect(row!.sealed_document).toMatch(/^sealed:managed\.vault\.credentials:/);
  });

  it("authenticates through the caller-supplied auth component", async () => {
    const auth: NodeAuth = {
      description: "test-auth",
      handler: async () => new Response("custom-auth", { status: 200 }),
      resolveSession: async (headers) =>
        headers.get("x-test-user") === "alice"
          ? { userId: "user_alice", email: "alice@example.com", name: "Alice" }
          : null,
      findUser: async (id) => (id === "user_alice" ? { name: "Alice", email: "alice@example.com" } : null),
    };
    const cp = await boot(await nodeDefaults(testConfig({ AUTH_DISABLED: undefined }), { auth }));

    expect(await (await cp.fetch(new Request("http://localhost/auth/anything"))).text()).toBe("custom-auth");
    expect((await (await cp.fetch(new Request("http://localhost/health"))).json() as { auth: string }).auth).toBe("test-auth");
    const anonymous = await cp.fetch(new Request("http://localhost/v1/agents", { headers: v1 }));
    expect(anonymous.status).toBe(401);
    const alice = await cp.fetch(new Request("http://localhost/v1/agents", { headers: { ...v1, "x-test-user": "alice" } }));
    expect(alice.status).toBe(200);
  });
});
