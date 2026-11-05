import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import contract from "./fixtures/kimi-kha/openapi-subset.json";
import { createKhaFixture } from "./helpers/kimi-kha-fixture.js";
import { mountKimiKhaCompat, projectKhaEvent } from "../../../packages/control-plane-node/src/kimi-kha/index.js";

function conforms(name: keyof typeof contract.components.schemas, value: unknown) {
  // Empty unevaluatedProperties schemas impose no constraint; Zod does not support that keyword.
  const schema = z.fromJSONSchema(JSON.parse(JSON.stringify({ $ref: `#/$defs/${name}`, $defs: contract.components.schemas }, (key, value) => key === "unevaluatedProperties" && JSON.stringify(value) === "{}" ? undefined : value).replaceAll("#/components/schemas/", "#/$defs/")));
  const parsed = schema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
}
const headers = { authorization: "Bearer dummy", "kimi-api-version": "2026-09-01-beta", "content-type": "application/json" };
function client(fixture = createKhaFixture()) {
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => fixture.app.request(`/kha/v1${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function seed() {
    const env = await (await request("/environments", { name: "KHA spike", config: { type: "cloud" } })).json();
    const response = await request("/sessions", { agent_id: fixture.agentId, environment_id: env.id });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()).id as string;
  }
  return { ...fixture, request, seed };
}
const message = { events: [{ type: "user.message", data: { content: [{ type: "text", text: "hello" }] } }] };
async function frameReader(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  return {
    cancel: () => reader.cancel(),
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!frame.includes("data:")) continue;
          const fields = Object.fromEntries(frame.split("\n").map((line) => { const i = line.indexOf(":"); return [line.slice(0, i), line.slice(i + 1).trimStart()]; }));
          return { id: fields.id, event: fields.event, data: JSON.parse(fields.data) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE ended early");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

describe("Kimi KHA P0 compatibility through native OMA routes", () => {
  it("matches captured OpenAPI schemas for REST requests, responses and artifact bytes", async () => {
    const f = client();
    const agents = await (await f.request("/agents")).json();
    conforms("AgentList", agents); expect(agents.items[0].version).toBe("1");
    const input = { name: "KHA env", config: { type: "cloud", packages: { pip: ["example-package"] } } };
    conforms("CreateEnvironmentRequest", input);
    const envResponse = await f.request("/environments", input);
    expect(envResponse.status, await envResponse.clone().text()).toBe(201);
    const env = await envResponse.json(); conforms("Environment", env);
    conforms("EnvironmentList", await (await f.request("/environments")).json());
    conforms("Environment", await (await f.request(`/environments/${env.id}`)).json());
    const create = { agent_id: agents.items[0].id, agent_version: "3", environment_id: env.id, title: "CLI shape" };
    conforms("CreateSessionRequest", create);
    const session = await (await f.request("/sessions", create)).json(); conforms("Session", session);
    expect(session.agent.version).toBe("3");
    conforms("Session", await (await f.request(`/sessions/${session.id}`)).json());
    conforms("SessionList", await (await f.request("/sessions")).json());
    conforms("SendEventsRequest", message);
    const accepted = await (await f.request(`/sessions/${session.id}/events`, message)).json(); conforms("SendEventsResponse", accepted);
    expect(accepted.event_id).toMatch(/^sevt_/);
    const history = await (await f.request(`/sessions/${session.id}/events`)).json(); conforms("SessionEventList", history);
    expect(history.items.map((event: any) => event.type)).toEqual(["user.message", "session.status", "agent.message", "session.status"]);
    const artifacts = await (await f.request(`/artifacts?session_id=${session.id}`)).json(); conforms("ArtifactList", artifacts);
    conforms("Artifact", await (await f.request(`/artifacts/${artifacts.items[0].id}`)).json());
    const download = await f.request(`/artifacts/${artifacts.items[0].id}/content`);
    expect(download.headers.get("content-type")).toBe("text/plain");
    expect(await download.text()).toBe("Deterministic fixture artifact\n");
    expect(f.calls.find((call) => call.path.endsWith("/events") && call.body)?.body).toEqual({ events: [{ type: "user.message", content: message.events[0].data.content }] });
  });

  it("is opt-in and preserves native shapes, beta gating and bearer authorization", async () => {
    const disabled = createKhaFixture(false);
    mountKimiKhaCompat(disabled.app, false, (req) => disabled.app.fetch(req));
    expect((await disabled.app.request("/kha/v1/agents", { headers })).status).toBe(404);
    const f = createKhaFixture(false);
    mountKimiKhaCompat(f.app, true, (req) => f.app.fetch(req));
    expect((await f.app.request("/kha/v1/agents", { headers })).status).toBe(200);
    expect((await f.app.request("/v1/agents", { headers })).status).toBe(400);
    const native = await f.app.request("/v1/agents", { headers: { ...headers, "anthropic-beta": "managed-agents-2026-04-01" } });
    expect((await native.json()).data[0].version).toBe(1);
    for (const auth of ["", "Bearer invalid"]) {
      const result = await f.app.request("/kha/v1/agents", { headers: { authorization: auth } });
      expect(result.status).toBe(401);
      const body = await result.json(); conforms("ErrorObject", body.error);
      expect(body.error.request_id).toBe(result.headers.get("msh-request-id"));
    }
    expect((await f.app.request("/kha/v1/agents", { headers: { ...headers, "kimi-api-version": "future" } })).status).toBe(200);
  });

  it("resumes exclusively by cursor or Last-Event-ID across adapter instances", async () => {
    const f = client(), id = await f.seed();
    await f.request(`/sessions/${id}/events`, message);
    const first = await frameReader(await f.request(`/sessions/${id}/events/stream`));
    const a = await first.next(), b = await first.next(); await first.cancel();
    expect(a.id).not.toBe(a.data.id); expect(b.data.type).toBe("session.status");
    const secondApp = new Hono();
    mountKimiKhaCompat(secondApp, true, (req) => f.app.fetch(req));
    const resumed = await frameReader(await secondApp.request(`/kha/v1/sessions/${id}/events/stream`, { headers: { ...headers, "Last-Event-ID": b.id } }));
    expect((await resumed.next()).data.type).toBe("agent.message"); await resumed.cancel();
    const precedence = await frameReader(await f.request(`/sessions/${id}/events/stream?cursor=${a.id}`, undefined, { "Last-Event-ID": "invalid" }));
    expect((await precedence.next()).data.id).toBe(b.data.id); await precedence.cancel();
    const other = await f.seed();
    for (const path of [`/sessions/${id}/events/stream?cursor=invalid`, `/sessions/${other}/events/stream?cursor=${a.id}`]) {
      const bad = await f.request(path); expect(bad.status).toBe(400); expect((await bad.json()).error.type).toBe("invalid_parameter_error");
    }
    f.events.get(id)!.splice(0, 1);
    expect((await f.request(`/sessions/${id}/events/stream?cursor=${a.id}`)).status).toBe(400);
  });

  it("paginates history and exposes a matching stream_cursor", async () => {
    const f = client(), id = await f.seed(); await f.request(`/sessions/${id}/events`, message);
    const page = await (await f.request(`/sessions/${id}/events?page_size=2`)).json();
    conforms("SessionEventList", page); expect(page.items).toHaveLength(2);
    const next = await (await f.request(`/sessions/${id}/events?page_token=${page.next_page_token}`)).json();
    expect(next.items).toHaveLength(2); expect(next.next_page_token).toBeUndefined();
    const stream = await frameReader(await f.request(`/sessions/${id}/events/stream?cursor=${page.stream_cursor}`));
    expect((await stream.next()).data.id).toBe(next.items[0].id); await stream.cancel();
  });

  it("flushes empty SSE before input over localhost HTTP, then delivers a complete turn", async () => {
    const f = client();
    const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}/kha/v1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const agents = await (await fetch(`${base}/agents`, { headers })).json();
      conforms("AgentList", agents);
      const envResponse = await fetch(`${base}/environments`, { method: "POST", headers,
        body: JSON.stringify({ name: "HTTP e2e", config: { type: "cloud" } }) });
      expect(envResponse.status).toBe(201);
      const env = await envResponse.json(); conforms("Environment", env);
      const sessionResponse = await fetch(`${base}/sessions`, { method: "POST", headers,
        body: JSON.stringify({ agent_id: agents.items[0].id, environment_id: env.id }) });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json(); conforms("Session", session);
      const id = session.id;
      const response = await fetch(`${base}/sessions/${id}/events/stream?cursor=now&include_deltas=true`, { headers, signal: controller.signal });
      expect(response.headers.get("x-accel-buffering")).toBe("no"); expect(response.headers.get("cache-control")).toBe("no-cache");
      const stream = await frameReader(response);
      expect(await stream.next()).toMatchObject({ event: "control", id: "0", data: { cursor: "0", reason: "tail" } });
      const send = await fetch(`${base}/sessions/${id}/events`, { method: "POST", headers, body: JSON.stringify(message) });
      expect(send.status).toBe(200);
      const frames = [];
      for (let i = 0; i < 4; i++) frames.push(await stream.next());
      frames.forEach((frame) => conforms("SessionEventList", { items: [frame.data] }));
      expect(frames.at(-1)?.data.data).toEqual({ status: "idle", stop_reason: { type: "end_turn" } });
      await stream.cancel();
      const artifacts = await (await fetch(`${base}/artifacts?session_id=${id}`, { headers })).json();
      conforms("ArtifactList", artifacts);
      const download = await fetch(`${base}/artifacts/${artifacts.items[0].id}/content`, { headers });
      expect(await download.text()).toBe("Deterministic fixture artifact\n");
    } finally { clearTimeout(timeout); controller.abort(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("walks native history pages and terminates an unavailable stream with one JSON error", async () => {
    const f = client(), id = await f.seed();
    await f.request(`/sessions/${id}/events`, message);
    const template = f.events.get(id)![0];
    for (let i = 0; i < 105; i++) f.events.get(id)!.push({ ...template, id: `sevt_extra_${i}` });
    const stream = await frameReader(await f.request(`/sessions/${id}/events/stream?cursor=now`));
    const control = await stream.next();
    expect(control.event).toBe("control"); expect(control.id).not.toBe("0");
    // Removing the session makes the next native read fail after headers were sent.
    f.sessions.delete(id);
    const error = await stream.next();
    expect(error.event).toBe("error"); conforms("ErrorObject", error.data.error);
    expect(error.data.error.type).toBe("resource_not_found_error");
    await expect(stream.next()).rejects.toThrow("SSE ended early");
    await stream.cancel();
  });

  it("tails native keyset pages with bounded overlap and no repeated history scan", async () => {
    const f = client(), id = await f.seed();
    await f.request(`/sessions/${id}/events`, message);
    const template = f.events.get(id)![0];
    for (let i = 0; i < 350; i++) f.events.get(id)!.push({ ...template, id: `sevt_history_${i}` });
    const stream = await frameReader(await f.request(`/sessions/${id}/events/stream?cursor=now`));
    await stream.next();
    const reads = () => f.calls.filter((call) => call.path.endsWith("/events") && !call.body);
    const initial = reads().length;
    expect(initial).toBe(4);
    await vi.waitFor(() => expect(reads().length).toBeGreaterThan(initial + 1));
    // Idle connections revisit only the final page, not pages 0, 100 or 200.
    expect(reads().slice(initial).every((call) => new URLSearchParams(call.query).get("page") === "300")).toBe(true);
    const before = reads().length;
    // A burst crossing several pages must be drained without loss or repeats.
    for (let i = 0; i < 240; i++) f.events.get(id)!.push({ ...template, id: `sevt_live_${i}` });
    for (let i = 0; i < 240; i++) expect((await stream.next()).data.id).toBe(`sevt_live_${i}`);
    expect(reads().slice(before).some((call) => new URLSearchParams(call.query).get("page") === "500")).toBe(true);
    await stream.cancel();
    const stopped = reads().length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reads()).toHaveLength(stopped);
  });

  it("projects coarse thinking/error/stop states without inventing unsupported wire variants", () => {
    const base = { id: "event", processed_at: "2026-11-05T00:00:00.000Z" };
    for (const event of [
      { ...base, type: "agent.thinking" },
      { ...base, type: "session.error", error: { message: "fixture failure" } },
      { ...base, type: "session.status_rescheduled" },
      { ...base, type: "session.status_idle", stop_reason: { type: "exhausted" } },
    ]) conforms("SessionEventList", { items: [projectKhaEvent(event)] });
    expect(projectKhaEvent({ ...base, type: "span.model_request_start" })).toBeNull();
  });

  it("enforces tenant isolation, missing resources, malformed and unsupported inputs", async () => {
    const f = client(), id = await f.seed(); await f.request(`/sessions/${id}/events`, message);
    const artifact = (await (await f.request(`/artifacts?session_id=${id}`)).json()).items[0];
    for (const path of [`/sessions/${id}`, `/sessions/${id}/events/stream`, `/artifacts?session_id=${id}`, `/artifacts/${artifact.id}/content`]) {
      expect((await f.request(path, undefined, { authorization: "Bearer other" })).status).toBe(404);
    }
    for (const [path, body] of [
      ["/environments", { name: "missing config" }],
      ["/environments", { name: "setup", config: { type: "cloud", setup_script: "echo unsupported" } }],
      ["/sessions", { agent_id: f.agentId, environment_id: "env_1", resources: [] }],
      [`/sessions/${id}/events`, { events: [{ type: "user.interrupt", data: {} }] }],
      [`/sessions/${id}/events`, { events: [...message.events, ...message.events] }],
    ] as const) expect((await f.request(path, body)).status).toBe(400);
    for (const path of ["/agents?page_size=0", "/agents?official_only=true", "/artifacts", `/artifacts/${artifact.id}?version=2`, `/sessions/${id}/events/stream?include_deltas=invalid`]) {
      expect((await f.request(path)).status).toBe(400);
    }
    expect((await f.request("/sessions", { agent_id: "missing", environment_id: "env_1" })).status).toBe(404);
    expect((await f.app.request(`/kha/v1/sessions/${id}/events`, { method: "POST", headers, body: "{" })).status).toBe(400);
  });
});
