import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
// Explicit local source also tests the mount when running in a linked worktree.
import { createNodeControlPlane } from "../../../packages/control-plane-node/src/control-plane.js";

it("mounts the opt-in adapter on the assembled SQLite control plane", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-kha-cp-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const config = loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "1", OMA_KIMI_KHA_COMPAT: "1", MEMORY_QUEUE: "disabled",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"), MEMORY_BLOB_DIR: join(dir, "memory"),
      FILES_BLOB_DIR: join(dir, "files"), SANDBOX_WORKDIR: join(dir, "sandbox"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    });
    const cp = await createNodeControlPlane(await nodeDefaults(config));
    stop = () => cp.stop("test");
    const request = (path: string, body?: unknown) => cp.fetch(new Request(`http://cp${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer dummy", "kimi-api-version": "2026-09-01-beta", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect(await (await request("/kha/v1/agents")).json()).toEqual({ items: [] });
    const created = await request("/kha/v1/environments", { name: "Persisted KHA environment", config: { type: "cloud" } });
    expect(created.status, await created.clone().text()).toBe(201);
    const environment = await created.json() as { id: string };
    const retrieved = await request(`/kha/v1/environments/${environment.id}`);
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toMatchObject({ id: environment.id, name: "Persisted KHA environment", scope: "project", build_status: "ready" });
    expect(await (await request("/kha/v1/environments?include_archived=true")).json()).toMatchObject({
      items: [{ id: environment.id, build_status: "ready" }],
    });
    expect(await (await request("/kha/v1/agents?order=created_at&exclude_multiagent=true")).json()).toEqual({ items: [] });
    expect(await (await request("/kha/v1/sessions?statuses=idle,running")).json()).toEqual({ items: [] });
    expect((await request("/v1/agents")).status).toBe(200); // Native routes no longer require anthropic-beta.
    const missing = await request("/kha/v1/plugins");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  } finally { await stop?.(); await rm(dir, { recursive: true, force: true }); }
});

it("enforces KHA controls and ownership with real auth, SQLite ports and output storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-kha-auth-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const components = await nodeDefaults(loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "0", PLATFORM_ROOT_SECRET: "kha-integration-test-secret", OMA_KIMI_KHA_COMPAT: "1", MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"), MEMORY_BLOB_DIR: join(dir, "memory"),
      FILES_BLOB_DIR: join(dir, "files"), SANDBOX_WORKDIR: join(dir, "sandbox"), SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    }));
    const cp = await createNodeControlPlane(components);
    stop = () => cp.stop("test");
    const sql = components.database.sql;
    for (const tenant of ["owner", "other"]) {
      await sql.prepare("INSERT INTO api_keys (id, tenant_id, name, prefix, hash, credential_type, created_at) VALUES (?, ?, ?, ?, ?, 'workspace', ?)")
        .bind(tenant, tenant, tenant, tenant, createHash("sha256").update(`kha-test-${tenant}`).digest("hex"), Date.now()).run();
    }
    const request = (path: string, body?: unknown, tenant = "owner") => cp.fetch(new Request(`http://cp${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer kha-test-${tenant}`, "kimi-api-version": "2026-09-01-beta",
        "anthropic-beta": "managed-agents-2026-04-01", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const createAgent = await request("/v1/agents", { name: "KHA auth regression", model: "test-model" });
    expect(createAgent.status, await createAgent.clone().text()).toBe(201);
    const agent = await createAgent.json() as { id: string };
    const env = await (await request("/kha/v1/environments", { name: "KHA auth", config: { type: "self_hosted" } })).json() as { id: string };
    const created = await request("/kha/v1/sessions", { agent_id: agent.id, environment_id: env.id });
    expect(created.status, await created.clone().text()).toBe(201);
    const session = await created.json() as { id: string };
    const root = `/kha/v1/sessions/${session.id}`;
    const initial = await sql.prepare("SELECT document FROM managed_sessions WHERE id = ?").bind(session.id).first<{ document: string }>();
    const idleDocument = { ...JSON.parse(initial!.document), status: "idle" };
    await sql.prepare("UPDATE managed_sessions SET document = ?, revision = revision + 1 WHERE id = ?").bind(JSON.stringify(idleDocument), session.id).run();
    const interrupt = { events: [{ type: "user.interrupt" }] };
    const idle = await request(`${root}/events`, interrupt);
    expect.soft(idle.status).toBe(400);
    expect.soft((await idle.json() as any).error?.type).toBe("failed_precondition_error");
    const count = async () => (await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id = ?").bind(session.id).first<{ n: number }>())!.n;
    const before = await count();
    const submitted = await request(`${root}/events`, { events: [{ type: "user.message", data: { content: [{ type: "text", text: "queued input" }] } }] });
    expect.soft(submitted.status, await submitted.clone().text()).toBe(202);
    expect((await submitted.json() as any).event_id).toBeTruthy();
    expect(await count()).toBeGreaterThan(before);
    // No execution poller is started: the input really remains queued in SQLite.
    const pending = await request(`${root}/events/pending`);
    expect.soft(pending.status).toBe(501);
    expect.soft((await pending.json() as any).error?.message).toContain("not implemented");
    const outputDir = join(dir, "outputs", "owner", session.id);
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "report.txt"), "owner-only output");
    const artifacts = await (await request(`/kha/v1/artifacts?session_id=${session.id}`)).json() as any;
    const artifactPath = `/kha/v1/artifacts/${artifacts.items[0].id}`;
    expect(await (await request(`${artifactPath}/content`)).text()).toBe("owner-only output");
    for (const path of [root, `${root}/events`, `${root}/events/stream`, `${root}/threads`, `${root}/events/pending`,
      `/kha/v1/agents/${agent.id}`, `/kha/v1/environments/${env.id}`, artifactPath, `${artifactPath}/content`]) {
      expect((await request(path, undefined, "other")).status, path).toBe(404);
      expect((await request(path, undefined, "invalid")).status, path).toBe(401);
    }
    expect((await request(`${root}/events`, interrupt, "other")).status).toBe(404);
    expect((await request(`${root}/events`, interrupt, "invalid")).status).toBe(401);
    expect((await request("/kha/v1/sessions", { agent_id: agent.id, environment_id: env.id }, "other")).status).toBe(404);
    const state = await sql.prepare("SELECT document FROM managed_sessions WHERE id = ?").bind(session.id).first<{ document: string }>();
    const document = JSON.parse(state!.document);
    document.status = "terminated";
    await sql.prepare("UPDATE managed_sessions SET document = ?, revision = revision + 1 WHERE id = ?").bind(JSON.stringify(document), session.id).run();
    const terminatedBefore = await count();
    const terminated = await request(`${root}/events`, interrupt);
    expect.soft(terminated.status).toBe(400);
    expect.soft((await terminated.json() as any).error?.type).toBe("failed_precondition_error");
    expect.soft(await count()).toBe(terminatedBefore);
    document.status = "running";
    await sql.prepare("UPDATE managed_sessions SET document = ?, revision = revision + 1 WHERE id = ?").bind(JSON.stringify(document), session.id).run();
    const running = await request(`${root}/events`, interrupt);
    expect(running.status, await running.clone().text()).toBe(202);
    expect(await count()).toBeGreaterThan(terminatedBefore);
    document.status = "idle";
    await sql.prepare("UPDATE managed_sessions SET document = ?, revision = revision + 1 WHERE id = ?").bind(JSON.stringify(document), session.id).run();
    // The stricter rule is scoped to KHA; native callers keep their existing semantics.
    expect((await request(`/v1/sessions/${session.id}/events`, interrupt)).status).toBe(200);
  } finally { await stop?.(); await rm(dir, { recursive: true, force: true }); }
});
