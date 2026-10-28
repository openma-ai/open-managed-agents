import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMatterService,
  loadMatterConfig,
  type MatterConfig,
  type MatterService,
} from "../src/server.js";
import { FakeOma } from "./fake-oma.js";

const BASE = "https://gitlab.example.com";
/** The user's own token: Maintainer of group/app, `api` scope. */
const USER_TOKEN = "glpat-user-maintainer";
/** Another user's token: sees the project, is no Maintainer. */
const REPORTER_TOKEN = "glpat-user-reporter";
/** Bot tokens pasted by hand. */
const PASTED = "glpat-pasted-bot";
const PASTED_2 = "glpat-pasted-bot-2";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly token: string | null;
  readonly body?: unknown;
}

/** A GitLab instance that records every call: users by token, one project
 * (id 42, `group/app`), project access tokens and notes. */
class FakeGitLab {
  readonly calls: Call[] = [];
  readonly users = new Map<string, string>([
    [PASTED, "oma-bot"],
    [PASTED_2, "oma-bot-2"],
    [USER_TOKEN, "alice"],
    [REPORTER_TOKEN, "bob"],
  ]);
  readonly facts = new Map<string, { scopes: string[]; expires_at: string | null }>([
    [PASTED, { scopes: ["api"], expires_at: "2027-01-31" }],
    [PASTED_2, { scopes: ["read_repository"], expires_at: null }],
  ]);
  readonly minted: string[] = [];
  /** Status of `/personal_access_tokens/self`, to fail it. */
  selfStatus = 200;
  /** Status of creating a project access token, to fail it. */
  mintStatus = 201;
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    this.calls.push({ method, path: url.pathname, token, ...(body === undefined ? {} : { body }) });
    const known = token !== null && this.users.has(token);
    if (url.pathname === "/api/v4/user") {
      return known ? Response.json({ id: 9, username: this.users.get(token!) }) : Response.json({}, { status: 401 });
    }
    if (url.pathname === "/api/v4/personal_access_tokens/self") {
      if (this.selfStatus !== 200) return Response.json({}, { status: this.selfStatus });
      const facts = token === null ? undefined : this.facts.get(token);
      return facts === undefined ? Response.json({}, { status: 404 }) : Response.json({ id: 1, active: true, ...facts });
    }
    const project = /^\/api\/v4\/projects\/([^/]+)$/.exec(url.pathname);
    if (project?.[1] !== undefined && method === "GET") {
      if (!known) return Response.json({ message: "401 Unauthorized" }, { status: 401 });
      const id = decodeURIComponent(project[1]);
      return id === "42" || id === "group/app"
        ? Response.json({ id: 42, path_with_namespace: "group/app" })
        : Response.json({ message: "404 Project Not Found" }, { status: 404 });
    }
    if (url.pathname === "/api/v4/projects/42/access_tokens" && method === "POST") {
      if (!known) return Response.json({ message: "401 Unauthorized" }, { status: 401 });
      if (token !== USER_TOKEN) return Response.json({ message: "403 Forbidden" }, { status: 403 });
      if (this.mintStatus !== 201) {
        return Response.json({ message: "expires_at is beyond the limit" }, { status: this.mintStatus });
      }
      const request = body as { scopes: string[]; expires_at: string };
      const bot = `glpat-minted-${this.minted.length + 1}`;
      this.minted.push(bot);
      this.users.set(bot, `project_42_bot_${this.minted.length}`);
      this.facts.set(bot, { scopes: request.scopes, expires_at: request.expires_at });
      return Response.json({ id: 100 + this.minted.length, token: bot, ...request }, { status: 201 });
    }
    if (method === "POST" && url.pathname.endsWith("/notes")) {
      return Response.json({ id: 1000 + this.calls.length }, { status: 201 });
    }
    return Response.json({ message: "404 Not Found" }, { status: 404 });
  }) as typeof fetch;

  notes() {
    return this.calls.filter((c) => c.method === "POST" && c.path.endsWith("/notes"));
  }
}

