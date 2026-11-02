// Workspace provisioning for a newly signed-in user: one tenant and an owner
// membership, created once. Pure SQL against the control plane's database,
// so any auth component (and the request-time self-heal) can call it.

import type { SqlClient } from "@open-managed-agents/sql-client";

/** Run an idempotent ensure-tenant against an arbitrary SqlClient (the
 *  Node-style flow). Used by both apps/main-node's auth-config hook and
 *  the auth-middleware self-heal path. CF runs an analogous helper that
 *  also assigns a shard — see apps/main/src/auth-config.ts:ensureTenant. */
export async function ensureTenantSqlite(
  sql: SqlClient,
  userId: string,
  userName: string | null | undefined,
  userEmail: string | null | undefined,
): Promise<string> {
  const existing = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  if (existing) return existing.tenant_id;

  const tenantId = `tn_${randomHex(16)}`;
  const now = Date.now();
  const trimmedName = (userName ?? "").trim();
  const emailPrefix = (userEmail ?? "").split("@")[0]?.trim() ?? "";
  const display = trimmedName || emailPrefix || "User";
  const tenantName = `${display}'s workspace`;

  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(tenantId, tenantName, now, now)
    .run();

  await sql
    .prepare(
      `INSERT INTO "membership" (user_id, tenant_id, role, created_at)
       VALUES (?, ?, 'owner', ?)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    )
    .bind(userId, tenantId, now)
    .run();

  // Re-read in case a concurrent caller raced.
  const final = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  return final?.tenant_id ?? tenantId;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
