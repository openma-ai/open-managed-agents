import { describe, expect, it } from "vitest";
import { ensureTenantSqlite } from "@open-managed-agents/auth-config";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

describe("main-node tenant provisioning", () => {
  it("provisions a workspace against the canonical camelCase tenant schema", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec(`
      CREATE TABLE tenant (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE membership (
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, tenant_id)
      );
    `);

    const tenantId = await ensureTenantSqlite(
      sql,
      "user_demo",
      "OpenMA Demo",
      "demo@openma.local",
    );

    expect(tenantId).toMatch(/^tn_[0-9a-f]{32}$/);
    expect(
      await sql
        .prepare(`SELECT name, createdAt, updatedAt FROM tenant WHERE id = ?`)
        .bind(tenantId)
        .first(),
    ).toMatchObject({
      name: "OpenMA Demo's workspace",
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(
      await sql
        .prepare(
          `SELECT user_id, tenant_id, role FROM membership WHERE tenant_id = ?`,
        )
        .bind(tenantId)
        .first(),
    ).toEqual({
      user_id: "user_demo",
      tenant_id: tenantId,
      role: "owner",
    });
  });
});
