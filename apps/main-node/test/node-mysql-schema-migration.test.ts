import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { migrateNodeMysqlSchema } from "@open-managed-agents/db-schema/node-mysql";
import type {
  SqlClient,
  SqlExecMeta,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "@open-managed-agents/sql-client";

const previousSnapshot = "f1e9f474-d719-4e31-b69e-dd7ae24f9bd4";
const currentSnapshot = "725618e8-372f-4f13-98a7-44a94146b663";
const migrations = resolve(import.meta.dirname, "../migrations-sqlite");

describe("main-node MySQL snapshot migrations", () => {
  it.each([
    { name: "a fresh migration", initialIndex: [] },
    {
      name: "a restart after index creation",
      initialIndex: ["tenant_id", "created_at", "id"],
    },
  ])("promotes the usage attribution snapshot after $name", async ({ initialIndex }) => {
    const sql = new MigrationSqlClient(previousSnapshot, initialIndex);

    await migrateNodeMysqlSchema(sql, migrations);

    expect(sql.snapshotId).toBe(currentSnapshot);
    expect(sql.indexColumns).toEqual(["tenant_id", "created_at", "id"]);
    expect(sql.createdAttributionIndex).toBe(initialIndex.length === 0);
  });

  it("upgrades the previous member schema to invitations", async () => {
    const sql = new MigrationSqlClient("2f8c3bdc-8be5-4f77-bc24-0d50f5ec66b3", ["tenant_id", "created_at", "id"]);
    await migrateNodeMysqlSchema(sql, migrations);
    expect(sql.snapshotId).toBe(currentSnapshot);
  });

  it("fails closed when an existing attribution index has the wrong shape", async () => {
    const sql = new MigrationSqlClient(previousSnapshot, ["tenant_id", "id"]);

    await expect(migrateNodeMysqlSchema(sql, migrations)).rejects.toThrow(
      "idx_usage_events_attribution has unexpected columns: tenant_id, id",
    );
    expect(sql.snapshotId).toBe(previousSnapshot);
  });
});

class MigrationSqlClient implements SqlClient {
  createdAttributionIndex = false;

  constructor(
    public snapshotId: string,
    public indexColumns: string[],
  ) {}

  prepare(sql: string): SqlStatement {
    return new MigrationStatement(this, sql);
  }

  async batch<T = unknown>(_stmts: SqlStatement[]): Promise<Array<SqlRunResult<T>>> {
    return [];
  }

  async exec(sql: string): Promise<void> {
    if (sql.includes("CREATE INDEX `idx_usage_events_attribution`")) {
      this.createdAttributionIndex = true;
      this.indexColumns = ["tenant_id", "created_at", "id"];
    }
  }
}

class MigrationStatement implements SqlStatement {
  private params: unknown[] = [];

  constructor(
    private readonly client: MigrationSqlClient,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): SqlStatement {
    this.params = params;
    return this;
  }

  async run<T = unknown>(): Promise<SqlRunResult<T>> {
    if (this.sql.includes("UPDATE openma_schema_metadata")) {
      const [nextSnapshot, , , expectedSnapshot] = this.params as [string, number, string, string];
      if (this.client.snapshotId === expectedSnapshot) this.client.snapshotId = nextSnapshot;
    } else if (this.sql.includes("INSERT INTO openma_schema_metadata")) {
      this.client.snapshotId = this.params[1] as string;
    }
    return { meta: changed(1) };
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("GET_LOCK")) return { acquired: 1 } as T;
    if (this.sql.includes("RELEASE_LOCK")) return { released: 1 } as T;
    if (this.sql.includes("SELECT snapshot_id FROM openma_schema_metadata")) {
      return { snapshot_id: this.client.snapshotId } as T;
    }
    return null;
  }

  async all<T = unknown>(): Promise<SqlSelectResult<T>> {
    if (this.sql.includes("information_schema.statistics")) {
      return {
        results: this.client.indexColumns.map((name, index) => ({
          name,
          position: index + 1,
        })) as T[],
        meta: changed(0),
      };
    }
    return { results: [], meta: changed(0) };
  }
}

function changed(changes: number): SqlExecMeta {
  return { changes };
}
