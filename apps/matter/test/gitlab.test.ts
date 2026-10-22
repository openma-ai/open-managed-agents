import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

const TOKEN = "glpat-bot-token-value";
const BASE = "https://gitlab.test";

/** A GitLab instance: the token's user, and the notes posted. */
class FakeGitLab {
  readonly notes: { path: string; body: unknown; token: string | null }[] = [];
  userStatus = 200;
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (url.pathname === "/api/v4/user") {
      if (token !== TOKEN || this.userStatus !== 200) {
        return Response.json({ message: "401 Unauthorized" }, { status: this.userStatus === 200 ? 401 : this.userStatus });
      }
      return Response.json({ id: 99, username: "oma-bot" });
    }
    if (init?.method === "POST" && url.pathname.endsWith("/notes")) {
      this.notes.push({ path: url.pathname, body: JSON.parse(String(init.body)), token });
      return Response.json({ id: 1000 + this.notes.length }, { status: 201 });
    }
    return Response.json({ message: "404 Not Found" }, { status: 404 });
  }) as typeof fetch;
}

const note = (text: string, options: { author?: string; discussionId?: string; projectId?: number } = {}) => ({
  object_kind: "note",
  user: { id: 8, username: options.author ?? "bob" },
  project: { id: options.projectId ?? 42, path_with_namespace: "platform/api" },
  object_attributes: {
    id: 555,
    note: text,
    noteable_type: "MergeRequest",
    system: false,
    ...(options.discussionId === undefined ? {} : { discussion_id: options.discussionId }),
    created_at: "2026-08-23T08:00:02Z",
  },
  merge_request: { iid: 7, draft: false },
});

