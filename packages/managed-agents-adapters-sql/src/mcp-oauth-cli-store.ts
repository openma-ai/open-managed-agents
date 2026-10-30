import type { SqlClient } from "@open-managed-agents/sql-client";
import type { McpOAuthCliStore } from "@open-managed-agents/managed-agents-application";

const SCOPE = "oma:mcp-oauth-cli";
/** Existing SQL KV table, not eventually consistent CONFIG_KV. All mutations
 * compare the exact previous document and TTL in one database statement. */
export class SqlMcpOAuthCliStore implements McpOAuthCliStore {
  constructor(private readonly sql: SqlClient, private readonly clock: { now(): Date }) {}
  async create(id: string, value: string, expiresAtMs: number): Promise<void> {
    await this.sql.prepare("DELETE FROM kv_entries WHERE tenant_id = ? AND expires_at <= ?").bind(SCOPE, this.clock.now().getTime()).run();
    await this.sql.prepare('INSERT INTO kv_entries (tenant_id, "key", value, expires_at) VALUES (?, ?, ?, ?)').bind(SCOPE, id, value, expiresAtMs).run();
  }
  async read(id: string): Promise<string | null> {
    const row = await this.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id = ? AND "key" = ? AND expires_at > ?').bind(SCOPE, id, this.clock.now().getTime()).first<{ value: string }>();
    return row?.value ?? null;
  }
  async compareAndSwap(id: string, expected: string, value: string): Promise<boolean> {
    const result = await this.sql.prepare('UPDATE kv_entries SET value = ? WHERE tenant_id = ? AND "key" = ? AND value = ? AND expires_at > ?').bind(value, SCOPE, id, expected, this.clock.now().getTime()).run();
    return result.meta.changes === 1;
  }
  async consume(id: string, expected: string): Promise<boolean> {
    const result = await this.sql.prepare('DELETE FROM kv_entries WHERE tenant_id = ? AND "key" = ? AND value = ? AND expires_at > ?').bind(SCOPE, id, expected, this.clock.now().getTime()).run();
    return result.meta.changes === 1;
  }
}
