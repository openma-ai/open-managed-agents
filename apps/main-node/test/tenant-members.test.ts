import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { applyTenantSchema } from "@open-managed-agents/schema";
import { buildTenantRoutes } from "../../../packages/http-routes/src/tenants/index";
let sql: SqlClient;
let app: Hono;
const request = (
  path: string,
  user = "owner",
  method = "GET",
  body?: unknown,
) =>
  app.request(`/tenants${path}`, {
    method,
    headers: { "x-test-user": user, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function invite(role = "member", user = "owner") {
  const res = await request("/t/invitations", user, "POST", { role });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; token: string }>;
}
beforeEach(async () => {
  sql = await createBetterSqlite3SqlClient(":memory:");
  await applyTenantSchema(sql);
  await sql.exec(`INSERT INTO tenant VALUES ('t','Team',1,1),('other','Other',1,1);
    INSERT INTO membership VALUES ('owner','t','owner',1),('admin','t','admin',2),('member','t','member',3),('outsider','other','owner',1);`);
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user_id" as never, c.req.header("x-test-user") as never);
    c.set("tenant_id" as never, "t" as never);
    await next();
  });
  app.route(
    "/tenants",
    buildTenantRoutes({ services: {} as never, memberSql: sql } as Parameters<
      typeof buildTenantRoutes
    >[0]),
  );
});
describe("workspace members", () => {
  it("lists members only for workspace members", async () => {
    expect((await request("/t/members", "outsider")).status).toBe(403);
    const res = await request("/t/members", "member");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(3);
  });
  it("allows owners to change roles but protects owners", async () => {
    expect(
      (await request("/t/members/member", "owner", "PATCH", { role: "admin" }))
        .status,
    ).toBe(200);
    expect(
      await sql
        .prepare("SELECT role FROM membership WHERE user_id = ?")
        .bind("member")
        .first(),
    ).toEqual({ role: "admin" });
    expect(
      (await request("/t/members/owner", "owner", "PATCH", { role: "member" }))
        .status,
    ).toBe(403);
    expect((await request("/t/members/owner", "owner", "DELETE")).status).toBe(
      403,
    );
  });
  it("blocks member management and admin escalation", async () => {
    expect(
      (await request("/t/invitations", "member", "POST", { role: "member" }))
        .status,
    ).toBe(403);
    expect(
      (await request("/t/invitations", "admin", "POST", { role: "admin" }))
        .status,
    ).toBe(403);
    expect(
      (await request("/t/members/member", "admin", "PATCH", { role: "admin" }))
        .status,
    ).toBe(403);
    expect((await request("/t/members/admin", "admin", "DELETE")).status).toBe(
      403,
    );
    expect(
      (await request("/other/members/outsider", "owner", "DELETE")).status,
    ).toBe(403);
    expect((await request("/t/members/member", "admin", "DELETE")).status).toBe(
      200,
    );
  });
  it("creates a single-use invitation without upgrading existing roles", async () => {
    const invitation = await invite();
    const res = await request("/invitations/accept", "new-user", "POST", {
      token: invitation.token,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant_id).toBe("t");
    expect(
      await sql
        .prepare("SELECT role FROM membership WHERE user_id = ?")
        .bind("new-user")
        .first(),
    ).toEqual({ role: "member" });
    expect(
      (
        await request("/invitations/accept", "another", "POST", {
          token: invitation.token,
        })
      ).status,
    ).toBe(410);
    const second = await invite("admin");
    expect(
      (
        await request("/invitations/accept", "member", "POST", {
          token: second.token,
        })
      ).status,
    ).toBe(200);
    expect(
      await sql
        .prepare("SELECT role FROM membership WHERE user_id = ?")
        .bind("member")
        .first(),
    ).toEqual({ role: "member" });
  });
  it("rejects revoked, expired, and invalid invites", async () => {
    const revoked = await invite();
    expect(
      (await request(`/t/invitations/${revoked.id}`, "owner", "DELETE")).status,
    ).toBe(200);
    expect(
      (
        await request("/invitations/accept", "new", "POST", {
          token: revoked.token,
        })
      ).status,
    ).toBe(410);
    const expired = await invite();
    await sql
      .prepare("UPDATE tenant_invitation SET expires_at = 1 WHERE id = ?")
      .bind(expired.id)
      .run();
    expect(
      (
        await request("/invitations/accept", "new", "POST", {
          token: expired.token,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await request("/invitations/accept", "new", "POST", {
          token: "invalid",
        })
      ).status,
    ).toBe(410);
  });
  it("invalidates pending invitations when their creator loses permission", async () => {
    const invitation = await invite("member", "admin");
    await request("/t/members/admin", "owner", "PATCH", { role: "member" });
    expect(
      (
        await request("/invitations/accept", "new", "POST", {
          token: invitation.token,
        })
      ).status,
    ).toBe(410);
  });
  it("does not disclose invite tokens and rejects malformed roles", async () => {
    const invitation = await invite();
    const res = await request("/t/invitations");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(invitation.token);
    expect(
      (await request("/t/invitations", "owner", "POST", { role: "owner" }))
        .status,
    ).toBe(400);
    expect(
      (await request("/t/invitations", "owner", "POST", null)).status,
    ).toBe(400);
  });
  it("only lets one concurrent recipient claim a link", async () => {
    const invitation = await invite();
    const results = await Promise.all(
      ["a", "b"].map((user) =>
        request("/invitations/accept", user, "POST", {
          token: invitation.token,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(
      (
        await sql
          .prepare("SELECT user_id FROM membership WHERE user_id IN ('a','b')")
          .all()
      ).results,
    ).toHaveLength(1);
  });
});

it("rechecks admin permission when membership changes during removal", async () => {
  const prepare = sql.prepare.bind(sql);
  let demoted = false;
  sql.prepare = (query: string) => {
    const statement = prepare(query);
    if (!query.includes("SELECT role FROM membership")) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      const bound = bind(...args);
      const first = bound.first.bind(bound);
      bound.first = async <T>() => {
        const row = await first<T>();
        if (!demoted) {
          demoted = true;
          await prepare("UPDATE membership SET role = 'member' WHERE user_id = 'admin'").run();
        }
        return row;
      };
      return bound;
    };
    return statement;
  };
  expect((await request("/t/members/member", "admin", "DELETE")).status).toBe(
    403,
  );
  expect(
    await prepare(
      "SELECT role FROM membership WHERE user_id = 'member'",
    ).first(),
  ).toEqual({ role: "member" });
});
