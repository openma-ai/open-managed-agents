// The custom store from docs/assemble-control-plane.md. It depends on
// @openma/core types only; `KeyValue` stands in for Redis, DynamoDB, etc.
import type {
  AgentRecord,
  AgentStore,
  ArchiveAgentRecord,
  ArchiveAgentRecordResult,
  CountAgentRecords,
  DeleteAgentRecordResult,
  FindAgentVersionRecord,
  FindCurrentAgentRecord,
  InsertAgentRecord,
  ListAgentRecords,
  ListAgentVersionRecords,
  ReplaceAgentRecord,
  ReplaceAgentRecordResult,
} from "@openma/core/storage";

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export class KeyValueAgentStore implements AgentStore {
  constructor(private readonly kv: KeyValue) {}

  async insert({ workspaceId, agent }: InsertAgentRecord): Promise<AgentRecord> {
    await this.kv.set(current(workspaceId, agent.id), JSON.stringify(agent));
    await this.kv.set(version(workspaceId, agent.id, agent.version), JSON.stringify(agent));
    return agent;
  }

  async findCurrent({ workspaceId, agentId }: FindCurrentAgentRecord): Promise<AgentRecord | null> {
    return parse(await this.kv.get(current(workspaceId, agentId)));
  }

  async findVersion(input: FindAgentVersionRecord): Promise<AgentRecord | null> {
    return parse(await this.kv.get(version(input.workspaceId, input.agentId, input.version)));
  }

  // A production store must make this compare-and-set atomic (a Redis
  // transaction, a conditional write); the Port contract requires it.
  async replaceCurrent(input: ReplaceAgentRecord): Promise<ReplaceAgentRecordResult> {
    const previous = await this.findCurrent(input);
    if (previous === null) return { type: "not_found" };
    if (previous.version !== input.expectedVersion || previous.archivedAt !== null) {
      return { type: "version_conflict", actualVersion: previous.version };
    }
    await this.insert({ workspaceId: input.workspaceId, agent: input.next });
    return { type: "replaced", agent: input.next };
  }

  async archiveCurrent(input: ArchiveAgentRecord): Promise<ArchiveAgentRecordResult> {
    const agent = await this.findCurrent(input);
    if (agent === null) return { type: "not_found" };
    const archived = { ...agent, archivedAt: input.archivedAt };
    await this.kv.set(current(input.workspaceId, agent.id), JSON.stringify(archived));
    return { type: "archived", agent: archived };
  }

  async listCurrent(input: ListAgentRecords): Promise<AgentRecord[]> {
    const agents = await this.all(input.workspaceId);
    return agents
      .filter((agent) => input.includeArchived || agent.archivedAt === null)
      .filter((agent) => input.createdAtOrAfter === undefined || agent.createdAt >= input.createdAtOrAfter)
      .filter((agent) => input.createdAtOrBefore === undefined || agent.createdAt <= input.createdAtOrBefore)
      .filter((agent) => input.after === undefined
        || agent.createdAt < input.after.createdAt
        || (agent.createdAt === input.after.createdAt && agent.id < input.after.agentId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, input.limit);
  }

  async listVersions(input: ListAgentVersionRecords): Promise<AgentRecord[]> {
    const versions: AgentRecord[] = [];
    for (let v = input.beforeVersion - 1; v >= 1 && versions.length < input.limit; v -= 1) {
      const agent = await this.findVersion({ ...input, version: v });
      if (agent !== null) versions.push(agent);
    }
    return versions;
  }

  async countCurrent(input: CountAgentRecords): Promise<number> {
    const agents = await this.all(input.workspaceId);
    return agents.filter((agent) => input.includeArchived || agent.archivedAt === null).length;
  }

  async deleteCurrent({ workspaceId, agentId }: FindCurrentAgentRecord): Promise<DeleteAgentRecordResult> {
    if (await this.findCurrent({ workspaceId, agentId }) === null) return { type: "not_found" };
    for (const key of await this.kv.keys(`agent-version:${workspaceId}:${agentId}:`)) await this.kv.delete(key);
    await this.kv.delete(current(workspaceId, agentId));
    return { type: "deleted" };
  }

  private async all(workspaceId: string): Promise<AgentRecord[]> {
    const keys = await this.kv.keys(`agent:${workspaceId}:`);
    const agents = await Promise.all(keys.map(async (key) => parse(await this.kv.get(key))));
    return agents.filter((agent): agent is AgentRecord => agent !== null);
  }
}

const current = (workspaceId: string, agentId: string) => `agent:${workspaceId}:${agentId}`;
const version = (workspaceId: string, agentId: string, v: number) =>
  `agent-version:${workspaceId}:${agentId}:${v}`;
const parse = (value: string | null): AgentRecord | null =>
  value === null ? null : JSON.parse(value) as AgentRecord;
