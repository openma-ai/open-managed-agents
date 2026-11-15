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

  it("is opt-in and preserves native shapes and bearer authorization", async () => {
    const disabled = createKhaFixture(false);
    mountKimiKhaCompat(disabled.app, false, (req) => disabled.app.fetch(req));
    expect((await disabled.app.request("/kha/v1/agents", { headers })).status).toBe(404);
    const f = createKhaFixture(false);
    mountKimiKhaCompat(f.app, true, (req) => f.app.fetch(req));
    expect((await f.app.request("/kha/v1/agents", { headers })).status).toBe(200);
    expect((await f.app.request("/v1/agents", { headers })).status).toBe(200);
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
      expect(send.status).toBe(202);
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

  it("forwards interrupt, reports unsupported message-free continue, and accepts a new turn", async () => {
    const f = client(), id = await f.seed();
    const interrupt = { type: "steer", events: [{ type: "user.interrupt", data: {} }] };
    conforms("SendEventsRequest", interrupt);
    f.sessions.get(id)!.status = "running";
    const stopped = await f.request(`/sessions/${id}/events`, interrupt);
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({}); // No fabricated epoch or queued event ID.
    expect(f.calls.at(-1)?.body).toEqual({ events: [{ type: "user.interrupt" }] });
    expect((await (await f.request(`/sessions/${id}`)).json()).status).toBe("idle");
    const idleInterrupt = await f.request(`/sessions/${id}/events`, { events: [{ type: "user.interrupt" }] });
    expect(idleInterrupt.status).toBe(400);
    expect((await idleInterrupt.json()).error.type).toBe("failed_precondition_error");
    const before = f.events.get(id)!.length;
    const continued = await f.app.request(`/kha/v1/sessions/${id}/continue`, { method: "POST", headers });
    expect(continued.status).toBe(501);
    expect((await continued.json()).error.message).toContain("message-free continue");
    const fenced = await f.request(`/sessions/${id}/events`, {
      events: [{ type: "user.interrupt", data: { expected_control_epoch: "1" } }],
    });
    expect(fenced.status).toBe(501);
    expect(f.events.get(id)).toHaveLength(before);
    expect((await f.request(`/sessions/${id}/events`, { events: [...interrupt.events, ...message.events] })).status).toBe(400);
    expect((await f.request(`/sessions/${id}/events`, message)).status).toBe(202);
    expect(f.events.get(id)!.at(-1)).toMatchObject({ type: "session.status_idle", stopReason: { type: "end_turn" } });
    for (const [authorization, status] of [["Bearer invalid", 401], ["Bearer other", 404]] as const) {
      expect((await f.request(`/sessions/${id}/events`, interrupt, { authorization })).status).toBe(status);
      expect((await f.app.request(`/kha/v1/sessions/${id}/continue`, { method: "POST", headers: { ...headers, authorization } })).status).toBe(status);
    }
    expect((await f.app.request("/kha/v1/sessions/missing/continue", { method: "POST", headers })).status).toBe(404);
    f.sessions.get(id)!.status = "terminated";
    expect((await f.app.request(`/kha/v1/sessions/${id}/continue`, { method: "POST", headers })).status).toBe(409);
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
    const tailPage = new URLSearchParams(reads().at(-1)!.query).get("page");
    expect(tailPage).toBeTruthy();
    await vi.waitFor(() => expect(reads().length).toBeGreaterThan(initial + 1));
    // Idle connections revisit only the final page, not pages 0, 100 or 200.
    expect(reads().slice(initial).every((call) => new URLSearchParams(call.query).get("page") === tailPage)).toBe(true);
    const before = reads().length;
    // Retention before the native keyset boundary must not shift its offset.
    f.events.get(id)!.splice(0, 100);
    // A burst crossing several pages must be drained without loss or repeats.
    for (let i = 0; i < 240; i++) f.events.get(id)!.push({ ...template, id: `sevt_live_${i}` });
    for (let i = 0; i < 240; i++) expect((await stream.next()).data.id).toBe(`sevt_live_${i}`);
    expect(reads().slice(before).some((call) => new URLSearchParams(call.query).get("page") !== tailPage)).toBe(true);
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
    expect(projectKhaEvent({ ...base, type: "span.model_request_end" })).toBeNull();
  });

  it("projects tool, model-start and child-thread events without inventing success", async () => {
    const f = client(), id = await f.seed();
    const base = { processedAt: "2026-11-05T00:00:00.000Z", sessionThreadId: "sthr_child" };
    const content = [{ type: "text" as const, text: "tool failed" }];
    f.events.get(id)!.push(
      { ...base, id: "use", type: "agent.tool_use", name: "bash", input: { command: "false" }, evaluatedPermission: "ask" },
      { ...base, id: "result", type: "agent.tool_result", toolUseId: "use", content, isError: true },
      { ...base, id: "created", type: "session.thread_created", agentName: "Researcher" },
      { ...base, id: "running", type: "session.thread_status_running", agentName: "Researcher" },
      { ...base, id: "idle", type: "session.thread_status_idle", agentName: "Researcher", stopReason: { type: "requires_action", eventIds: ["use"] } },
      { ...base, id: "model", type: "span.model_request_start" },
      { ...base, id: "mcp", type: "agent.mcp_tool_use", mcpServerName: "search", name: "find", input: {}, evaluatedPermission: "allow" },
      { ...base, id: "mcp_result", type: "agent.mcp_tool_result", mcpToolUseId: "mcp", content: [], isError: false },
      { ...base, id: "custom", type: "agent.custom_tool_use", name: "approval", input: {} },
      { ...base, id: "sent", type: "agent.thread_message_sent", content, toSessionThreadId: "sthr_primary" },
      { ...base, id: "received", type: "agent.thread_message_received", content, fromSessionThreadId: "sthr_primary" },
      { ...base, id: "unknown", type: "agent.tool_use", name: "bash", input: {} },
      { ...base, id: "denied", type: "agent.tool_use", name: "bash", input: {}, evaluatedPermission: "deny" },
      { ...base, id: "unknown_result", type: "agent.tool_result", toolUseId: "unknown", content },
    );
    const history = await (await f.request(`/sessions/${id}/threads/sthr_child/events`)).json();
    conforms("SessionEventList", history);
    expect(history.items).toHaveLength(11);
    expect(history.items[0]).toMatchObject({ type: "agent.tool_use", session_thread_id: "sthr_child", data: { tool_use: { id: "use" }, evaluated_permission: "always_ask" } });
    expect(history.items[1].data.tool_result).toEqual({ tool_use_id: "use", content, structured_content: content, is_error: true });
    expect(history.items[4]).toMatchObject({ type: "session.thread_status", session_thread_id: "sthr_child", data: { status: "idle", stop_reason: { type: "requires_action", event_ids: ["use"] } } });
    expect(history.items[5].type).toBe("agent.model_started");
    expect(history.items[6].data.mcp).toEqual({ server_name: "search" });
    expect(history.items[7].data.tool_result.is_error).toBe(false);
    const stream = await frameReader(await f.request(`/sessions/${id}/threads/sthr_child/events/stream`));
    for (const event of history.items) expect((await stream.next()).data).toEqual(event);
    await stream.cancel();
    const wire = { id: "omit", processed_at: base.processedAt };
    for (const event of [
      { type: "span.model_request_end" }, { type: "span.outcome_evaluation_end" }, { type: "workflow_run.status_ended" },
      { type: "agent.tool_result", tool_use_id: "use", is_error: false, content: [{ type: "document" }] },
    ]) expect(projectKhaEvent({ ...wire, ...event })).toBeNull();
    conforms("SessionEventList", { items: [projectKhaEvent({ ...wire, type: "user.interrupt" }), projectKhaEvent({ ...wire, type: "agent.thread_context_compacted" })] });
  });

  it("sorts and filters before paging across native pages", async () => {
    const f = client();
    const template = f.agents.get(f.agentId)!;
    for (let i = 0; i < 105; i++) f.agents.set(`agent_${i}`, { ...structuredClone(template),
      id: `agent_${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      multiagent: i < 102 ? { type: "multiagent_20261001", advisor: { type: "disabled" },
        subagents: { type: "disabled" }, workflows: { type: "disabled" } } : null });
    const first = await (await f.request("/agents?order=created_at_desc&exclude_multiagent=true&page_size=2")).json();
    expect(first.items.map((r: any) => r.id)).toEqual(["agent_104", "agent_103"]);
    const second = await (await f.request(`/agents?order=created_at_desc&exclude_multiagent=true&page_size=2&page_token=${first.next_page_token}`)).json();
    expect(second.items.map((r: any) => r.id)).toEqual(["agent_102", f.agentId]);
    expect(second.next_page_token).toBeUndefined();
    expect((await (await f.request("/agents?order=created_at&exclude_multiagent=false&page_size=1")).json()).items[0].id).toBe(f.agentId);
    expect((await f.request(`/agents?order=created_at&page_token=${first.next_page_token}`)).status).toBe(400);
    expect(f.calls.filter((c) => c.path === "/v1/agents" && c.query.includes("page=")).length).toBeGreaterThan(0);

    const idle = await f.seed(), running = await f.seed(), rescheduling = await f.seed();
    f.sessions.get(running)!.status = "running";
    f.sessions.get(rescheduling)!.status = "rescheduling";
    const filtered = await (await f.request("/sessions?statuses=running,idle")).json();
    expect(filtered.items).toHaveLength(3);
    expect(filtered.items.find((r: any) => r.id === rescheduling).status).toBe("running");
    expect((await (await f.request("/sessions?status=idle")).json()).items.map((r: any) => r.id)).toEqual([idle]);
    expect((await (await f.request("/sessions?statuses=stopping")).json()).items).toEqual([]);
    expect((await (await f.request("/sessions?statuses=running&statuses=terminated")).json()).items).toHaveLength(2);
    for (const path of ["/agents?order=bad", "/agents?exclude_multiagent=1", "/environments?include_archived=1", "/sessions?statuses=bad"]) {
      expect((await f.request(path)).status).toBe(400);
    }
  });

  it("projects stable readiness and includes archived environments only on request", async () => {
    const f = client();
    for (const type of ["cloud", "self_hosted"]) {
      const created = await (await f.request("/environments", { name: type, config: { type } })).json();
      conforms("Environment", created); expect(created.build_status).toBe("ready");
      const get = await (await f.request(`/environments/${created.id}`)).json();
      expect(get).toEqual(created);
    }
    f.environments.get("env_1")!.archivedAt = "2026-11-05T00:00:00.000Z";
    expect((await (await f.request("/environments")).json()).items.map((r: any) => r.id)).toEqual(["env_2"]);
    const all = await (await f.request("/environments?include_archived=true&page_size=1")).json();
    expect(all.items).toHaveLength(1); expect(all.next_page_token).toBeDefined();
    const next = await (await f.request(`/environments?include_archived=true&page_token=${all.next_page_token}`)).json();
    expect(next.items).toHaveLength(1);
    expect([...all.items, ...next.items].find((r: any) => r.id === "env_1").archived_at).toBeDefined();
    expect(f.calls.some((c) => c.query.includes("include_archived=true"))).toBe(true);
  });

  it("paginates descending events and resumes SSE after the newest returned event", async () => {
    const f = client(), id = await f.seed(); await f.request(`/sessions/${id}/events`, message);
    const asc = await (await f.request(`/sessions/${id}/events`)).json();
    const first = await (await f.request(`/sessions/${id}/events?order=desc&page_size=2`)).json();
    const second = await (await f.request(`/sessions/${id}/events?order=desc&page_size=2&page_token=${first.next_page_token}`)).json();
    expect([...first.items, ...second.items]).toEqual([...asc.items].reverse());
    expect(second.next_page_token).toBeUndefined();
    expect(first.stream_cursor).toBe(asc.stream_cursor);
    expect((await f.request(`/sessions/${id}/events?order=asc&page_token=${first.next_page_token}`)).status).toBe(400);
    await f.request(`/sessions/${id}/events`, message);
    const stream = await frameReader(await f.request(`/sessions/${id}/events/stream?cursor=${first.stream_cursor}`));
    expect((await stream.next()).data.type).toBe("user.message"); await stream.cancel();
  });

  it("projects coordinator and observed children, scopes thread REST/SSE and authorizes pending", async () => {
    const f = client(), id = await f.seed();
    const root = `/sessions/${id}`;
    const initial = await (await f.request(`${root}/threads`)).json();
    conforms("SessionThreadList", initial);
    expect(initial.items).toHaveLength(1); expect(initial.items[0].id).toBe("sthr_primary");
    expect(initial.items[0]).not.toHaveProperty("control_epoch");
    expect(initial.items[0]).not.toHaveProperty("interrupted");
    await f.request(`${root}/events`, message);
    const base = { sessionThreadId: "sthr_child", processedAt: "2026-11-05T00:00:00.000Z", agentName: "Researcher" };
    f.events.get(id)!.push(
      { ...base, id: "child_created", type: "session.thread_created", parentThreadId: "sthr_primary" },
      { ...base, id: "child_running", type: "session.thread_status_rescheduled" },
      { ...base, id: "child_message", type: "agent.message", content: [{ type: "text", text: "child only" }] },
    );
    const page = await (await f.request(`${root}/threads?page_size=1`)).json();
    const children = await (await f.request(`${root}/threads?page_token=${page.next_page_token}`)).json();
    conforms("SessionThreadList", children);
    expect(children.items).toHaveLength(1);
    const child = await (await f.request(`${root}/threads/sthr_child`)).json();
    conforms("SessionThread", child);
    expect(child).toMatchObject({ id: "sthr_child", parent_thread_id: "sthr_primary", status: "running" });
    expect(child.agent).toBeUndefined();
    const childEvents = await (await f.request(`${root}/threads/sthr_child/events?order=desc&page_size=2`)).json();
    expect(childEvents.items.map((r: any) => r.id)).toEqual(["child_message", "child_running"]);
    const older = await (await f.request(`${root}/threads/sthr_child/events?order=desc&page_token=${childEvents.next_page_token}`)).json();
    expect(older.items.map((r: any) => r.id)).toEqual(["child_created"]);
    const primary = await (await f.request(`${root}/threads/sthr_primary/events`)).json();
    expect(primary.items).toHaveLength(4);
    const coordinator = await (await f.request(`${root}/events`)).json();
    expect(coordinator.items).toEqual(primary.items);
    const coordinatorStream = await frameReader(await f.request(`${root}/events/stream`));
    for (const event of primary.items) expect((await coordinatorStream.next()).data).toEqual(event);
    f.events.get(id)!.push({ ...base, id: "child_extra", type: "agent.message", content: [{ type: "text", text: "must not appear" }] });
    await f.request(`${root}/events`, message);
    expect((await coordinatorStream.next()).data.type).toBe("user.message");
    await coordinatorStream.cancel();
    const stream = await frameReader(await f.request(`${root}/threads/sthr_child/events/stream?cursor=${childEvents.stream_cursor}`));
    f.events.get(id)!.push({ ...base, id: "child_idle", type: "session.thread_status_idle", stopReason: { type: "end_turn" } });
    await f.request(`${root}/events`, message); // Unrelated primary events must not leak.
    expect((await stream.next()).data.id).toBe("child_extra");
    expect((await stream.next()).data.id).toBe("child_idle"); await stream.cancel();
    expect((await (await f.request(`${root}/threads/sthr_child`)).json()).status).toBe("idle");
    expect((await f.request(`${root}/threads/sthr_primary/events/stream?cursor=${childEvents.stream_cursor}`)).status).toBe(400);
    const pending = await f.request(`${root}/events/pending`);
    expect(pending.status).toBe(501);
    expect((await pending.json()).error.message).toContain("not implemented");
    for (const suffix of ["/threads", "/threads/sthr_child", "/threads/sthr_child/events", "/threads/sthr_child/events/stream", "/events/pending"]) {
      expect((await f.request(`${root}${suffix}`, undefined, { authorization: "Bearer other" })).status).toBe(404);
      expect((await f.request(`${root}${suffix}`, undefined, { authorization: "Bearer invalid" })).status).toBe(401);
      expect((await f.request(`/sessions/missing${suffix}`)).status).toBe(404);
    }
    for (const suffix of ["", "/events", "/events/stream"]) expect((await f.request(`${root}/threads/sthr_missing${suffix}`)).status).toBe(404);
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
      [`/sessions/${id}/events`, { events: [{ type: "user.interrupt", data: { unknown: true } }] }],
      [`/sessions/${id}/events`, { events: [...message.events, ...message.events] }],
    ] as const) expect((await f.request(path, body)).status).toBe(400);
    for (const path of ["/agents?page_size=0", "/agents?official_only=true", "/artifacts", `/artifacts/${artifact.id}?version=2`, `/sessions/${id}/events/stream?include_deltas=invalid`]) {
      expect((await f.request(path)).status).toBe(400);
    }
    expect((await f.request("/sessions", { agent_id: "missing", environment_id: "env_1" })).status).toBe(404);
    expect((await f.app.request(`/kha/v1/sessions/${id}/events`, { method: "POST", headers, body: "{" })).status).toBe(400);
  });
});
