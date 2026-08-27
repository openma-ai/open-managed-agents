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
import type { DeploymentStore } from "@open-managed-agents/deployment-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryDeploymentRunStore implements DeploymentRunStore {
  private readonly workspaces = new Map<
    string,
    Map<string, StoredDeploymentRun>
  >();
  private readonly admissions = new Map<string, Promise<void>>();

  constructor(private readonly deployments: DeploymentStore) {}

  private workspace(
    workspaceId: string,
    create: boolean,
  ): Map<string, StoredDeploymentRun> | undefined {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined && create) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    return workspace;
  }

  private async serializeAdmission<Result>(
    workspaceId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.admissions.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.admissions.set(workspaceId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.admissions.get(workspaceId) === queued) {
        this.admissions.delete(workspaceId);
      }
    }
  }

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
    return this.serializeAdmission(input.workspaceId, async () => {
      const deployment = await this.deployments.find({
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
      });
      if (deployment === null) return { type: "not_found" };
      if (deployment.revision !== input.expectedDeploymentRevision) {
        return {
          type: "deployment_revision_conflict",
          actualRevision: deployment.revision,
        };
      }
      if (
        deployment.deployment.status !== "active"
        || deployment.deployment.archivedAt !== null
      ) {
        return { type: "not_runnable" };
      }
      const records = this.workspace(input.workspaceId, true)!;
      if (records.has(input.run.id)) {
        throw new Error(`Deployment Run ${input.run.id} already exists`);
      }
      const record = { run: clone(input.run), revision: 1 };
      records.set(input.run.id, record);
      return { type: "began", record: clone(record) };
    });
  }

  async finalize(
    input: FinalizeDeploymentRun,
  ): Promise<FinalizeDeploymentRunResult> {
    if (input.next.id !== input.deploymentRunId) {
      throw new Error("Finalized Deployment Run ID does not match its target");
    }
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.deploymentRunId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      run: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.deploymentRunId, record);
    return { type: "finalized", record: clone(record) };
  }

  async find(
    input: DeploymentRunLocation,
  ): Promise<StoredDeploymentRun | null> {
    const record = this.workspace(input.workspaceId, false)
      ?.get(input.deploymentRunId);
    return record === undefined ? null : clone(record);
  }

  async list(input: ListDeploymentRunRecords): Promise<StoredDeploymentRun[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Deployment Run list limit must be a positive integer");
    }
    return [...(this.workspace(input.workspaceId, false)?.values() ?? [])]
      .filter((record) =>
        input.createdAfter === undefined
        || record.run.createdAt > input.createdAfter)
      .filter((record) =>
        input.createdAtOrAfter === undefined
        || record.run.createdAt >= input.createdAtOrAfter)
      .filter((record) =>
        input.createdBefore === undefined
        || record.run.createdAt < input.createdBefore)
      .filter((record) =>
        input.createdAtOrBefore === undefined
        || record.run.createdAt <= input.createdAtOrBefore)
      .filter((record) =>
        input.deploymentId === undefined
        || record.run.deploymentId === input.deploymentId)
      .filter((record) =>
        input.hasError === undefined
        || (record.run.error !== null) === input.hasError)
      .filter((record) =>
        input.triggerType === undefined
        || record.run.triggerContext.kind === input.triggerType)
      .filter((record) =>
        input.position === undefined
        || record.run.createdAt < input.position.createdAt
        || (record.run.createdAt === input.position.createdAt
          && record.run.id < input.position.deploymentRunId))
      .sort((left, right) =>
        right.run.createdAt.localeCompare(left.run.createdAt)
        || right.run.id.localeCompare(left.run.id))
      .slice(0, input.limit)
      .map(clone);
  }
}
