import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindMemoryStoreForMemory,
  FindSessionMemoryStore,
  MemoryStore,
  MemoryStoreForMemorySourcePort,
  SessionMemoryStoreSourcePort,
} from "@open-managed-agents/managed-agents-application";

interface MemoryStoreDocumentRow {
  document: string;
}

export class SqlMemoryStoreSource
  implements MemoryStoreForMemorySourcePort, SessionMemoryStoreSourcePort
{
  constructor(private readonly client: SqlClient) {}

  async find(
    input: FindMemoryStoreForMemory | FindSessionMemoryStore,
  ): Promise<MemoryStore | null> {
    const row = await this.client
      .prepare(
        `SELECT document
           FROM managed_memory_stores
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.memoryStoreId)
      .first<MemoryStoreDocumentRow>();
    return row === null ? null : JSON.parse(row.document) as MemoryStore;
  }
}
