import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";

const KEY = "sandbox-images-test-key";
const BETA = "managed-agents-2026-04-01";
let cp: NodeControlPlane | undefined;
let dir: string | undefined;

afterAll(async () => {
  await cp?.stop("test");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function controlPlane(): Promise<NodeControlPlane> {
  const root = resolve(".test-artifacts");
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, "sandbox-images-"));
  const config = loadNodeConfig({
    NODE_ENV: "test", AUTH_DISABLED: "1", MEMORY_QUEUE: "disabled", API_KEY: KEY,
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    DATABASE_PATH: join(dir, "oma.db"), AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"), MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"), SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    SANDBOX_IMAGES: JSON.stringify({
      analytics: {
        reference: "registry.internal.example/oma/analytics:2026-10",
        label: "Analytics",
        description: "pandas, polars, Claude ACP",
      },
    }),
  });
  return createNodeControlPlane(await nodeDefaults(config, {
    auth: { description: "test", handler: () => new Response("not found", { status: 404 }),
      resolveSession: async () => null, findUser: async () => null },
  }));
}

function call(path: string, init: { method?: string; body?: unknown } = {}) {
  return cp!.fetch(new Request(`http://cp${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "x-api-key": KEY, "anthropic-beta": BETA, "content-type": "application/json" },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  }));
}

describe("Node control plane — SANDBOX_IMAGES", () => {
  it("lists the catalog without references and persists a selected alias on an Environment", async () => {
    cp = await controlPlane();

    expect((await cp.fetch(new Request("http://cp/v1/oma/sandbox_images"))).status).toBe(401);
    const listing = await call("/v1/oma/sandbox_images");
    expect(listing.status).toBe(200);
    const body = await listing.text();
    expect(JSON.parse(body)).toEqual({
      data: [{ type: "sandbox_image", alias: "analytics", label: "Analytics", description: "pandas, polars, Claude ACP" }],
    });
    expect(body).not.toContain("registry.internal.example");

    const plain = await call("/v1/environments", { body: { name: "plain", config: { type: "cloud" } } });
    expect(plain.status).toBe(201);
    expect(await plain.json()).not.toHaveProperty("_oma");

    const rejected = await call("/v1/environments", {
      body: { name: "raw", _oma: { sandbox_image: "registry.internal.example/other:latest" } },
    });
    expect(rejected.status).toBe(400);

    const created = await call("/v1/environments", {
      body: { name: "analytics", config: { type: "cloud", packages: { pip: ["polars"] } }, _oma: { sandbox_image: "analytics" } },
    });
    expect(created.status).toBe(201);
    const environment = await created.json() as { id: string; _oma?: unknown };
    expect(environment._oma).toEqual({ sandbox_image: "analytics" });

    const retrieved = await call(`/v1/environments/${environment.id}`);
    expect(await retrieved.json()).toMatchObject({ _oma: { sandbox_image: "analytics" } });

    // A config-only update keeps the selection; null clears it.
    const renamed = await call(`/v1/environments/${environment.id}`, {
      body: { name: "analytics-2", config: { type: "cloud" } },
    });
    expect(await renamed.json()).toMatchObject({ name: "analytics-2", _oma: { sandbox_image: "analytics" } });
    const cleared = await call(`/v1/environments/${environment.id}`, { body: { _oma: { sandbox_image: null } } });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).not.toHaveProperty("_oma");
  });
});
