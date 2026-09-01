import type {
  ArchiveEnvironmentRecord,
  ArchiveEnvironmentRecordResult,
  DeleteEnvironmentRecordResult,
  EnvironmentLocation,
  EnvironmentStore,
  InsertEnvironment,
  ListEnvironmentRecords,
  ReplaceEnvironment,
  ReplaceEnvironmentResult,
  StoredEnvironment,
} from "@open-managed-agents/environment-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function compare(left: StoredEnvironment, right: StoredEnvironment): number {
  return left.environment.createdAt.localeCompare(right.environment.createdAt)
    || left.environment.id.localeCompare(right.environment.id);
}

export class MemoryEnvironmentStore implements EnvironmentStore {
  private readonly workspaces = new Map<
    string,
    Map<string, StoredEnvironment>
  >();

  async insert(input: InsertEnvironment): Promise<StoredEnvironment> {
    const records = this.records(input.workspaceId, true);
    if (records.has(input.environment.id)) {
      throw new Error(`Environment ${input.environment.id} already exists`);
    }
    const record = { environment: clone(input.environment), revision: 1 };
    records.set(input.environment.id, record);
    return clone(record);
  }

  async find(input: EnvironmentLocation): Promise<StoredEnvironment | null> {
    const record = this.records(input.workspaceId)?.get(input.environmentId);
    return record === undefined ? null : clone(record);
  }

  async replace(
    input: ReplaceEnvironment,
  ): Promise<ReplaceEnvironmentResult> {
    if (input.next.id !== input.environmentId) {
      throw new Error("Replacement environment ID does not match the target");
    }
    const records = this.records(input.workspaceId);
    const current = records?.get(input.environmentId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record = {
      environment: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.environmentId, record);
    return { type: "replaced", record: clone(record) };
  }

  async archive(
    input: ArchiveEnvironmentRecord,
  ): Promise<ArchiveEnvironmentRecordResult> {
    const records = this.records(input.workspaceId);
    const current = records?.get(input.environmentId);
    if (current === undefined) return { type: "not_found" };
    const record: StoredEnvironment = {
      environment: {
        ...clone(current.environment),
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    records?.set(input.environmentId, record);
    return { type: "archived", record: clone(record) };
  }

  async delete(
    input: EnvironmentLocation,
  ): Promise<DeleteEnvironmentRecordResult> {
    const records = this.records(input.workspaceId);
    if (records === undefined || !records.delete(input.environmentId)) {
      return { type: "not_found" };
    }
    if (records.size === 0) this.workspaces.delete(input.workspaceId);
    return { type: "deleted" };
  }

  async list(input: ListEnvironmentRecords): Promise<StoredEnvironment[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Environment list limit must be a positive integer");
    }
    const position = input.position === undefined
      ? undefined
      : {
          environment: {
            id: input.position.environmentId,
            createdAt: input.position.createdAt,
          },
          revision: 0,
        } as StoredEnvironment;
    return [...(this.records(input.workspaceId)?.values() ?? [])]
      .filter((record) =>
        input.includeArchived || record.environment.archivedAt === null)
      .filter((record) => position === undefined || compare(record, position) > 0)
      .sort(compare)
      .slice(0, input.limit)
      .map(clone);
  }

  private records(workspaceId: string, create: true): Map<string, StoredEnvironment>;
  private records(workspaceId: string, create?: false): Map<string, StoredEnvironment> | undefined;
  private records(
    workspaceId: string,
    create = false,
  ): Map<string, StoredEnvironment> | undefined {
    const current = this.workspaces.get(workspaceId);
    if (current !== undefined || !create) return current;
    const records = new Map<string, StoredEnvironment>();
    this.workspaces.set(workspaceId, records);
    return records;
  }
}
