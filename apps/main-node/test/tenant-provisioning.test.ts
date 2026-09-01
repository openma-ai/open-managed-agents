import { describe, expect, it } from "vitest";
import { ensureTenantSqlite } from "@open-managed-agents/auth-config";
import { applyTenantSchema } from "@open-managed-agents/schema";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

describe("main-node tenant provisioning", () => {
  it("provisions a workspace against the canonical camelCase tenant schema", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await applyTenantSchema(sql);

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
