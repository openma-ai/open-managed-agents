import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { SqlClient } from "@open-managed-agents/sql-client";

interface SnapshotColumn {
  name: string;
  type: "text" | "integer" | "blob" | "real";
  primaryKey: boolean;
  notNull: boolean;
  autoincrement: boolean;
  default?: string | number | boolean;
}

interface SnapshotIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  where?: string;
}

interface SnapshotPrimaryKey {
  columns: string[];
}

interface SnapshotCheck {
  value: string;
}

interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  compositePrimaryKeys: Record<string, SnapshotPrimaryKey>;
  checkConstraints: Record<string, SnapshotCheck>;
}

interface SqliteSnapshot {
  id: string;
  tables: Record<string, SnapshotTable>;
}

/** Retires the legacy agent tables after main-node moves their rows to managed
 * tables. Keep the historical snapshot IDs, including for databases that already
 * dropped the tables; upgrades now retain empty legacy tables without DROP. */
const legacyAgentsRetirementMigration = {
  fromSnapshot: "725618e8-372f-4f13-98a7-44a94146b663",
  toSnapshot: "8f90aaab-6f92-4233-95a2-0cdab2dfa28c",
} as const;

const usageAttributionMigration = {
  fromSnapshot: "f1e9f474-d719-4e31-b69e-dd7ae24f9bd4",
  toSnapshot: "2f8c3bdc-8be5-4f77-bc24-0d50f5ec66b3",
  indexName: "idx_usage_events_attribution",
  columns: ["tenant_id", "created_at", "id"],
} as const;

/** Optional model-card list pricing (NULL = unpriced). */
const modelCardPricingMigration = {
  fromSnapshot: legacyAgentsRetirementMigration.toSnapshot,
  toSnapshot: "a7c2dcc3-b820-49e8-bb5c-28f026d51d97",
} as const;

/** Session execution hold-after-exhausted marker. */
const heldAfterExhaustedMigration = {
  fromSnapshot: modelCardPricingMigration.toSnapshot,
  toSnapshot: "173fcc90-140f-4d11-92d5-9c8d917213e9",
} as const;

/** ManagedRuntimeHost orphan table (and the since-retired fence table): new
 * tables only, so the CREATE TABLE IF NOT EXISTS pass below installs them. */
const runtimeResourceTablesMigration = {
  fromSnapshot: heldAfterExhaustedMigration.toSnapshot,
  toSnapshot: "a569ec0b-0d55-4c2a-bd30-401b50191e4b",
} as const;

/** Sandbox token hashes on the execution attempt row (#561). */
const sandboxTokenHashesMigration = {
  fromSnapshot: runtimeResourceTablesMigration.toSnapshot,
  toSnapshot: "b328314c-2463-496b-9428-8396e54e5a8c",
} as const;

/** Runtime Host restore pointer and the claim's sandbox token hashes on the
 * Work row (ADR 0005). SQLite/PG drop
 * runtime_resource_fences here; MySQL retains the unused table, as it does
 * for retired tables, so the upgrade never needs DROP permission. */
const workClaimPublicationMigration = {
  fromSnapshot: sandboxTokenHashesMigration.toSnapshot,
  toSnapshot: "6f23cfa4-a1c3-4c7a-8efa-040a495a1191",
} as const;

/**
 * Install the main-node schema in a fresh MySQL database from the canonical
 * SQLite snapshot.  The snapshot is structural input, not SQL to be
 * translated: this deliberately emits native MySQL types, keys, generated
 * columns for partial-UNIQUE semantics, and InnoDB tables.
 *
 * main-node's SQLite runtime disables foreign-key enforcement, and its stores
 * own aggregate invariants.  The MySQL projection follows that contract and
 * therefore does not add snapshot foreign keys (which would otherwise make
 * insert/delete ordering differ by backend).
 */
