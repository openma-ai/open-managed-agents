import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type {
  DeploymentRunErrorType,
  DeploymentRunsApplicationPort,
  DeploymentRunView,
} from "../src/index";
import {
  deploymentRunView,
  makeDeploymentRunsPort,
} from "./deployment-fixtures";
import { buildDeploymentsTestApi } from "./test-api";

function makeClient(port: DeploymentRunsApplicationPort): Anthropic {
  const api = buildDeploymentsTestApi({ deploymentRuns: port });
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

describe("Managed Agents API — deployment runs", () => {
  it("retrieves a deployment run", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDeploymentRunsPort({
        retrieveDeploymentRun: async (query) => {
          calls.push(query);
          return { type: "found", run: deploymentRunView };
        },
      }),
    );

    const run = await client.beta.deploymentRuns.retrieve("drun_01");

    expect(calls).toEqual([{ deploymentRunId: "drun_01" }]);
    expect(run.session_id).toBe("session_01");
  });

  it("lists all error variants and both trigger contexts", async () => {
    const errorTypes: DeploymentRunErrorType[] = [
      "environment_archived_error",
      "agent_archived_error",
      "environment_not_found_error",
      "vault_not_found_error",
      "vault_archived_error",
      "file_not_found_error",
      "memory_store_archived_error",
      "skill_not_found_error",
      "session_resource_not_found_error",
      "workspace_archived_error",
      "organization_disabled_error",
      "session_rate_limited_error",
      "session_creation_rejected_error",
      "unknown_error",
      "self_hosted_resources_unsupported_error",
      "mcp_egress_blocked_error",
    ];
    const runs: DeploymentRunView[] = errorTypes.map((type, index) => ({
      ...deploymentRunView,
      id: `drun_error_${index}`,
      error: { type, message: `failure ${index}` },
      sessionId: null,
      triggerContext:
        index === 0
          ? { kind: "schedule", scheduledAt: "2026-08-27T09:00:00.000Z" }
          : { kind: "manual" },
    }));
    const calls: unknown[] = [];
    const client = makeClient(
      makeDeploymentRunsPort({
        listDeploymentRuns: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { runs, nextCursor: "run_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.deploymentRuns.list({
      limit: 20,
      page: "run_page_01",
      "created_at[gt]": "2026-08-01T00:00:00Z",
      "created_at[gte]": "2026-08-02T00:00:00Z",
      "created_at[lt]": "2026-09-01T00:00:00Z",
      "created_at[lte]": "2026-08-31T23:59:59Z",
      deployment_id: "depl_01",
      has_error: true,
      trigger_type: "schedule",
    });

    expect(calls).toEqual([
      {
        pageSize: 20,
        cursor: "run_page_01",
        createdAfter: "2026-08-01T00:00:00Z",
        createdAtOrAfter: "2026-08-02T00:00:00Z",
        createdBefore: "2026-09-01T00:00:00Z",
        createdAtOrBefore: "2026-08-31T23:59:59Z",
        deploymentId: "depl_01",
        hasError: true,
        triggerType: "schedule",
      },
    ]);
    expect(page.data.map((run) => run.error?.type)).toEqual(errorTypes);
    expect(page.data[0]?.trigger_context).toEqual({
      type: "schedule",
      scheduled_at: "2026-08-27T09:00:00.000Z",
    });
    expect(page.data[1]?.trigger_context).toEqual({ type: "manual" });
    expect(page.next_page).toBe("run_page_02");
  });
});
