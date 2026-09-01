import type {
  DeploymentLocation,
  DeploymentStore,
  InsertDeploymentRecord,
  ListDeploymentRecords,
  ReplaceDeploymentRecord,
  ReplaceDeploymentRecordResult,
  StoredDeployment,
} from "@open-managed-agents/deployment-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryDeploymentStore implements DeploymentStore {
  private readonly workspaces = new Map<
    string,
    Map<string, StoredDeployment>
  >();

  private workspace(
    workspaceId: string,
    create: boolean,
  ): Map<string, StoredDeployment> | undefined {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined && create) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    return workspace;
  }

  async insert(input: InsertDeploymentRecord): Promise<StoredDeployment> {
    const records = this.workspace(input.workspaceId, true)!;
    const id = input.record.deployment.id;
    if (records.has(id)) throw new Error(`Deployment ${id} already exists`);
    const stored = { ...clone(input.record), revision: 1 };
    records.set(id, stored);
    return clone(stored);
  }

  async find(input: DeploymentLocation): Promise<StoredDeployment | null> {
    const record = this.workspace(input.workspaceId, false)
      ?.get(input.deploymentId);
    return record === undefined ? null : clone(record);
  }

  async replace(
    input: ReplaceDeploymentRecord,
  ): Promise<ReplaceDeploymentRecordResult> {
    if (input.next.deployment.id !== input.deploymentId) {
      throw new Error("Replacement Deployment ID does not match its target");
    }
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.deploymentId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record = {
      ...clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.deploymentId, record);
    return { type: "replaced", record: clone(record) };
  }

  async list(input: ListDeploymentRecords): Promise<StoredDeployment[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Deployment list limit must be a positive integer");
    }
    return [...(this.workspace(input.workspaceId, false)?.values() ?? [])]
      .filter((record) =>
        input.includeArchived || record.deployment.archivedAt === null)
      .filter((record) =>
        input.agentId === undefined
        || record.deployment.agent.id === input.agentId)
      .filter((record) =>
        input.createdAtOrAfter === undefined
        || record.deployment.createdAt >= input.createdAtOrAfter)
      .filter((record) =>
        input.createdAtOrBefore === undefined
        || record.deployment.createdAt <= input.createdAtOrBefore)
      .filter((record) =>
        input.status === undefined || record.deployment.status === input.status)
      .filter((record) =>
        input.position === undefined
        || record.deployment.createdAt < input.position.createdAt
        || (record.deployment.createdAt === input.position.createdAt
          && record.deployment.id < input.position.deploymentId))
      .sort((left, right) =>
        right.deployment.createdAt.localeCompare(left.deployment.createdAt)
        || right.deployment.id.localeCompare(left.deployment.id))
      .slice(0, input.limit)
      .map(clone);
  }
}
