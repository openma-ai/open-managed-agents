import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  buildEnvironmentRoutes,
  type EnvironmentsApplicationPort,
} from "../src/index";
import { makeEnvironmentsPort } from "./environment-fixtures";

const BETA = "managed-agents-2026-04-01";

const selfHostedView = (runtime?: { runtimeId: string; env: Record<string, string> }) => ({
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" as const },
  createdAt: "2026-11-04T08:00:00.000Z",
  description: null,
  metadata: {},
  name: "laptop",
  updatedAt: "2026-11-04T08:00:00.000Z",
  ...(runtime !== undefined && { openma: { runtime } }),
});

function api(port: EnvironmentsApplicationPort) {
  const app = new Hono();
  app.route("/v1/environments", buildEnvironmentRoutes(port, {}));
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": BETA },
    body: JSON.stringify(body),
  });
}

describe("Managed Agents API — Environment _oma.runtime", () => {
  it("maps a Runtime attachment with env overlay on create and echoes it under _oma", async () => {
    const calls: unknown[] = [];
    const app = api(makeEnvironmentsPort({
      createEnvironment: async (command) => {
        calls.push(command);
        return {
          type: "created",
          environment: selfHostedView({ runtimeId: "rt_1", env: { NODE_ENV: "development" } }),
        };
      },
    }));

    const response = await post(app, "/v1/environments", {
      name: "laptop",
      config: { type: "self_hosted" },
      _oma: { runtime: { runtime_id: "rt_1", env: { NODE_ENV: "development" } } },
    });

    expect(response.status).toBe(201);
    expect(calls).toEqual([{
      name: "laptop",
      config: { type: "self_hosted" },
      openma: { runtime: { runtimeId: "rt_1", env: { NODE_ENV: "development" } } },
    }]);
    expect(await response.json()).toMatchObject({
      config: { type: "self_hosted" },
      _oma: { runtime: { runtime_id: "rt_1", env: { NODE_ENV: "development" } } },
    });
  });

  it("defaults env to {} and detaches with null on update", async () => {
    const calls: unknown[] = [];
    const app = api(makeEnvironmentsPort({
      updateEnvironment: async (command) => {
        calls.push(command);
        return { type: "updated", environment: selfHostedView() };
      },
    }));
    await post(app, "/v1/environments/env_01", { _oma: { runtime: { runtime_id: "rt_2" } } });
    const detached = await post(app, "/v1/environments/env_01", { _oma: { runtime: null } });
    expect(calls).toEqual([
      { environmentId: "env_01", openma: { runtime: { runtimeId: "rt_2", env: {} } } },
      { environmentId: "env_01", openma: { runtime: null } },
    ]);
    expect(await detached.json()).not.toHaveProperty("_oma");
  });

  it("rejects malformed attachments through the strict schema", async () => {
    const app = api(makeEnvironmentsPort({}));
    for (const runtime of [
      { runtime_id: "" },
      { env: { A: "1" } },
      { runtime_id: "rt_1", env: { A: 1 } },
      { runtime_id: "rt_1", secrets: {} },
    ]) {
      const response = await post(app, "/v1/environments", { name: "x", _oma: { runtime } });
      expect(response.status).toBe(400);
    }
  });

  it("stays readable by the official SDK", async () => {
    const app = api(makeEnvironmentsPort({
      retrieveEnvironment: async () => ({
        type: "found",
        environment: selfHostedView({ runtimeId: "rt_1", env: {} }),
      }),
    }));
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => app.fetch(
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
      ),
    });
    const retrieved = await client.beta.environments.retrieve("env_01");
    expect(retrieved).toMatchObject({
      config: { type: "self_hosted" },
      _oma: { runtime: { runtime_id: "rt_1", env: {} } },
    });
  });
});
