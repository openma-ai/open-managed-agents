import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  buildEnvironmentRoutes,
  type EnvironmentsApplicationPort,
} from "../src/index";
import { makeEnvironmentsPort } from "./environment-fixtures";

const BETA = "managed-agents-2026-04-01";

const environmentView = (openma?: { sandboxImage?: string }) => ({
  id: "env_01",
  archivedAt: null,
  config: {
    type: "cloud" as const,
    networking: { type: "unrestricted" as const },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: ["polars"] },
  },
  createdAt: "2026-10-23T08:00:00.000Z",
  description: null,
  metadata: {},
  name: "analytics",
  updatedAt: "2026-10-23T08:00:00.000Z",
  ...(openma !== undefined && { openma }),
});

const catalog = { has: (alias: string) => alias === "analytics" };

function api(port: EnvironmentsApplicationPort, withCatalog = true) {
  const app = new Hono();
  app.route(
    "/v1/environments",
    buildEnvironmentRoutes(port, withCatalog ? { sandboxImages: catalog } : {}),
  );
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": BETA },
    body: JSON.stringify(body),
  });
}

describe("Managed Agents API — Environment _oma.sandbox_image", () => {
  it("accepts a catalog alias on create and returns it under _oma", async () => {
    const calls: unknown[] = [];
    const app = api(makeEnvironmentsPort({
      createEnvironment: async (command) => {
        calls.push(command);
        return { type: "created", environment: environmentView({ sandboxImage: "analytics" }) };
      },
    }));

    const response = await post(app, "/v1/environments", {
      name: "analytics",
      config: { type: "cloud", packages: { pip: ["polars"] } },
      _oma: { sandbox_image: "analytics" },
    });

    expect(response.status).toBe(201);
    expect(calls).toEqual([{
      name: "analytics",
      config: { type: "cloud", packages: { pip: ["polars"] } },
      openma: { sandboxImage: "analytics" },
    }]);
    expect(await response.json()).toMatchObject({
      id: "env_01",
      type: "environment",
      _oma: { sandbox_image: "analytics" },
    });
  });

  it("rejects an alias that is not in the catalog with 400 on create and update", async () => {
    const app = api(makeEnvironmentsPort({}));
    for (const [path, body] of [
      ["/v1/environments", { name: "x", _oma: { sandbox_image: "registry.example/any:latest" } }],
      ["/v1/environments/env_01", { _oma: { sandbox_image: "missing" } }],
    ] as const) {
      const response = await post(app, path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: expect.stringContaining("_oma.sandbox_image"),
        },
      });
    }
  });

  it("rejects any selection when the deployment publishes no catalog", async () => {
    const response = await post(api(makeEnvironmentsPort({}), false), "/v1/environments", {
      name: "x",
      _oma: { sandbox_image: "analytics" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects unknown _oma keys and empty aliases through the strict schema", async () => {
    const app = api(makeEnvironmentsPort({}));
    expect((await post(app, "/v1/environments", { name: "x", _oma: { image: "a" } })).status).toBe(400);
    expect((await post(app, "/v1/environments", { name: "x", _oma: { sandbox_image: "" } })).status).toBe(400);
  });

  it("clears the selection with null on update", async () => {
    const calls: unknown[] = [];
    const app = api(makeEnvironmentsPort({
      updateEnvironment: async (command) => {
        calls.push(command);
        return { type: "updated", environment: environmentView() };
      },
    }));
    const response = await post(app, "/v1/environments/env_01", { _oma: { sandbox_image: null } });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ environmentId: "env_01", openma: { sandboxImage: null } }]);
    expect(await response.json()).not.toHaveProperty("_oma");
  });

  it("keeps the CMA wire shape byte-identical when _oma is omitted", async () => {
    const calls: unknown[] = [];
    const app = api(makeEnvironmentsPort({
      createEnvironment: async (command) => {
        calls.push(command);
        return { type: "created", environment: environmentView() };
      },
      retrieveEnvironment: async () => ({ type: "found", environment: environmentView({ sandboxImage: "analytics" }) }),
    }));
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => app.fetch(
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
      ),
    });

    const created = await client.beta.environments.create({ name: "analytics", config: { type: "cloud" } });
    expect(calls).toEqual([{ name: "analytics", config: { type: "cloud" } }]);
    expect(Object.keys(created).sort()).toEqual([
      "archived_at", "config", "created_at", "description", "id", "metadata", "name", "type", "updated_at",
    ]);

    // The official SDK tolerates the extension on read.
    const retrieved = await client.beta.environments.retrieve("env_01");
    expect(retrieved).toMatchObject({ id: "env_01", _oma: { sandbox_image: "analytics" } });
  });
});
