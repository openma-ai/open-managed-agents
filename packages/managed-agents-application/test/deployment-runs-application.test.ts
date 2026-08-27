import { describe, expect, it } from "vitest";
import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import { DeploymentRunsApplicationService } from "../src/deployment-runs/application";

const run = {
  id: "drun_01",
  agent: { id: "agent_01", version: 3 },
  createdAt: "2026-08-26T15:00:00.000Z",
  deploymentId: "depl_01",
  error: null,
  sessionId: "session_01",
  triggerContext: { kind: "manual" as const },
};

function makeStore(
  overrides: Partial<DeploymentRunStore>,
): DeploymentRunStore {
  const unexpected = (operation: string) => async () => {
    throw new Error(`unexpected ${operation} call`);
  };
  return {
    beginManual: unexpected("beginManual"),
    finalize: unexpected("finalize"),
    find: unexpected("find"),
    list: unexpected("list"),
    ...overrides,
  };
}

describe("Deployment Runs application", () => {
  it("retrieves and paginates complete run records with all semantic filters", async () => {
    const older = {
      ...run,
      id: "drun_00",
      createdAt: "2026-08-25T15:00:00.000Z",
      error: {
        type: "session_creation_rejected_error" as const,
        message: "Session creation was rejected",
      },
      sessionId: null,
      triggerContext: {
        kind: "schedule" as const,
        scheduledAt: "2026-08-25T15:00:00.000Z",
      },
    };
    const listCalls: object[] = [];
    const service = new DeploymentRunsApplicationService({
      workspaceId: "workspace_01",
      store: makeStore({
        find: async () => ({ run, revision: 2 }),
        list: async (input) => {
          listCalls.push(input);
          return input.position === undefined
            ? [{ run, revision: 2 }, { run: older, revision: 1 }]
            : [{ run: older, revision: 1 }];
        },
      }),
    });

    await expect(
      service.retrieveDeploymentRun({ deploymentRunId: "drun_01" }),
    ).resolves.toEqual({ type: "found", run });
    const first = await service.listDeploymentRuns({
      pageSize: 1,
      createdAfter: "2026-08-01T00:00:00.000Z",
      createdAtOrAfter: "2026-08-02T00:00:00.000Z",
      createdBefore: "2026-09-01T00:00:00.000Z",
      createdAtOrBefore: "2026-08-31T23:59:59.000Z",
      deploymentId: "depl_01",
      hasError: false,
      triggerType: "manual",
    });
    expect(first.type).toBe("page");
    if (first.type !== "page") throw new Error("expected first page");
    expect(first.page).toEqual({
      runs: [run],
      nextCursor: expect.any(String),
    });
    await expect(
      service.listDeploymentRuns({ cursor: first.page.nextCursor! }),
    ).resolves.toEqual({
      type: "page",
      page: { runs: [older], nextCursor: null },
    });
    expect(listCalls).toEqual([
      {
        workspaceId: "workspace_01",
        limit: 2,
        createdAfter: "2026-08-01T00:00:00.000Z",
        createdAtOrAfter: "2026-08-02T00:00:00.000Z",
        createdBefore: "2026-09-01T00:00:00.000Z",
        createdAtOrBefore: "2026-08-31T23:59:59.000Z",
        deploymentId: "depl_01",
        hasError: false,
        triggerType: "manual",
      },
      {
        workspaceId: "workspace_01",
        limit: 21,
        position: {
          createdAt: "2026-08-26T15:00:00.000Z",
          deploymentRunId: "drun_01",
        },
      },
    ]);
  });

  it("rejects malformed semantic cursors before persistence", async () => {
    const service = new DeploymentRunsApplicationService({
      workspaceId: "workspace_01",
      store: makeStore({}),
    });

    await expect(
      service.listDeploymentRuns({ cursor: "not-a-run-cursor" }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid deployment runs page cursor",
    });
  });
});