const waitFor = async <T>(read: () => T | undefined, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const proxied = { "x-matter-proxy-secret": "proxy-secret", "x-oma-tenant-id": "default", "x-oma-user-id": "usr_1" };

let dir: string;
let oma: FakeOma;
let gitlab: FakeGitLab;
let services: MatterService[];
let config: MatterConfig;
let baseEnv: Record<string, string>;

const start = async () => {
  const service = await createMatterService(config, {
    omaFetch: oma.fetch as typeof fetch,
    fetch: gitlab.fetch,
    onError: () => {},
  });
  services.push(service);
  return service;
};

const connect = (service: MatterService, body: unknown, headers: Record<string, string> = proxied) =>
  service.fetch(
    new Request("https://matter.test/connect/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

let delivery = 0;
const webhook = (
  service: MatterService,
  path: string,
  secret: string,
  payload: unknown,
  deliveryId = `uuid-${(delivery += 1)}`,
) =>
  service.fetch(
    new Request(`https://matter.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": secret,
        "x-gitlab-event": "Note Hook",
        "x-gitlab-event-uuid": deliveryId,
      },
      body: JSON.stringify(payload),
    }),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matter-gitlab-"));
  oma = new FakeOma();
  oma.agents.set("agent-1", { id: "agent-1", version: 1, mcp_servers: [], tools: [] });
  gitlab = new FakeGitLab();
  services = [];
  baseEnv = {
    MATTER_DATA_DIR: dir,
    MATTER_PROXY_SECRET: "proxy-secret",
    MATTER_SECRET_KEY: "a-long-enough-secret-key",
    OMA_URL: "https://oma.test",
    OMA_API_KEY: "test-key",
    OMA_ENVIRONMENT_ID: "env_1",
    MATTER_MCP_URL: "https://matter.test/mcp",
    MATTER_PUBLIC_URL: "https://matter.example.com/",
  };
  config = loadMatterConfig(baseEnv);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const valid = { baseUrl: `${BASE}/`, token: TOKEN, agentId: "agent-1", projectIds: [42, "42"] };

describe("without an API key", () => {
  it("acts in the caller's workspace through the trusted headers and its newest environment", async () => {
    oma.trustSecret = "proxy-secret";
    oma.environments = [{ id: "env_old", archived_at: "2026-01-01T00:00:00Z" }, { id: "env_ws" }];
    const { OMA_API_KEY: _k, OMA_ENVIRONMENT_ID: _e, ...env } = baseEnv;
    config = loadMatterConfig(env);
    const service = await start();
    const created = await connect(service, valid, { ...proxied, "x-oma-tenant-id": "tn_team" });
    expect(created.status).toBe(201);
    const result = (await created.json()) as { id: string; webhookSecret: string };
    oma.responder = (_sessionId, event) =>
      event.type === "user.message"
        ? [
            { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hi." }] },
            { type: "session.status_idle", stop_reason: { type: "end_turn" } },
          ]
        : undefined;
    expect((await webhook(service, `/webhooks/gitlab/${result.id}`, result.webhookSecret, note("@oma-bot hi"))).status).toBe(202);
    await waitFor(() => gitlab.notes[0]);
    // Every OpenMA call was made as that workspace, with no API key.
    expect(oma.requests.length).toBeGreaterThan(0);
    expect(oma.requests.every((r) => r.tenant === "tn_team")).toBe(true);
    expect([...oma.sessions.values()][0]).toMatchObject({ environment_id: "env_ws" });
  });
});

describe("GitLab connections", () => {
  it("connects an instance, answers a mention from a webhook in the same thread, and survives a restart", async () => {
    const service = await start();
    const created = await connect(service, valid);
    expect(created.status).toBe(201);
    const result = (await created.json()) as {
      id: string;
      username: string;
      projectIds: number[];
      webhookUrl: string;
      webhookSecret: string;
    };
    expect(result).toMatchObject({ username: "oma-bot", projectIds: [42] });
    expect(result.id).toMatch(/^gitlab-[0-9a-f]{16}$/);
    expect(result.webhookUrl).toBe(`https://matter.example.com/webhooks/gitlab/${result.id}`);
    expect(result.webhookSecret.length).toBeGreaterThanOrEqual(32);
    expect(service.host.running()).toEqual([result.id]);
    // The Agent got the Matter MCP server, as for Feishu.
    expect(oma.agents.get("agent-1")?.mcp_servers).toEqual([
      { name: "openmatter", type: "url", url: "https://matter.test/mcp" },
    ]);

    // The OpenMA harness answers each user message with text and ends the Turn.
    const prompts: string[] = [];
    oma.responder = (_sessionId, event) => {
      if (event.type !== "user.message") return undefined;
      prompts.push(JSON.stringify(event));
      return [
        { type: "agent.message", id: `msg_${prompts.length}`, content: [{ type: "text", text: "Retries back off." }] },
        { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ];
    };

    const path = new URL(result.webhookUrl).pathname;
    const accepted = await webhook(service, path, result.webhookSecret, note("@oma-bot how do retries work?", { discussionId: "d1" }), "uuid-a");
    expect(accepted.status).toBe(202);

    const posted = await waitFor(() => gitlab.notes[0]);
    expect(posted).toEqual({
      path: "/api/v4/projects/42/merge_requests/7/discussions/d1/notes",
      body: { body: "Retries back off." },
      token: TOKEN,
    });
    expect(prompts[0]).toContain("how do retries work?");
    const sessions = [...oma.sessions.values()];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agent: "agent-1", environment_id: "env_1" });

    // GitLab redelivers the same webhook: accepted, answered once.
    expect((await webhook(service, path, result.webhookSecret, note("@oma-bot how do retries work?", { discussionId: "d1" }), "uuid-a")).status).toBe(202);
    // Comments that are not for the bot, or outside the watched projects, are not answered.
    expect((await webhook(service, path, result.webhookSecret, note("lgtm"))).status).toBe(202);
    expect((await webhook(service, path, result.webhookSecret, note("@oma-bot hi", { projectId: 43 }))).status).toBe(202);
    expect((await webhook(service, path, result.webhookSecret, note("@oma-bot thanks", { author: "oma-bot" }))).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gitlab.notes).toHaveLength(1);

    // Secrets are sealed at rest.
    const raw = readFileSync(join(dir, "matter.sqlite")).toString("latin1");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(result.webhookSecret);
    expect(readdirSync(join(dir, "apps", result.id))).toEqual(expect.arrayContaining(["inbox.sqlite", "store.sqlite"]));

    // The tenant's connections are listed without secrets.
    const listed = await service.fetch(new Request("https://matter.test/connect/gitlab", { headers: proxied }));
    const list = (await listed.json()) as { data: Record<string, unknown>[] };
    expect(list.data).toEqual([
      expect.objectContaining({ id: result.id, baseUrl: BASE, username: "oma-bot" }),
    ]);
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    expect(JSON.stringify(list)).not.toContain(result.webhookSecret);

    // Restart: the connection comes back from the database and takes webhooks.
    await service.close();
    services.splice(services.indexOf(service), 1);
    const again = await start();
    await again.host.start();
    expect(again.host.running()).toEqual([result.id]);
    expect((await webhook(again, path, result.webhookSecret, note("@oma-bot and timeouts?"))).status).toBe(202);
    const second = await waitFor(() => gitlab.notes[1]);
    expect(second.path).toBe("/api/v4/projects/42/merge_requests/7/notes");
  });

  it("authenticates every webhook with the connection's own secret", async () => {
    const service = await start();
    const a = (await (await connect(service, valid)).json()) as { id: string; webhookSecret: string };
    const b = (await (await connect(service, valid)).json()) as { id: string; webhookSecret: string };
    expect(a.id).not.toBe(b.id);
    const payload = note("@oma-bot hi");
    expect((await webhook(service, `/webhooks/gitlab/${a.id}`, "wrong", payload)).status).toBe(401);
    expect((await webhook(service, `/webhooks/gitlab/${a.id}`, b.webhookSecret, payload)).status).toBe(401);
    expect((await webhook(service, "/webhooks/gitlab/gitlab-0000000000000000", a.webhookSecret, payload)).status).toBe(404);
    const get = await service.fetch(new Request(`https://matter.test/webhooks/gitlab/${a.id}`));
    expect(get.status).toBe(405);
    const noUuid = await service.fetch(
      new Request(`https://matter.test/webhooks/gitlab/${a.id}`, {
        method: "POST",
        headers: { "x-gitlab-token": a.webhookSecret, "x-gitlab-event": "Note Hook" },
        body: JSON.stringify(payload),
      }),
    );
    expect(noUuid.status).toBe(400);
    expect(oma.sessions.size).toBe(0);
  });

  it("starts a saved connection a replica does not run yet when its webhook arrives", async () => {
    const service = await start();
    const a = (await (await connect(service, valid)).json()) as { id: string; webhookSecret: string };
    await service.host.stop();
    expect(service.host.running()).toEqual([]);
    expect((await webhook(service, `/webhooks/gitlab/${a.id}`, a.webhookSecret, note("@oma-bot hi"))).status).toBe(202);
    expect(service.host.running()).toEqual([a.id]);
  });

  it("answers 503 when the connection cannot run, so GitLab retries", async () => {
    const service = await start();
    const a = (await (await connect(service, valid)).json()) as { id: string; webhookSecret: string };
    await service.host.stop();
    // This service cannot act in the connection's workspace any more.
    const other = await createMatterService({ ...config, omaTenantId: "elsewhere" }, {
      omaFetch: oma.fetch as typeof fetch,
      fetch: gitlab.fetch,
      onError: () => {},
      db: service.db,
    });
    expect((await webhook(other, `/webhooks/gitlab/${a.id}`, a.webhookSecret, note("@oma-bot hi"))).status).toBe(503);
    await other.host.stop();
  });

  it("validates the request, the token and the Agent before saving", async () => {
    const service = await start();
    expect((await connect(service, valid, {})).status).toBe(401);
    expect((await connect(service, valid, { ...proxied, "x-oma-tenant-id": "other" })).status).toBe(401);
    const problem = async (body: unknown) => {
      const response = await connect(service, body);
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    expect(await problem({ ...valid, baseUrl: "ftp://gitlab.test" })).toEqual([400, expect.stringContaining("baseUrl")]);
    expect(await problem({ ...valid, baseUrl: "https://u:p@gitlab.test" })).toEqual([400, expect.stringContaining("baseUrl")]);
    expect(await problem({ ...valid, token: " " })).toEqual([400, "token is required"]);
    expect(await problem({ ...valid, projectIds: [] })).toEqual([400, expect.stringContaining("projectIds")]);
    expect(await problem({ ...valid, projectIds: [0] })).toEqual([400, expect.stringContaining("projectIds")]);
    expect(await problem({ ...valid, token: "wrong" })).toEqual([400, "GitLab rejected the token"]);
    expect(await problem({ ...valid, agentId: "missing" })).toEqual([404, expect.stringContaining("not found")]);
    gitlab.userStatus = 500;
    expect(await problem(valid)).toEqual([502, "GitLab did not return the token's user"]);
    expect(await service.db.gitlab.list()).toEqual([]);
    expect(service.host.running()).toEqual([]);
  });
});