const proxied = { "x-matter-proxy-secret": "proxy-secret", "x-oma-tenant-id": "default", "x-oma-user-id": "usr_1" };

const waitFor = async <T>(read: () => T | undefined, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const inAYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

let dir: string;
let oma: FakeOma;
let gitlab: FakeGitLab;
let services: MatterService[];
let config: MatterConfig;

const start = async () => {
  const service = await createMatterService(config, {
    omaFetch: oma.fetch as typeof fetch,
    fetch: gitlab.fetch,
    onError: () => {},
  });
  services.push(service);
  return service;
};

const call = (service: MatterService, method: string, path: string, body?: unknown, headers = proxied) =>
  service.fetch(
    new Request(`https://matter.test${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const problem = async (response: Response) => [response.status, ((await response.json()) as { error: string }).error];

const note = (text: string) => ({
  object_kind: "note",
  user: { id: 8, username: "carol" },
  project: { id: 42, path_with_namespace: "group/app" },
  object_attributes: {
    id: 555,
    note: text,
    noteable_type: "MergeRequest",
    system: false,
    created_at: "2026-08-23T08:00:02Z",
  },
  merge_request: { iid: 7, draft: false },
});

let delivery = 0;
const webhook = (service: MatterService, id: string, secret: string, payload: unknown) =>
  service.fetch(
    new Request(`https://matter.test/webhooks/gitlab/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": secret,
        "x-gitlab-event": "Note Hook",
        "x-gitlab-event-uuid": `uuid-${(delivery += 1)}`,
      },
      body: JSON.stringify(payload),
    }),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matter-gitlab-bot-"));
  oma = new FakeOma();
  oma.agents.set("agent-1", { id: "agent-1", version: 1, mcp_servers: [], tools: [] });
  gitlab = new FakeGitLab();
  services = [];
  config = loadMatterConfig({
    MATTER_DATA_DIR: dir,
    MATTER_PROXY_SECRET: "proxy-secret",
    MATTER_SECRET_KEY: "a-long-enough-secret-key",
    OMA_URL: "https://oma.test",
    OMA_API_KEY: "test-key",
    OMA_ENVIRONMENT_ID: "env_1",
    MATTER_MCP_URL: "https://matter.test/mcp",
    MATTER_PUBLIC_URL: "https://matter.example.com/",
  });
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("creating a project bot", () => {
  it("mints a read-only project access token by project path and links its bot, keeping no user token", async () => {
    const service = await start();
    const created = await call(service, "POST", "/connect/gitlab/bot", {
      baseUrl: `${BASE}/`,
      project: "group/app",
      userToken: USER_TOKEN,
    });
    expect(created.status).toBe(201);
    const text = await created.text();
    const result = JSON.parse(text) as Record<string, unknown>;
    // The same shape as `POST /connect/gitlab`.
    expect(Object.keys(result).sort()).toEqual(["id", "projectIds", "username", "webhookSecret", "webhookUrl"]);
    expect(result).toMatchObject({ username: "project_42_bot_1", projectIds: [] });
    expect(result.id).toMatch(/^gitlab-[0-9a-f]{16}$/);
    expect(result.webhookUrl).toBe(`https://matter.example.com/webhooks/gitlab/${String(result.id)}`);

    // The user's token resolved the path and created the token, nothing else.
    expect(gitlab.calls.filter((c) => c.token === USER_TOKEN)).toEqual([
      { method: "GET", path: "/api/v4/projects/group%2Fapp", token: USER_TOKEN },
      {
        method: "POST",
        path: "/api/v4/projects/42/access_tokens",
        token: USER_TOKEN,
        body: {
          name: "openma-matter-read",
          scopes: ["read_repository", "read_api"],
          access_level: 20,
          expires_at: inAYear(),
        },
      },
    ]);
    const bot = gitlab.minted[0]!;
    // The bot token is checked as a pasted one is.
    expect(gitlab.calls.filter((c) => c.token === bot).map((c) => c.path)).toEqual([
      "/api/v4/user",
      "/api/v4/personal_access_tokens/self",
    ]);

    // Saved: the bot token in `token`, and nowhere else; never the user's.
    const record = (await service.db.gitlab.get(String(result.id)))!;
    expect(record).toMatchObject({
      baseUrl: BASE,
      token: bot,
      username: "project_42_bot_1",
      tenantId: "default",
      tokenScopes: ["read_repository", "read_api"],
      tokenExpiresAt: inAYear(),
    });
    const { token: _token, ...rest } = record;
    expect(JSON.stringify(rest)).not.toContain(bot);
    expect(JSON.stringify(record)).not.toContain(USER_TOKEN);
    const raw = readFileSync(join(dir, "matter.sqlite")).toString("latin1");
    expect(raw).not.toContain(USER_TOKEN);
    expect(raw).not.toContain(bot);
    expect(text).not.toContain(USER_TOKEN);
    expect(text).not.toContain(bot);

    // The Bond shows the token's scopes and expiry, and no token.
    const bonds = await (await call(service, "GET", "/bonds")).text();
    expect(JSON.parse(bonds)).toMatchObject({
      data: [
        {
          id: `gitlab:${String(result.id)}`,
          details: { username: "project_42_bot_1", tokenScopes: "read_repository, read_api", tokenExpiresAt: inAYear() },
        },
      ],
    });
    for (const secret of [USER_TOKEN, bot]) expect(bonds).not.toContain(secret);
  });

  it("mints a token that can comment, by project id, with the expiry asked for", async () => {
    const service = await start();
    const created = await call(service, "POST", "/connect/gitlab/bot", {
      baseUrl: BASE,
      project: 42,
      preset: "comment",
      expiresAt: "2099-03-01",
      userToken: USER_TOKEN,
    });
    expect(created.status).toBe(201);
    expect(gitlab.calls.filter((c) => c.token === USER_TOKEN)).toEqual([
      { method: "GET", path: "/api/v4/projects/42", token: USER_TOKEN },
      {
        method: "POST",
        path: "/api/v4/projects/42/access_tokens",
        token: USER_TOKEN,
        body: { name: "openma-matter-comment", scopes: ["api"], access_level: 20, expires_at: "2099-03-01" },
      },
    ]);
    const { id } = (await created.json()) as { id: string };
    expect(await service.db.gitlab.get(id)).toMatchObject({
      token: gitlab.minted[0],
      tokenScopes: ["api"],
      tokenExpiresAt: "2099-03-01",
    });
  });

  it("maps GitLab's refusals and checks the request before calling it", async () => {
    const service = await start();
    const bot = (body: Record<string, unknown>) =>
      call(service, "POST", "/connect/gitlab/bot", { baseUrl: BASE, project: "group/app", userToken: USER_TOKEN, ...body });
    const refused = "GitLab rejected your token or you are not a Maintainer of the project";
    expect(await problem(await bot({ userToken: "glpat-wrong" }))).toEqual([400, refused]);
    expect(await problem(await bot({ userToken: REPORTER_TOKEN }))).toEqual([400, refused]);
    expect(await problem(await bot({ project: "group/missing" }))).toEqual([404, expect.stringContaining("not found")]);
    gitlab.mintStatus = 500;
    expect(await problem(await bot({}))).toEqual([502, "GitLab did not create the project access token"]);
    gitlab.mintStatus = 400;
    expect(await problem(await bot({}))).toEqual([400, expect.stringContaining("expires_at is beyond the limit")]);
    gitlab.mintStatus = 201;

    const before = gitlab.calls.length;
    expect(await problem(await bot({ baseUrl: "ftp://gitlab.example.com" }))).toEqual([400, expect.stringContaining("baseUrl")]);
    expect(await problem(await bot({ project: "app" }))).toEqual([400, expect.stringContaining("project")]);
    expect(await problem(await bot({ project: 0 }))).toEqual([400, expect.stringContaining("project")]);
    expect(await problem(await bot({ preset: "write" }))).toEqual([400, "preset must be read or comment"]);
    for (const expiresAt of ["2099-02-30", "01/03/2099", "2020-01-01"]) {
      expect(await problem(await bot({ expiresAt }))).toEqual([400, expect.stringContaining("expiresAt")]);
    }
    expect(await problem(await bot({ userToken: " " }))).toEqual([400, "userToken is required"]);
    expect(gitlab.calls.length).toBe(before);
    expect((await call(service, "GET", "/connect/gitlab/bot")).status).toBe(405);
    expect((await call(service, "POST", "/connect/gitlab/bot", {}, {} as typeof proxied)).status).toBe(401);
    expect(await service.db.gitlab.list()).toEqual([]);
  });

  it("links the bot even when GitLab does not tell the token's scopes", async () => {
    gitlab.selfStatus = 404;
    const service = await start();
    const created = await call(service, "POST", "/connect/gitlab/bot", { baseUrl: BASE, project: 42, userToken: USER_TOKEN });
    expect(created.status).toBe(201);
    const record = (await service.db.gitlab.get(((await created.json()) as { id: string }).id))!;
    expect(record.token).toBe(gitlab.minted[0]);
    expect("tokenScopes" in record || "tokenExpiresAt" in record).toBe(false);
    const bonds = (await (await call(service, "GET", "/bonds")).json()) as { data: { details: Record<string, unknown> }[] };
    expect(Object.keys(bonds.data[0]!.details).sort()).toEqual(["baseUrl", "username", "webhookUrl"]);
  });
});

