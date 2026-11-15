// Characterization (#545 §0.7 回归测试): how SessionDO connects AcpProxyHarness to
// the RuntimeRoom Durable Object, pinned on 94d603e7 before RUNTIME_ROOM leaves
// the shared harness context. Only the DO env binding is faked; the turn runs
// through the public managed API and SessionDO.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { AcpProxyHarness } from "../../packages/agent-harness/src/acp-proxy-loop";
import { ensureModelCards } from "./_model-cards";

try { registerHarness("acp-proxy", () => new AcpProxyHarness()); } catch { /* registered by another file in this isolate */ }

beforeAll(() => ensureModelCards(["claude-sonnet-4-6"]));

class RunnerSocket {
  listeners = new Map<string, Array<(event: unknown) => void>>();
  sent: Array<Record<string, any>> = [];
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)); }
  accept() { this.receive({ type: "attached", daemon_online: true }); }
  receive(frame: unknown) { for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) }); }
  close() { for (const listener of this.listeners.get("close") ?? []) listener({}); }
  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, any>;
    this.sent.push(frame);
    queueMicrotask(() => {
      if (frame.type === "session.start") this.receive({ type: "session.ready", acp_session_id: "native" });
      if (frame.type === "session.prompt") {
        this.receive({ type: "session.event", turn_id: frame.turn_id, event: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from runner" } } } });
        this.receive({ type: "session.complete", turn_id: frame.turn_id });
      }
    });
  }
}

const H = { "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" };
const call = (path: string, body?: unknown) => exports.default.fetch(new Request(`http://localhost${path}`, {
  method: body === undefined ? "GET" : "POST", headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

async function runnerSession(runtimeId: string) {
  const agent = await (await call("/v1/agents", {
    name: "Runner", model: "claude-sonnet-4-6",
    _oma: { harness: "acp-proxy", runtime_binding: { runtime_id: runtimeId, acp_agent_id: "codex-acp" } },
  })).json() as { id: string };
  const environment = await (await call("/v1/environments", { name: `runner-${crypto.randomUUID()}`, config: { type: "cloud" } })).json() as { id: string };
  const created = await call("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  expect(created.status).toBe(201);
  const session = await created.json() as { id: string };
  return { id: session.id, stub: env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id]))) };
}

async function sendAndWaitIdle(sessionId: string) {
  const sent = await call(`/v1/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "hi runner" }] }] });
  expect(sent.status).toBe(200);
  let events: Array<Record<string, any>> = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    events = ((await (await call(`/v1/sessions/${sessionId}/events?limit=200`)).json()) as { data: Array<Record<string, any>> }).data;
    if (events.some((event) => event.type === "session.status_idle")) break;
  }
  return events;
}

describe("characterization: SessionDO -> RuntimeRoom attach for the acp-proxy harness", () => {
  it("attaches by runtime id with the harness role, session and tenant headers, then relays the turn", async () => {
    const runtimeId = `rt_char_${crypto.randomUUID().slice(0, 8)}`;
    const { id, stub } = await runnerSession(runtimeId);
    const sockets: RunnerSocket[] = [];
    const named: string[] = [];
    const attaches: Request[] = [];
    await runInDurableObject(stub, async (instance: any) => {
      instance.env = { ...instance.env, RUNTIME_ROOM: {
        idFromName: (name: string) => { named.push(name); return `id:${name}`; },
        get: (doId: string) => ({ fetch: async (request: Request) => {
          expect(doId).toBe(`id:${runtimeId}`);
          attaches.push(request);
          const socket = new RunnerSocket(); sockets.push(socket);
          return { status: 101, webSocket: socket };
        } }),
      } };
    });
    const events = await sendAndWaitIdle(id);
    expect(named).toEqual([runtimeId]);
    expect(attaches).toHaveLength(1);
    expect(attaches[0]!.url).toBe("http://runtime-room/_attach_harness");
    expect(Object.fromEntries(attaches[0]!.headers)).toEqual({
      upgrade: "websocket", "x-attach-role": "harness", "x-session-id": id, "x-harness-tenant": "default",
    });
    expect(sockets[0]!.sent.map((frame) => frame.type)).toEqual(["session.start", "session.prompt"]);
    expect(sockets[0]!.sent[0]).toEqual({ type: "session.start", agent_id: "codex-acp" });
    expect(String(sockets[0]!.sent[1]!.text)).toContain("hi runner");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.message", content: [{ type: "text", text: "hello from runner" }] }));
    expect(events.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  }, 60_000);

  it("a refused attach (no 101 upgrade) ends the turn with the attach error", async () => {
    const { id, stub } = await runnerSession(`rt_char_${crypto.randomUUID().slice(0, 8)}`);
    await runInDurableObject(stub, async (instance: any) => {
      instance.env = { ...instance.env, RUNTIME_ROOM: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response("no room", { status: 404 }) }),
      } };
    });
    const events = await sendAndWaitIdle(id);
    expect(JSON.stringify(events.filter((event) => event.type === "session.error")))
      .toContain("Failed to attach to RuntimeRoom");
  }, 60_000);

  it("without the RUNTIME_ROOM binding the turn reports the missing binding", async () => {
    const { id, stub } = await runnerSession(`rt_char_${crypto.randomUUID().slice(0, 8)}`);
    await runInDurableObject(stub, async (instance: any) => {
      instance.env = { ...instance.env, RUNTIME_ROOM: undefined };
    });
    const events = await sendAndWaitIdle(id);
    expect(JSON.stringify(events.filter((event) => event.type === "session.error")))
      .toContain("RUNTIME_ROOM binding missing");
  }, 60_000);
});