export async function migrateNodeMysqlSchema(
  sql: SqlClient,
  sqliteMigrationsUrl: Parameters<typeof fileURLToPath>[0],
): Promise<void> {
  const migrationsDirectory = typeof sqliteMigrationsUrl === "string"
    ? sqliteMigrationsUrl
    : fileURLToPath(sqliteMigrationsUrl);
  const journal = JSON.parse(
    await readFile(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("The main-node migration journal is empty");
  const snapshot = JSON.parse(
    await readFile(
      join(
        migrationsDirectory,
        `meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`,
      ),
      "utf8",
    ),
  ) as SqliteSnapshot;

  const lock = await sql
    .prepare("SELECT GET_LOCK(?, 60) AS acquired")
    .bind("openma:main-node:mysql-schema")
    .first<{ acquired: number }>();
  if (Number(lock?.acquired) !== 1) {
    throw new Error("Timed out acquiring the main-node MySQL schema lock");
  }

  try {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS \`openma_schema_metadata\` (
        \`name\` VARCHAR(191) NOT NULL PRIMARY KEY,
        \`snapshot_id\` VARCHAR(191) NOT NULL,
        \`applied_at_ms\` BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    let installed = await sql
      .prepare(
        "SELECT snapshot_id FROM openma_schema_metadata WHERE name = ?",
      )
      .bind("main-node")
      .first<{ snapshot_id: string }>();
    // Only walk forward to a known target; unknown or older snapshots must
    // fail before any migration DDL or metadata promotion.
    const migrationSnapshots: readonly string[] = [
      usageAttributionMigration.fromSnapshot,
      usageAttributionMigration.toSnapshot,
      legacyAgentsRetirementMigration.fromSnapshot,
      legacyAgentsRetirementMigration.toSnapshot,
      modelCardPricingMigration.toSnapshot,
      heldAfterExhaustedMigration.toSnapshot,
      runtimeResourceTablesMigration.toSnapshot,
      sandboxTokenHashesMigration.toSnapshot,
      workClaimPublicationMigration.toSnapshot,
    ];
    // Walk the known additive chain toward the journal tip. Each step is
    // idempotent so an interrupted upgrade can resume on the next boot.
    while (installed !== null && installed.snapshot_id !== snapshot.id) {
      const installedIndex = migrationSnapshots.indexOf(installed.snapshot_id);
      const targetIndex = migrationSnapshots.indexOf(snapshot.id);
      if (installedIndex >= 0 && installedIndex < targetIndex) {
        if (installed.snapshot_id === usageAttributionMigration.fromSnapshot) {
          await migrateUsageAttributionIndex(sql);
          installed = { snapshot_id: usageAttributionMigration.toSnapshot };
          continue;
        }
        // tenant_invitation only — idempotent CREATE TABLE IF NOT EXISTS below.
        if (installed.snapshot_id === usageAttributionMigration.toSnapshot) {
          installed = { snapshot_id: legacyAgentsRetirementMigration.fromSnapshot };
          continue;
        }
        if (installed.snapshot_id === legacyAgentsRetirementMigration.fromSnapshot) {
          await assertLegacyAgentTablesEmpty(sql);
          installed = { snapshot_id: legacyAgentsRetirementMigration.toSnapshot };
          continue;
        }
        if (installed.snapshot_id === modelCardPricingMigration.fromSnapshot) {
          await ensureMysqlNullableColumn(sql, "model_cards", "pricing", "TEXT");
          installed = { snapshot_id: modelCardPricingMigration.toSnapshot };
          continue;
        }
        if (installed.snapshot_id === heldAfterExhaustedMigration.fromSnapshot) {
          await ensureMysqlNullableColumn(
            sql,
            "managed_session_executions",
            "held_after_exhausted_ms",
            "BIGINT",
          );
          installed = { snapshot_id: heldAfterExhaustedMigration.toSnapshot };
          continue;
        }
        if (installed.snapshot_id === runtimeResourceTablesMigration.fromSnapshot) {
          installed = { snapshot_id: runtimeResourceTablesMigration.toSnapshot };
          continue;
        }
        if (installed.snapshot_id === sandboxTokenHashesMigration.fromSnapshot) {
          await ensureMysqlNullableColumn(sql, "managed_session_executions", "sandbox_token_hashes", "TEXT");
          installed = { snapshot_id: sandboxTokenHashesMigration.toSnapshot };
          continue;
        }
        if (installed.snapshot_id === workClaimPublicationMigration.fromSnapshot) {
          await ensureMysqlNullableColumn(sql, "managed_environment_work", "runtime_publication_json", "TEXT");
          await ensureMysqlNullableColumn(sql, "managed_environment_work", "sandbox_token_hashes", "TEXT");
          installed = { snapshot_id: workClaimPublicationMigration.toSnapshot };
          continue;
        }
      }
      throw new Error(
        `MySQL schema ${installed.snapshot_id} cannot be silently promoted to ${snapshot.id}; ` +
          "apply an explicit MySQL migration before starting main-node",
      );
    }
    for (const table of Object.values(snapshot.tables)) {
      await sql.exec(renderCreateTable(table));
    }
    await installEventLogTables(sql);
    await sql
      .prepare(
        `INSERT INTO openma_schema_metadata (name, snapshot_id, applied_at_ms)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           snapshot_id = VALUES(snapshot_id),
           applied_at_ms = VALUES(applied_at_ms)`,
      )
      .bind("main-node", snapshot.id, Date.now())
      .run();
  } finally {
    await sql
      .prepare("SELECT RELEASE_LOCK(?) AS released")
      .bind("openma:main-node:mysql-schema")
      .first()
      .catch(() => null);
  }
}

async function ensureMysqlNullableColumn(
  sql: SqlClient,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const exists = await sql
    .prepare(
      `SELECT 1 AS present
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND column_name = ?`,
    )
    .bind(table, column)
    .first();
  if (exists) return;
  await sql.exec(
    `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${definition}`,
  );
}

async function assertLegacyAgentTablesEmpty(sql: SqlClient): Promise<void> {
  for (const table of ["agent_versions", "agents"]) {
    const exists = await sql
      .prepare("SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?")
      .bind(table)
      .first();
    if (!exists) continue;
    const row = await sql.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).first<{ n: number | string }>();
    if (Number(row?.n ?? 0) > 0) {
      throw new Error(`${table} still has ${row?.n} row(s); move them to managed_agents before upgrading`);
    }
  }
}

async function migrateUsageAttributionIndex(sql: SqlClient): Promise<void> {
  const existing = await sql
    .prepare(
      `SELECT column_name AS name, seq_in_index AS position
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND index_name = ?
        ORDER BY seq_in_index`,
    )
    .bind("usage_events", usageAttributionMigration.indexName)
    .all<{ name: string; position: number }>();
  const columns = existing.results?.map((column) => column.name) ?? [];
  if (columns.length === 0) {
    await sql.exec(
      `CREATE INDEX \`${usageAttributionMigration.indexName}\` ON \`usage_events\` ` +
        `(${usageAttributionMigration.columns.map(quote).join(", ")})`,
    );
  } else if (
    columns.length !== usageAttributionMigration.columns.length ||
    columns.some((column, index) => column !== usageAttributionMigration.columns[index])
  ) {
    throw new Error(
      `MySQL index ${usageAttributionMigration.indexName} has unexpected columns: ${columns.join(", ")}`,
    );
  }
  await sql
    .prepare(
      `UPDATE openma_schema_metadata
          SET snapshot_id = ?, applied_at_ms = ?
        WHERE name = ? AND snapshot_id = ?`,
    )
    .bind(
      usageAttributionMigration.toSnapshot,
      Date.now(),
      "main-node",
      usageAttributionMigration.fromSnapshot,
    )
    .run();
}

async function installEventLogTables(sql: SqlClient): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS \`session_events\` (
      \`session_id\` VARCHAR(191) NOT NULL,
      \`seq\` BIGINT NOT NULL,
      \`type\` VARCHAR(191) NOT NULL,
      \`data\` LONGTEXT NOT NULL,
      \`ts\` BIGINT NOT NULL,
      \`processed_at\` BIGINT,
      \`cancelled_at\` BIGINT,
      \`session_thread_id\` VARCHAR(191),
      PRIMARY KEY (\`session_id\`, \`seq\`),
      KEY \`idx_session_events_type\` (\`session_id\`, \`type\`, \`seq\`),
      KEY \`idx_session_events_pending\`
        (\`session_id\`, \`session_thread_id\`, \`processed_at\`,
         \`cancelled_at\`, \`type\`, \`seq\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS \`session_streams\` (
      \`session_id\` VARCHAR(191) NOT NULL,
      \`message_id\` VARCHAR(191) NOT NULL,
      \`status\` VARCHAR(191) NOT NULL,
      \`chunks_json\` LONGTEXT NOT NULL,
      \`started_at\` BIGINT NOT NULL,
      \`completed_at\` BIGINT,
      \`error_text\` LONGTEXT,
      PRIMARY KEY (\`session_id\`, \`message_id\`),
      KEY \`idx_session_streams_status\` (\`session_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function renderCreateTable(table: SnapshotTable): string {
  const indexedText = indexedTextColumns(table);
  const definitions = Object.values(table.columns).map((column) =>
    renderColumn(table.name, column, indexedText.has(column.name)),
  );

  const compositePrimaryKey = Object.values(table.compositePrimaryKeys)[0];
  if (compositePrimaryKey) {
    definitions.push(
      `PRIMARY KEY (${compositePrimaryKey.columns.map(quote).join(", ")})`,
    );
  }

  let generatedOrdinal = 0;
  for (const index of Object.values(table.indexes)) {
    if (index.where && index.isUnique) {
      const generatedNames: string[] = [];
      for (const indexedExpression of index.columns) {
        const sourceName = sourceColumnName(indexedExpression);
        const source = table.columns[sourceName];
        if (!source) {
          throw new Error(
            `MySQL schema projection cannot resolve ${table.name}.${index.name} expression ${indexedExpression}`,
          );
        }
        const generatedName = `_oma_uq_${generatedOrdinal++}`;
        generatedNames.push(generatedName);
        definitions.push(
          `${quote(generatedName)} ${mysqlType(table.name, source, true)} GENERATED ALWAYS AS (` +
            `CASE WHEN (${mysqlExpression(index.where)}) ` +
            `THEN ${mysqlExpression(indexedExpression)} ELSE NULL END) STORED`,
        );
      }
      definitions.push(
        `UNIQUE KEY ${quote(index.name)} (${generatedNames.map(quote).join(", ")})`,
      );
      continue;
    }

    // MySQL has no partial non-unique index.  A full index preserves query
    // correctness and only trades some space for equivalent lookup support.
    definitions.push(
      `${index.isUnique ? "UNIQUE " : ""}KEY ${quote(index.name)} (` +
        `${index.columns.map(renderIndexColumn).join(", ")})`,
    );
  }

  for (const check of Object.values(table.checkConstraints)) {
    definitions.push(`CHECK (${mysqlExpression(check.value)})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (\n  ${definitions.join(",\n  ")}\n)` +
    " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
}

function indexedTextColumns(table: SnapshotTable): Set<string> {
  const names = new Set<string>();
  for (const column of Object.values(table.columns)) {
    if (column.primaryKey) names.add(column.name);
  }
  for (const key of Object.values(table.compositePrimaryKeys)) {
    for (const name of key.columns) names.add(name);
  }
  for (const index of Object.values(table.indexes)) {
    for (const expression of index.columns) names.add(sourceColumnName(expression));
  }
  return names;
}

function renderColumn(
  tableName: string,
  column: SnapshotColumn,
  indexed: boolean,
): string {
  const parts = [quote(column.name), mysqlType(tableName, column, indexed)];
  if (column.notNull) parts.push("NOT NULL");
  if (column.default !== undefined) {
    parts.push("DEFAULT", mysqlDefault(column.default));
  }
  if (column.autoincrement) parts.push("AUTO_INCREMENT");
  if (column.primaryKey) parts.push("PRIMARY KEY");
  return parts.join(" ");
}

function mysqlType(
  tableName: string,
  column: SnapshotColumn,
  indexed: boolean,
): string {
  if (
    ["user", "session", "account", "verification"].includes(tableName)
    && /(?:At|ExpiresAt)$/.test(column.name)
  ) {
    // Better Auth hands mysql2 native Date values.  Unlike OpenMA domain
    // timestamps (epoch-ms BIGINT), these four tables use SQL datetime.
    return "DATETIME(3)";
  }
  switch (column.type) {
    case "text":
      // Four utf8mb4 VARCHAR(191) values fit under InnoDB's 3072-byte key
      // limit. MySQL does not permit scalar defaults on LONGTEXT, so the
      // small enum/JSON-marker columns with defaults use VARCHAR as well;
      // unindexed documents remain unbounded.
      return indexed || column.default !== undefined
        ? "VARCHAR(191)"
        : "LONGTEXT";
    case "integer":
      return "BIGINT";
    case "blob":
      return "LONGBLOB";
    case "real":
      return "DOUBLE";
  }
}

function mysqlDefault(value: string | number | boolean): string {
  if (value === false) return "0";
  if (value === true) return "1";
  return String(value);
}

function sourceColumnName(expression: string): string {
  const coalesce = expression.match(/^COALESCE\(["`]([^"`]+)["`],\s*''\)$/i);
  return coalesce?.[1]
    ?? expression
      .replace(/\s+(?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?$/i, "")
      .replaceAll(/["`]/g, "");
}

function renderIndexColumn(expression: string): string {
  const direction = expression.match(/\s+(ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?$/i)?.[1];
  return `${quote(sourceColumnName(expression))}${direction ? ` ${direction.toUpperCase()}` : ""}`;
}

function mysqlExpression(expression: string): string {
  return expression.replaceAll(/"([^"\n]+)"/g, "`$1`");
}

function quote(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}