describe("replacing a Bond's token", () => {
  it("keeps the Bond, its webhook and Loops, and the running connection uses the new token", async () => {
    const service = await start();
    const created = await call(service, "POST", "/connect/gitlab", {
      baseUrl: BASE,
      token: PASTED,
      agentId: "agent-1",
      projectIds: [42],
    });
    expect(created.status).toBe(201);
    const bond = (await created.json()) as { id: string; webhookSecret: string };
    const repository = `${BASE}/group/app.git`;
    const cloning = await call(service, "POST", "/loops", {
      template: "gitlab-mr-review",
      config: { bond: `gitlab:${bond.id}`, agentId: "agent-1", projects: ["project:42"], repositories: [repository] },
    });
    expect(cloning.status).toBe(201);
    const before = (await service.db.gitlab.get(bond.id))!;
    expect(before).toMatchObject({ tokenScopes: ["api"], tokenExpiresAt: "2027-01-31" });

    const replaced = await call(service, "PUT", `/connect/gitlab/${bond.id}/token`, { token: ` ${PASTED_2} ` });
    expect(replaced.status).toBe(200);
    const text = await replaced.text();
    expect(JSON.parse(text)).toEqual({
      id: bond.id,
      username: "oma-bot-2",
      webhookUrl: `https://matter.example.com/webhooks/gitlab/${bond.id}`,
      tokenScopes: ["read_repository"],
    });
    expect(text).not.toContain(PASTED_2);
    expect(text).not.toContain(bond.webhookSecret);

    const after = (await service.db.gitlab.get(bond.id))!;
    expect(after).toMatchObject({
      id: bond.id,
      baseUrl: BASE,
      token: PASTED_2,
      username: "oma-bot-2",
      webhookSecret: before.webhookSecret,
      projectIds: [42],
      tenantId: "default",
      tokenScopes: ["read_repository"],
    });
    expect(after.tokenExpiresAt).toBeUndefined();
    expect(await service.db.gitlab.list()).toHaveLength(1);

    // The Loops stay; the mention Loop follows the new bot user.
    const loops = await service.db.loops.listForBond("gitlab", bond.id);
    expect(loops.map((l) => l.template).sort()).toEqual(["gitlab-mention", "gitlab-mr-review"]);
    expect(loops.find((l) => l.template === "gitlab-mention")?.config.username).toBe("oma-bot-2");
    // The Loop's repository still resolves to this Bond, now with the new token.
    const credential = await service.fetch(
      new Request("https://matter.test/internal/repository-credential", {
        method: "POST",
        headers: { "content-type": "application/json", "x-matter-internal-secret": "proxy-secret", "x-oma-tenant-id": "default" },
        body: JSON.stringify({ url: repository }),
      }),
    );
    expect(await credential.json()).toEqual({ token: PASTED_2 });
    expect((await call(service, "DELETE", `/bonds/${encodeURIComponent(`gitlab:${bond.id}`)}`)).status).toBe(409);

    // The next mention is answered with the new token, without a restart.
    oma.responder = (_sessionId, event) =>
      event.type === "user.message"
        ? [
            { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "On it." }] },
            { type: "session.status_idle", stop_reason: { type: "end_turn" } },
          ]
        : undefined;
    expect((await webhook(service, bond.id, before.webhookSecret, note("@oma-bot-2 hi"))).status).toBe(202);
    const posted = await waitFor(() => gitlab.notes()[0]);
    expect(posted.token).toBe(PASTED_2);
  });

  it("mints a new project bot token in place", async () => {
    const service = await start();
    const bond = (await (await call(service, "POST", "/connect/gitlab", { baseUrl: BASE, token: PASTED })).json()) as {
      id: string;
    };
    const replaced = await call(service, "PUT", `/connect/gitlab/${bond.id}/token`, {
      userToken: USER_TOKEN,
      project: "group/app",
      preset: "comment",
    });
    expect(replaced.status).toBe(200);
    const text = await replaced.text();
    expect(JSON.parse(text)).toMatchObject({ id: bond.id, username: "project_42_bot_1", tokenScopes: ["api"], tokenExpiresAt: inAYear() });
    for (const secret of [USER_TOKEN, gitlab.minted[0]!]) expect(text).not.toContain(secret);
    expect(gitlab.calls.filter((c) => c.token === USER_TOKEN).map((c) => [c.method, c.path, c.body])).toEqual([
      ["GET", "/api/v4/projects/group%2Fapp", undefined],
      [
        "POST",
        "/api/v4/projects/42/access_tokens",
        { name: "openma-matter-comment", scopes: ["api"], access_level: 20, expires_at: inAYear() },
      ],
    ]);
    const record = (await service.db.gitlab.get(bond.id))!;
    expect(record.token).toBe(gitlab.minted[0]);
    expect(JSON.stringify(record)).not.toContain(USER_TOKEN);
  });

  it("refuses another workspace's Bond and leaves the Bond as it was on a failure", async () => {
    const service = await start();
    await service.db.gitlab.save({
      id: "gitlab-else", baseUrl: BASE, token: "glpat-else", username: "else-bot",
      webhookSecret: "w", projectIds: [], tenantId: "tenant-else", agentId: "",
    });
    const put = (id: string, body: unknown) => call(service, "PUT", `/connect/gitlab/${id}/token`, body);
    expect(await problem(await put("gitlab-else", { token: PASTED_2 }))).toEqual([404, "GitLab Bond not found"]);
    expect(await problem(await put("gitlab-0000", { token: PASTED_2 }))).toEqual([404, "GitLab Bond not found"]);
    expect((await service.db.gitlab.get("gitlab-else"))?.token).toBe("glpat-else");

    const bond = (await (await call(service, "POST", "/connect/gitlab", { baseUrl: BASE, token: PASTED })).json()) as {
      id: string;
    };
    const saved = await service.db.gitlab.get(bond.id);
    expect(await problem(await put(bond.id, { token: "glpat-wrong" }))).toEqual([400, "GitLab rejected the token"]);
    expect(await problem(await put(bond.id, { token: PASTED_2, userToken: USER_TOKEN }))).toEqual([400, "Give either token or userToken"]);
    expect(await problem(await put(bond.id, {}))).toEqual([400, "Give either token or userToken"]);
    expect(await problem(await put(bond.id, { userToken: REPORTER_TOKEN, project: 42 }))).toEqual([
      400,
      "GitLab rejected your token or you are not a Maintainer of the project",
    ]);
    expect(await problem(await put(bond.id, { userToken: USER_TOKEN, project: 7 }))).toEqual([404, expect.stringContaining("not found")]);
    expect((await call(service, "POST", `/connect/gitlab/${bond.id}/token`, { token: PASTED_2 })).status).toBe(405);
    expect(await service.db.gitlab.get(bond.id)).toEqual(saved);
  });
});
