import { Hono } from "hono";
import type { Context } from "hono";
import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";

type Vars = { Variables: { tenant_id: string; user_id?: string } };
export interface MemberRoutesDeps {
  memberSql: SqlClient;
  loadMemberUser?: (
    id: string,
  ) => Promise<{ name?: string | null; email?: string } | null>;
}
const validRole = (role: unknown): role is "admin" | "member" =>
  role === "admin" || role === "member";
async function hash(token: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function buildMemberRoutes({
  memberSql: sql,
  loadMemberUser,
}: MemberRoutesDeps) {
  const app = new Hono<Vars>();
  const roleFor = async (c: Context<Vars>) => {
    if (!c.var.user_id) return null;
    return (
      (
        await sql
          .prepare(
            "SELECT role FROM membership WHERE tenant_id = ? AND user_id = ?",
          )
          .bind(c.req.param("tenantId"), c.var.user_id)
          .first<{ role: string }>()
      )?.role ?? null
    );
  };
  const denied = (c: Context<Vars>) =>
    c.json({ error: "Insufficient workspace permissions" }, 403);

  app.post("/invitations/accept", async (c) => {
    if (!c.var.user_id) return denied(c);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.token !== "string" || body.token.length > 256)
      return c.json({ error: "Invitation token is required" }, 400);
    const tokenHash = await hash(body.token);
    const claim = nanoid(32);
    const now = Date.now();
    // Claim and membership insert commit together. A fresh claim id prevents a
    // replay (including a simultaneous request from the same user) from joining.
    const results = await sql.batch([
      sql
        .prepare(
          `UPDATE tenant_invitation SET accepted_by = ?, claim_id = ?
        WHERE token_hash = ? AND accepted_by IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM membership m WHERE m.tenant_id = tenant_invitation.tenant_id
          AND m.user_id = tenant_invitation.created_by
          AND (m.role = 'owner' OR (m.role = 'admin' AND tenant_invitation.role = 'member')))`,
        )
        .bind(c.var.user_id, claim, tokenHash, now),
      sql
        .prepare(
          `INSERT INTO membership (user_id, tenant_id, role, created_at)
        SELECT ?, tenant_id, role, ? FROM tenant_invitation WHERE token_hash = ? AND claim_id = ?
        ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        )
        .bind(c.var.user_id, now, tokenHash, claim),
    ]);
    if (!results[0]?.meta.changes)
      return c.json(
        { error: "Invitation expired, revoked, or already used" },
        410,
      );
    const row = await sql
      .prepare("SELECT tenant_id FROM tenant_invitation WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ tenant_id: string }>();
    return c.json({ tenant_id: row!.tenant_id });
  });

  app.get("/:tenantId/members", async (c) => {
    const role = await roleFor(c);
    if (!role) return denied(c);
    const rows = await sql
      .prepare(
        "SELECT user_id, role, created_at FROM membership WHERE tenant_id = ? ORDER BY created_at, user_id",
      )
      .bind(c.req.param("tenantId"))
      .all<{ user_id: string; role: string; created_at: number }>();
    const data = await Promise.all(
      (rows.results ?? []).map(async (row) => ({
        ...row,
        ...(loadMemberUser ? await loadMemberUser(row.user_id) : {}),
      })),
    );
    return c.json({ data, role, user_id: c.var.user_id });
  });

  app.patch("/:tenantId/members/:userId", async (c) => {
    if ((await roleFor(c)) !== "owner") return denied(c);
    const body = await c.req.json().catch(() => null);
    if (!validRole(body?.role))
      return c.json({ error: "Role must be admin or member" }, 400);
    const tenantId = c.req.param("tenantId"),
      userId = c.req.param("userId");
    const target = await sql
      .prepare(
        "SELECT role FROM membership WHERE tenant_id = ? AND user_id = ?",
      )
      .bind(tenantId, userId)
      .first<{ role: string }>();
    if (!target) return c.json({ error: "Member not found" }, 404);
    if (target.role === "owner") return denied(c);
    await sql.batch([
      sql
        .prepare(
          "UPDATE membership SET role = ? WHERE tenant_id = ? AND user_id = ? AND role <> 'owner'",
        )
        .bind(body.role, tenantId, userId),
      sql
        .prepare(
          "UPDATE tenant_invitation SET expires_at = 0 WHERE tenant_id = ? AND created_by = ? AND accepted_by IS NULL",
        )
        .bind(tenantId, userId),
    ]);
    return c.json({ success: true });
  });

  app.delete("/:tenantId/members/:userId", async (c) => {
    const role = await roleFor(c);
    if (role !== "owner" && role !== "admin") return denied(c);
    const tenantId = c.req.param("tenantId"),
      userId = c.req.param("userId");
    const target = await sql
      .prepare(
        "SELECT role FROM membership WHERE tenant_id = ? AND user_id = ?",
      )
      .bind(tenantId, userId)
      .first<{ role: string }>();
    if (!target) return c.json({ error: "Member not found" }, 404);
    if (
      target.role === "owner" ||
      (role === "admin" && target.role !== "member")
    )
      return denied(c);
    const results = await sql.batch([
      sql
        .prepare(
          // GROUP BY materializes the actor lookup on MySQL, which disallows
          // directly reading the target table in a DELETE subquery.
          `DELETE FROM membership WHERE tenant_id = ? AND user_id = ? AND role <> 'owner'
          AND (? = 'owner' OR role = 'member') AND EXISTS (
            SELECT 1 FROM (SELECT user_id, tenant_id, role FROM membership
              GROUP BY user_id, tenant_id, role) actor
            WHERE actor.user_id = ? AND actor.tenant_id = ? AND actor.role IN ('owner', 'admin'))`,
        )
        .bind(tenantId, userId, role, c.var.user_id, tenantId),
      sql
        .prepare(
          `UPDATE tenant_invitation SET expires_at = 0 WHERE tenant_id = ? AND created_by = ? AND accepted_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM membership WHERE tenant_id = ? AND user_id = ?)`,
        )
        .bind(tenantId, userId, tenantId, userId),
    ]);
    if (!results[0]?.meta.changes) return denied(c);
    return c.json({ success: true });
  });

  app.get("/:tenantId/invitations", async (c) => {
    const role = await roleFor(c);
    if (role !== "owner" && role !== "admin") return denied(c);
    const rows = await sql
      .prepare(
        `SELECT id, role, created_by, created_at, expires_at FROM tenant_invitation
      WHERE tenant_id = ? AND accepted_by IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      )
      .bind(c.req.param("tenantId"), Date.now())
      .all();
    return c.json({ data: rows.results ?? [] });
  });

  app.post("/:tenantId/invitations", async (c) => {
    const role = await roleFor(c);
    if (role !== "owner" && role !== "admin") return denied(c);
    const body = await c.req.json().catch(() => null);
    if (!validRole(body?.role))
      return c.json({ error: "Role must be admin or member" }, 400);
    if (role !== "owner" && body.role !== "member") return denied(c);
    const token = nanoid(48),
      id = `inv_${nanoid(20)}`,
      now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    await sql
      .prepare(
        `INSERT INTO tenant_invitation (id, tenant_id, token_hash, role, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        c.req.param("tenantId"),
        await hash(token),
        body.role,
        c.var.user_id,
        now,
        expiresAt,
      )
      .run();
    c.header("Cache-Control", "no-store");
    return c.json({ id, token, role: body.role, expires_at: expiresAt }, 201);
  });

  app.delete("/:tenantId/invitations/:invitationId", async (c) => {
    const role = await roleFor(c);
    if (role !== "owner" && role !== "admin") return denied(c);
    const result = await sql
      .prepare(
        `DELETE FROM tenant_invitation WHERE id = ? AND tenant_id = ?
      AND accepted_by IS NULL AND (? = 'owner' OR role = 'member')`,
      )
      .bind(c.req.param("invitationId"), c.req.param("tenantId"), role)
      .run();
    if (!result.meta.changes)
      return c.json(
        { error: "Invitation not found or cannot be revoked" },
        404,
      );
    return c.json({ success: true });
  });
  return app;
}
