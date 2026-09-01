import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { DeploymentsApplicationPort } from "../src/index";
import {
  deploymentRunView,
  deploymentView,
  makeDeploymentsPort,
} from "./deployment-fixtures";
import { buildDeploymentsTestApi } from "./test-api";

function makeClient(port: DeploymentsApplicationPort): Anthropic {
  const api = buildDeploymentsTestApi({ deployments: port });
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

describe("Managed Agents API — deployments", () => {
  it("creates a deployment with typed events, resources, and schedule", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDeploymentsPort({
        createDeployment: async (command) => {
          calls.push(command);
          return { type: "created", deployment: deploymentView };
        },
      }),
    );

    const deployment = await client.beta.deployments.create({
      agent: { type: "agent", id: "agent_01", version: 3 },
      environment_id: "env_01",
      initial_events: [
        {
          type: "user.message",
          content: [
            { type: "text", text: "Inspect the repository" },
            { type: "image", source: { type: "file", file_id: "file_img" } },
            {
              type: "document",
              source: { type: "url", url: "https://example.com/spec.pdf" },
              title: "Specification",
            },
            { type: "redacted" },
          ],
        },
        {
          type: "user.define_outcome",
          description: "Repository is healthy",
          rubric: { type: "file", file_id: "file_rubric" },
          max_iterations: 3,
        },
        {
          type: "system.message",
          content: [{ type: "text", text: "Use conservative changes" }],
        },
      ],
      name: "repository-maintenance",
      budget: {
        type: "limit",
        max_list_cost: { amount: "500", currency: "USD" },
      },
      description: "Daily repository maintenance",
      metadata: { team: "platform" },
      resources: [
        {
          type: "file",
          file_id: "file_01",
          mount_path: "/workspace/input.txt",
        },
        {
          type: "github_repository",
          authorization_token: "github-secret",
          url: "https://github.com/example/repo",
          checkout: { type: "branch", name: "main" },
          mount_path: "/workspace/repo",
        },
        {
          type: "memory_store",
          memory_store_id: "memstore_01",
          access: "read_write",
          instructions: "Record durable facts",
        },
      ],
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
      },
      vault_ids: ["vlt_01"],
    });

    expect(calls).toEqual([
      {
        agent: { kind: "versioned", agentId: "agent_01", version: 3 },
        environmentId: "env_01",
        initialEvents: [
          {
            type: "user.message",
            content: [
              { type: "text", text: "Inspect the repository" },
              { type: "image", source: { type: "file", fileId: "file_img" } },
              {
                type: "document",
                source: { type: "url", url: "https://example.com/spec.pdf" },
                title: "Specification",
              },
              { type: "redacted" },
            ],
          },
          {
            type: "user.define_outcome",
            description: "Repository is healthy",
            rubric: { type: "file", fileId: "file_rubric" },
            maxIterations: 3,
          },
          {
            type: "system.message",
            content: [{ type: "text", text: "Use conservative changes" }],
          },
        ],
        name: "repository-maintenance",
        budget: { amountMinor: "500", currency: "USD" },
        description: "Daily repository maintenance",
        metadata: { team: "platform" },
        resources: [
          {
            kind: "file",
            fileId: "file_01",
            mountPath: "/workspace/input.txt",
          },
          {
            kind: "github_repository",
            authorizationToken: "github-secret",
            url: "https://github.com/example/repo",
            checkout: { type: "branch", name: "main" },
            mountPath: "/workspace/repo",
          },
          {
            kind: "memory_store",
            memoryStoreId: "memstore_01",
            access: "read_write",
            instructions: "Record durable facts",
          },
        ],
        schedule: { expression: "0 9 * * 1-5", timezone: "UTC" },
        vaultIds: ["vlt_01"],
      },
    ]);
    expect(deployment).toMatchObject({
      id: "depl_01",
      agent: { id: "agent_01", type: "agent", version: 3 },
      budget: {
        type: "limit",
        max_list_cost: { amount: "500", currency: "USD" },
      },
      resources: [
        { type: "file", file_id: "file_01" },
        { type: "github_repository", url: "https://github.com/example/repo" },
        { type: "memory_store", memory_store_id: "memstore_01" },
      ],
      schedule: { type: "cron", expression: "0 9 * * 1-5" },
      type: "deployment",
    });
  });

  it("retrieves a deployment", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDeploymentsPort({
        retrieveDeployment: async (query) => {
          calls.push(query);
          return { type: "found", deployment: deploymentView };
        },
      }),
    );

    await client.beta.deployments.retrieve("depl_01");

    expect(calls).toEqual([{ deploymentId: "depl_01" }]);
  });

  it("updates nullable and replacement fields", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDeploymentsPort({
        updateDeployment: async (command) => {
          calls.push(command);
          return { type: "updated", deployment: deploymentView };
        },
      }),
    );

    await client.beta.deployments.update("depl_01", {
      agent: "agent_02",
      budget: null,
      description: null,
      environment_id: "env_02",
      metadata: null,
      resources: null,
      schedule: null,
      vault_ids: null,
    });

    expect(calls).toEqual([
      {
        deploymentId: "depl_01",
        agent: { kind: "latest", agentId: "agent_02" },
        budget: null,
        description: null,
        environmentId: "env_02",
        metadata: null,
        resources: null,
        schedule: null,
        vaultIds: null,
      },
    ]);
  });

  it("maps a concurrent deployment update to the official conflict error", async () => {
    const client = makeClient(
      makeDeploymentsPort({
        updateDeployment: async () => ({
          type: "version_conflict",
          message: "Deployment changed concurrently at revision 2",
        }),
      }),
    );

    await expect(
      client.beta.deployments.update("depl_01", { name: "next-name" }),
    ).rejects.toMatchObject({
      status: 409,
      type: "conflict_error",
      error: {
        error: {
          type: "conflict_error",
          message: "Deployment changed concurrently at revision 2",
        },
      },
    });
  });

  it("maps a missing update dependency to the official not-found error", async () => {
    const client = makeClient(
      makeDeploymentsPort({
        updateDeployment: async () => ({
          type: "dependency_not_found",
          message: "Environment env_missing was not found",
        }),
      }),
    );

    await expect(
      client.beta.deployments.update("depl_01", {
        environment_id: "env_missing",
      }),
    ).rejects.toMatchObject({
      status: 404,
      type: "not_found_error",
      error: {
        error: {
          type: "not_found_error",
          message: "Environment env_missing was not found",
        },
      },
    });
  });

  it("lists deployments with semantic filters", async () => {
    const calls: unknown[] = [];
    const paused = {
      ...deploymentView,
      status: "paused" as const,
      pausedReason: {
        kind: "error" as const,
        errorType: "environment_archived_error" as const,
      },
    };
    const client = makeClient(
      makeDeploymentsPort({
        listDeployments: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { deployments: [paused], nextCursor: "deployment_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.deployments.list({
      limit: 10,
      page: "deployment_page_01",
      agent_id: "agent_01",
      "created_at[gte]": "2026-08-01T00:00:00Z",
      "created_at[lte]": "2026-08-31T23:59:59Z",
      include_archived: true,
      status: "paused",
    });

    expect(calls).toEqual([
      {
        pageSize: 10,
        cursor: "deployment_page_01",
        agentId: "agent_01",
        createdAtOrAfter: "2026-08-01T00:00:00Z",
        createdAtOrBefore: "2026-08-31T23:59:59Z",
        includeArchived: true,
        status: "paused",
      },
    ]);
    expect(page.data[0]?.paused_reason).toEqual({
      type: "error",
      error: { type: "environment_archived_error" },
    });
  });

  it.each([
    ["archive", "archiveDeployment"],
    ["pause", "pauseDeployment"],
    ["unpause", "unpauseDeployment"],
  ] as const)("maps %s to its dedicated port method", async (operation, method) => {
    const calls: unknown[] = [];
    const port = makeDeploymentsPort({
      [method]: async (command: { deploymentId: string }) => {
        calls.push(command);
        return { type: "changed", deployment: deploymentView };
      },
    });
    const client = makeClient(port);

    await client.beta.deployments[operation]("depl_01");

    expect(calls).toEqual([{ deploymentId: "depl_01" }]);
  });

  it("runs a deployment and returns the new run", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDeploymentsPort({
        runDeployment: async (command) => {
          calls.push(command);
          return { type: "started", run: deploymentRunView };
        },
      }),
    );

    const run = await client.beta.deployments.run("depl_01");

    expect(calls).toEqual([{ deploymentId: "depl_01" }]);
    expect(run).toMatchObject({
      id: "drun_01",
      deployment_id: "depl_01",
      trigger_context: { type: "manual" },
      type: "deployment_run",
    });
  });
});
