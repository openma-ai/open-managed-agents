import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

const tenant = "tn_member_integration";
async function request(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
) {
  return exports.default.fetch(
    new Request(`http://localhost/v1/oma${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
beforeAll(async () => {
  await request("/agents", "test-key");
  const db = env.MAIN_DB;
  await db
    .prepare(
      "INSERT INTO tenant (id,name,createdAt,updatedAt) VALUES (?,?,1,1)",
    )
    .bind(tenant, "Member integration")
    .run();
  for (const [user, key, workspace] of [
    ["cf-owner", "cf-owner-key", tenant],
    ["cf-guest", "cf-guest-key", "tn_cf_guest"],
  ]) {
    if (workspace !== tenant)
      await db
        .prepare(
          "INSERT INTO tenant (id,name,createdAt,updatedAt) VALUES (?,?,1,1)",
        )
        .bind(workspace, workspace)
        .run();
    await db
      .prepare(
        "INSERT INTO membership (user_id,tenant_id,role,created_at) VALUES (?,?,'owner',1)",
      )
      .bind(user, workspace)
      .run();
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    await env.CONFIG_KV.put(
      `apikey:${hash}`,
      JSON.stringify({ tenant_id: workspace, user_id: user }),
    );
  }
});
it("supports invitations in the CF main database and revokes user keys on removal", async () => {
  const created = await request(
    `/tenants/${tenant}/invitations`,
    "cf-owner-key",
    "POST",
    { role: "member" },
  );
  expect(created.status).toBe(201);
  const { token } = (await created.json()) as { token: string };
  expect(
    (
      await request("/tenants/invitations/accept", "cf-guest-key", "POST", {
        token,
      })
    ).status,
  ).toBe(200);
  const listed = await request(`/tenants/${tenant}/members`, "cf-owner-key");
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(2);
  const minted = await request("/me/cli-tokens", "cf-guest-key", "POST", {
    tenant_id: tenant,
  });
  expect(minted.status).toBe(201);
  const key = ((await minted.json()) as { token: string }).token;
  expect((await request("/agents", key)).status).toBe(200);
  expect(
    (
      await request(
        `/tenants/${tenant}/members/cf-guest`,
        "cf-owner-key",
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await request("/agents", key)).status).toBe(403);
});
