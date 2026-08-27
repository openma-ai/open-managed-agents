import type { SqlClient } from "@open-managed-agents/sql-client";
import type { DeploymentRun } from "@open-managed-agents/domain/deployments";
import type {
  BeginManualDeploymentRun,
  BeginManualDeploymentRunResult,
  DeploymentRunLocation,
  DeploymentRunStore,
  FinalizeDeploymentRun,
  FinalizeDeploymentRunResult,
  ListDeploymentRunRecords,
  StoredDeploymentRun,
} from "@open-managed-agents/deployment-run-store";

interface DeploymentRunRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
}

interface DeploymentGuardRow {
  revision: number;
  status: string;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Deployment Run timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredDeploymentRun(row: DeploymentRunRow): StoredDeploymentRun {
  const stored = JSON.parse(row.document) as DeploymentRun;
  return {
    revision: Number(row.revision),
    run: {
      ...stored,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
    },
  };
}

export class SqlDeploymentRunStore implements DeploymentRunStore {
  constructor(private readonly client: SqlClient) {}

  async beginManual(
    input: BeginManualDeploymentRun,
  ): Promise<BeginManualDeploymentRunResult> {
    if (
      input.run.deploymentId !== input.deploymentId
      || input.run.triggerContext.kind !== "manual"
      || input.run.sessionId !== null
      || input.run.error !== null
    ) {
      throw new Error("Manual Deployment Run begin input is inconsistent");
    }
    const result = await this.client.prepare(
      `INSERT INTO managed_deployment_runs
        (workspace_id, id, deployment_id, document, revision,
         has_error, trigger_type, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
         FROM managed_deployments
        WHERE workspace_id = ? AND id = ? AND revision = ?
          AND status = 'active' AND archived_at IS NULL`,
    ).bind(
      input.workspaceId,
      input.run.id,
      input.deploymentId,
      JSON.stringify(input.run),
      1,
      0,
      "manual",
      timestamp(input.run.createdAt),
      input.workspaceId,
      input.deploymentId,
      input.expectedDeploymentRevision,
    ).run();
    if (result.meta.changes === 0) {
      const deployment = await this.client.prepare(
        `SELECT revision, status, archived_at
           FROM managed_deployments
          WHERE workspace_id = ? AND id = ?`,
      ).bind(input.workspaceId, input.deploymentId)
        .first<DeploymentGuardRow>();
      if (deployment === null) return { type: "not_found" };
      if (Number(deployment.revision) !== input.expectedDeploymentRevision) {
        return {
          type: "deployment_revision_conflict",
          actualRevision: Number(deployment.revision),
        };
      }
      return { type: "not_runnable" };
    }
    if (result.meta.changes !== 1) {
      throw new Error(
        `Deployment Run begin affected ${result.meta.changes} rows`,
      );
    }
    const record = await this.find({
      workspaceId: input.workspaceId,
      deploymentRunId: input.run.id,
    });
    if (record === null) throw new Error("Deployment Run vanished after begin");
    return { type: "began", record };
  }

  async finalize(
    input: FinalizeDeploymentRun,
  ): Promise<FinalizeDeploymentRunResult> {
    if (input.next.id !== input.deploymentRunId) {
      throw new Error("Finalized Deployment Run ID does not match its target");
    }
    const result = await this.client.prepare(
      `UPDATE managed_deployment_runs
          SET document = ?, revision = revision + 1,
              has_error = ?, trigger_type = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.next),
      input.next.error === null ? 0 : 1,
      input.next.triggerContext.kind,
      input.workspaceId,
      input.deploymentRunId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const current = await this.find({
        workspaceId: input.workspaceId,
        deploymentRunId: input.deploymentRunId,
      });
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(
        `Deployment Run finalization affected ${result.meta.changes} rows`,
      );
    }
    const record = await this.find({
      workspaceId: input.workspaceId,
      deploymentRunId: input.deploymentRunId,
    });
    if (record === null) {
      throw new Error("Deployment Run vanished after finalization");
    }
    return { type: "finalized", record };
  }

  async find(
    input: DeploymentRunLocation,
  ): Promise<StoredDeploymentRun | null> {
    const row = await this.client.prepare(
      `SELECT id, document, revision, created_at
         FROM managed_deployment_runs
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.deploymentRunId)
      .first<DeploymentRunRow>();
    return row === null ? null : toStoredDeploymentRun(row);
  }

  async list(input: ListDeploymentRunRecords): Promise<StoredDeploymentRun[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Deployment Run list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (input.createdAfter !== undefined) {
      conditions.push("created_at > ?");
      parameters.push(timestamp(input.createdAfter));
    }
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdBefore !== undefined) {
      conditions.push("created_at < ?");
      parameters.push(timestamp(input.createdBefore));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.deploymentId !== undefined) {
      conditions.push("deployment_id = ?");
      parameters.push(input.deploymentId);
    }
    if (input.hasError !== undefined) {
      conditions.push("has_error = ?");
      parameters.push(input.hasError ? 1 : 0);
    }
    if (input.triggerType !== undefined) {
      conditions.push("trigger_type = ?");
      parameters.push(input.triggerType);
    }
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.deploymentRunId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT id, document, revision, created_at
         FROM managed_deployment_runs
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<DeploymentRunRow>();
    return (rows.results ?? []).map(toStoredDeploymentRun);
  }
}
