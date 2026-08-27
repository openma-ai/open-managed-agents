import type { DeploymentRun } from "../domain/deployment-run";
import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import type {
  DeploymentRunsApplicationPort,
  ListDeploymentRunsQuery,
  ListDeploymentRunsResult,
  RetrieveDeploymentRunQuery,
  RetrieveDeploymentRunResult,
} from "../ports/deployment-runs";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeDeploymentRunCursor(run: DeploymentRun): string {
  return `deployment-runs.${encodeCursorPart(run.createdAt)}.${encodeCursorPart(run.id)}`;
}

function decodeDeploymentRunCursor(
  value: string,
): { createdAt: string; deploymentRunId: string } | null {
  const [scope, createdAt, deploymentRunId, extra] = value.split(".");
  if (
    scope !== "deployment-runs" ||
    createdAt === undefined ||
    deploymentRunId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedDeploymentRunId = decodeCursorPart(deploymentRunId);
  if (
    decodedCreatedAt === null ||
    decodedDeploymentRunId === null ||
    decodedDeploymentRunId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return {
    createdAt: decodedCreatedAt,
    deploymentRunId: decodedDeploymentRunId,
  };
}

export interface DeploymentRunsApplicationServiceDependencies {
  workspaceId: string;
  store: DeploymentRunStore;
}

export class DeploymentRunsApplicationService
  implements DeploymentRunsApplicationPort
{
  constructor(
    private readonly dependencies: DeploymentRunsApplicationServiceDependencies,
  ) {}

  async retrieveDeploymentRun(
    query: RetrieveDeploymentRunQuery,
  ): Promise<RetrieveDeploymentRunResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentRunId: query.deploymentRunId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", run: record.run };
  }

  async listDeploymentRuns(
    query: ListDeploymentRunsQuery,
  ): Promise<ListDeploymentRunsResult> {
    const position =
      query.cursor === undefined
        ? undefined
        : decodeDeploymentRunCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid deployment runs page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      ...(query.createdAfter !== undefined && {
        createdAfter: query.createdAfter,
      }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdBefore !== undefined && {
        createdBefore: query.createdBefore,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.deploymentId !== undefined && {
        deploymentId: query.deploymentId,
      }),
      ...(query.hasError !== undefined && { hasError: query.hasError }),
      ...(query.triggerType !== undefined && {
        triggerType: query.triggerType,
      }),
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const runs = (hasMore ? records.slice(0, pageSize) : records).map(
      (record) => record.run,
    );
    const last = runs[runs.length - 1];
    return {
      type: "page",
      page: {
        runs,
        nextCursor:
          hasMore && last !== undefined
            ? encodeDeploymentRunCursor(last)
            : null,
      },
    };
  }
}
