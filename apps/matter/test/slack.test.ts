import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

const BOT = "xoxb-test-bot-token";
const SIGNING = "0123456789abcdef0123456789abcdef";
const TEAM = "T123";
const BOT_USER = "U_BOT";

class FakeSlack {
  readonly posts: { path: string; body: unknown; token: string | null }[] = [];
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (url.pathname.endsWith("/auth.test")) {
      if (token !== BOT) return Response.json({ ok: false, error: "invalid_auth" });
      return Response.json({
        ok: true,
        team_id: TEAM,
        team: "Acme",
        user_id: BOT_USER,
        bot_id: "B_BOT",
      });
    }
    if (url.pathname.endsWith("/bots.info")) {
      return Response.json({ ok: true, bot: { app_id: "A123" } });
    }
    if (url.pathname.endsWith("/chat.postMessage") || url.pathname.endsWith("/reactions.add")) {
      this.posts.push({
        path: url.pathname,
        body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
        token,
      });
      return Response.json({ ok: true, ts: `1.${this.posts.length}` });
    }
    if (url.pathname.endsWith("/users.conversations")) {
      return Response.json({
        ok: true,
        channels: [{ id: "C1", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }) as typeof fetch;
}

const signed = (body: string, secret = SIGNING, now = Math.floor(Date.now() / 1000)) => {
  const timestamp = String(now);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { timestamp, signature };
};

const mention = (text: string, options: { channel?: string; user?: string; ts?: string; eventId?: string } = {}) => ({
  type: "event_callback",
  team_id: TEAM,
  event_id: options.eventId ?? `Ev${Math.random().toString(16).slice(2)}`,
  event: {
    type: "app_mention",
    user: options.user ?? "U_HUMAN",
    text: `<@${BOT_USER}> ${text}`,
    ts: options.ts ?? "1710000000.000100",
    channel: options.channel ?? "C1",
    event_ts: options.ts ?? "1710000000.000100",
  },
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

const proxied = {
  "x-matter-proxy-secret": "proxy-secret",
  "x-oma-tenant-id": "default",
  "x-oma-user-id": "usr_1",
};

let dir: string;
let oma: FakeOma;
let slack: FakeSlack;
let services: MatterService[];
let config: MatterConfig;
let baseEnv: Record<string, string>;

const start = async (cfg: MatterConfig = config, omaFetch: typeof fetch = oma.fetch as typeof fetch) => {
  const service = await createMatterService(cfg, {
    omaFetch,
    fetch: slack.fetch,
    onError: () => {},
  });
  services.push(service);
  return service;
};

const connect = (service: MatterService, body: unknown, headers: Record<string, string> = proxied) =>
  service.fetch(
    new Request("https://matter.test/connect/slack", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const webhook = (service: MatterService, path: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signed(body);
  return service.fetch(
    new Request(`https://matter.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    }),
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matter-slack-"));
  oma = new FakeOma();
  oma.agents.set("agent-1", { id: "agent-1", version: 1, mcp_servers: [], tools: [] });
  slack = new FakeSlack();
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

const valid = { botToken: BOT, signingSecret: SIGNING, agentId: "agent-1" };

describe("Slack connections", () => {
  it("connects an installation, answers a signed mention, and lists Bonds without secrets", async () => {
    const service = await start();
    const created = await connect(service, valid);
    expect(created.status).toBe(201);
    const result = (await created.json()) as {
      id: string;
      teamId: string;
      botUserId: string;
      requestUrl: string;
      events: boolean;
    };
    expect(result).toMatchObject({ teamId: TEAM, botUserId: BOT_USER, events: true });
    expect(result.id).toMatch(/^slack-[0-9a-f]{16}$/);
    expect(result.requestUrl).toBe(`https://matter.example.com/webhooks/slack/${result.id}`);
    expect(service.host.running()).toEqual([result.id]);

    oma.responder = (_sessionId, event) =>
      event.type === "user.message"
        ? [
            { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hello from Slack." }] },
            { type: "session.status_idle", stop_reason: { type: "end_turn" } },
          ]
        : undefined;

    expect((await webhook(service, `/webhooks/slack/${result.id}`, mention("hi"))).status).toBe(200);
    await waitFor(() => slack.posts.find((p) => p.path.endsWith("/chat.postMessage")));
    expect([...oma.sessions.values()][0]).toMatchObject({ environment_id: "env_1" });

    const body = JSON.stringify(mention("nope"));
    const bad = await service.fetch(
      new Request(`https://matter.test/webhooks/slack/${result.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=deadbeef",
        },
        body,
      }),
    );
    expect(bad.status).toBe(401);

    const bonds = await service.fetch(new Request("https://matter.test/bonds?provider=slack", { headers: proxied }));
    expect(bonds.status).toBe(200);
    const listed = (await bonds.json()) as { data: { id: string }[] };
    expect(listed.data.map((b) => b.id)).toEqual([`slack:${result.id}`]);
    expect(JSON.stringify(listed)).not.toContain(BOT);
    expect(JSON.stringify(listed)).not.toContain(SIGNING);
  });

  it("refuses another workspace claiming the same installation", async () => {
    const { OMA_API_KEY: _k, OMA_ENVIRONMENT_ID: _e, ...env } = baseEnv;
    oma.trustSecret = "proxy-secret";
    oma.environments = [{ id: "env_ws" }];
    config = loadMatterConfig(env);
    const service = await start();
    expect((await connect(service, valid, { ...proxied, "x-oma-tenant-id": "tn_a" })).status).toBe(201);
    const taken = await connect(service, valid, { ...proxied, "x-oma-tenant-id": "tn_b" });
    expect(taken.status).toBe(409);
  });

  it("answers URL verification and survives a restart with the same Bond", async () => {
    const first = await start();
    const created = await connect(first, valid);
    const result = (await created.json()) as { id: string };
    const challengeBody = JSON.stringify({ type: "url_verification", challenge: "c-123", token: "ignored" });
    const { timestamp, signature } = signed(challengeBody);
    const challenge = await first.fetch(
      new Request(`https://matter.test/webhooks/slack/${result.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body: challengeBody,
      }),
    );
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "c-123" });

    await first.close();
    services.splice(services.indexOf(first), 1);
    const second = await start();
    await second.host.start();
    expect(second.host.running()).toEqual([result.id]);
    oma.responder = (_sessionId, event) =>
      event.type === "user.message"
        ? [
            { type: "agent.message", id: "msg_2", content: [{ type: "text", text: "After restart." }] },
            { type: "session.status_idle", stop_reason: { type: "end_turn" } },
          ]
        : undefined;
    const before = slack.posts.length;
    expect((await webhook(second, `/webhooks/slack/${result.id}`, mention("again", { eventId: "EvRestart" }))).status).toBe(
      200,
    );
    await waitFor(() => (slack.posts.length > before ? slack.posts[slack.posts.length - 1] : undefined));
  }, 20_000);

  it("requires bot token and at least one ingress credential", async () => {
    const service = await start();
    expect((await connect(service, { botToken: BOT })).status).toBe(400);
    expect((await connect(service, { signingSecret: SIGNING })).status).toBe(400);
    expect((await connect(service, { botToken: "not-a-bot", signingSecret: SIGNING })).status).toBe(400);
  });
});
