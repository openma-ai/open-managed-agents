import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { buildOpenAIAgentsProtocolApi } from "@open-managed-agents/openai-agents-api";
import { SessionEventsApplicationService } from "@open-managed-agents/managed-agents-application";
import { createSessionsHandler, type SessionSemanticDependencies } from "../src/sessions";
import { normalizeAgentConfig } from "../src/resources";

/** Real native input acceptance with storage and mapping boundary doubles. */
function fixture() {
  const native: any = { id: "session", agent: { id: "agent" }, createdAt: new Date(100000).toISOString(), updatedAt: new Date(101000).toISOString(), metadata: {}, outcomeEvaluations: [] };
  const records = new Map<string, any>([[native.id, native]]);
  const facts: any[] = [];
  const dispatched: any[] = [];
  let revision = 1, sequence = 0;
  let barrier: { remaining: number; ready: Promise<void>; release(): void } | null = null;
  const service = new SessionEventsApplicationService({
    workspaceId: "workspace", clock: { now: () => new Date(102000 + sequence++) },
    ids: { nextEventId: () => `accepted-${sequence++}`, nextOutcomeId: () => `outcome-${sequence++}` },
    sessions: { find: async () => native },
    execution: { find: async () => ({ session: native, environment: {} as any, revision }) },
    stream: { subscribe: () => (async function* () {})() },
    store: {
      list: async (input: any) => facts.filter(event => !input.eventIds || input.eventIds.includes(event.id)).slice(0, input.limit),
      append: async (input: any) => {
        if (input.expectedRevision !== revision) return { type: "revision_conflict", actualRevision: revision };
        revision++;
        for (const replacement of input.replaceEvents ?? []) { const index = facts.findIndex(event => event.id === replacement.id); if (index >= 0) facts[index] = structuredClone(replacement); }
        facts.push(...structuredClone(input.events));
        Object.assign(native, input.nextSession);
        return { type: "appended", events: input.events, session: input.nextSession };
      },
    },
    dispatch: { sessionEventsAccepted: async input => { dispatched.push(input); } },
  });
  const deps: SessionSemanticDependencies = {
    workspaceId: "workspace", sessionEvents: service,
    sessions: {
      createSession: async () => ({ type: "created", session: native }),
      retrieveSession: async ({ sessionId }) => records.has(sessionId) ? { type: "found", session: records.get(sessionId) } : { type: "not_found" },
      updateSession: async () => ({ type: "updated", session: native }),
      listSessions: async () => ({ type: "page", page: { sessions: [...records.values()], nextCursor: null, previousCursor: null } }),
      deleteSession: async ({ sessionId }) => ({ type: "deleted", sessionId }),
      archiveSession: async () => ({ type: "not_found" }),
    },
    history: { loadSessionRuntimeHistory: async ({ sessionId }) => {
      if (sessionId === "legacy") return { type: "found", initialEvents: [], events: [{ id: "legacy-message", type: "user.message", content: [{ type: "text", text: "old" }] }] };
      const result: any = { type: "found", revision, initialEvents: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }], events: structuredClone(facts), orderedEvents: facts.map((event, index) => ({ event: structuredClone(event), position: { revision: 1, index } })) };
      const pending = barrier;
      if (pending) { if (--pending.remaining === 0) { barrier = null; pending.release(); } await pending.ready; }
      return result;
    } },
    mapping: {
      prepareCreate: async () => ({ agent: { type: "latest", agentId: "agent" }, environmentId: "environment" }),
      sessionView: async session => {
        const { metadata: _metadata, ...agent } = normalizeAgentConfig({ model: "test" });
        return { id: session.id, object: "agent.session", created_at: 100, last_active_at: 101, agent: { ...agent, id: "agent" }, environment: { type: "none" }, status: "idle", error: null, metadata: {}, required_actions: [], usage: null, vault_ids: [] } as any;
      },
      prepareMetadata: async () => ({}),
    },
  };
  const app = buildOpenAIAgentsProtocolApi(createSessionsHandler(deps));
  const client = new OpenAI({ apiKey: "local", baseURL: "http://localhost/v1", maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { client, facts, dispatched, records, native, deps, service,
    synchronizeNextHistories(count: number) { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); barrier = { remaining: count, ready, release }; },
    async pendingResult() {
      facts.push({ id: "call", type: "agent.custom_tool_use", name: "lookup", input: {} }, { id: "wait", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: ["call"] } });
      const session = await client.beta.agents.sessions.retrieve("session");
      const action = session.required_actions[0]!;
      if (action.type !== "function_call") throw new Error("Expected pending function");
      return { type: "agent.session.input.tool_result" as const, call_id: action.call_id, turn_id: action.turn_id, success: true, output: "result" };
    },
  };
}


const message = (text: string) => ({ type: "agent.session.input.message" as const, input: [{ role: "user" as const, content: [{ type: "input_text" as const, text }] }] });
const texts = (facts: any[]) => facts.filter(row => row.type === "user.message");
it("persists original-key input at stage without execution dispatch and retries after settlement once", async () => {
  const f = fixture(), result = await f.pendingResult();
  const input = { events: [message("ONE")], "Idempotency-Key": "original" };
  await f.client.beta.agents.sessions.events.create("session", input);
  expect(texts(f.facts)).toHaveLength(1);
  expect(texts(f.facts)[0].processedAt).toBeNull();
  expect(f.dispatched).toHaveLength(0);
  await f.client.beta.agents.sessions.events.create("session", { events: [result] });
  await f.client.beta.agents.sessions.events.create("session", input);
  expect(texts(f.facts)).toHaveLength(1);
});
it("invalid cancel batch leaves accepted deferred input unchanged", async () => {
  const f = fixture(), result = await f.pendingResult();
  await f.client.beta.agents.sessions.events.create("session", { events: [message("KEEP")] });
  expect(texts(f.facts)).toHaveLength(1);
  const before = structuredClone(f.facts);
  await expect(f.client.beta.agents.sessions.events.create("session", { events: [{ type: "agent.session.input.cancel" }, result] })).rejects.toMatchObject({ status: 400 });
  expect(f.facts).toEqual(before);
});
it("stale stage races settlement through revision CAS instead of stranding 202", async () => {
  const f = fixture(), result = await f.pendingResult();
  const append = (f.service as any).dependencies.store.append;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  let first = true;
  (f.service as any).dependencies.store.append = async (input: any) => {
    if (first && input.events.some((row: any) => row.type === "user.message")) { first = false; entered(); await gate; }
    return append(input);
  };
  const staging = f.client.beta.agents.sessions.events.create("session", { events: [message("RACE")] });
  // The correct path reaches native admission rather than a side-store CAS.
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("stage bypassed canonical append")), 1000))]);
  await f.client.beta.agents.sessions.events.create("session", { events: [result] });
  release();
  await expect(staging).rejects.toMatchObject({ status: 409 });
  expect(texts(f.facts)).toHaveLength(0);
});

it("result commit and released steer are one durable admission even if dispatch crashes", async () => {
  const f = fixture(), result = await f.pendingResult();
  await f.client.beta.agents.sessions.events.create("session", { events: [message("RECOVER")], "Idempotency-Key": "stage" });
  const dispatch = (f.service as any).dependencies.dispatch.sessionEventsAccepted;
  (f.service as any).dependencies.dispatch.sessionEventsAccepted = async () => { throw new Error("crash after transaction"); };
  await expect(f.client.beta.agents.sessions.events.create("session", { events: [result], "Idempotency-Key": "settle" })).rejects.toMatchObject({ status: 500 });
  expect(texts(f.facts)).toHaveLength(1);
  expect(texts(f.facts)[0]).not.toHaveProperty("deferredUntilToolResults");
  expect(texts(f.facts)[0].processedAt).toBeNull();
  (f.service as any).dependencies.dispatch.sessionEventsAccepted = dispatch;
  await f.client.beta.agents.sessions.events.create("session", { events: [result], "Idempotency-Key": "settle" });
  expect(texts(f.facts)).toHaveLength(1);
});
it("accepted cancel invalidates only deferred inputs and no later flush can revive them", async () => {
  const f = fixture(); await f.pendingResult();
  await f.client.beta.agents.sessions.events.create("session", { events: [message("CANCELLED")], "Idempotency-Key": "stage" });
  await f.client.beta.agents.sessions.events.create("session", { events: [{ type: "agent.session.input.cancel" }] });
  const staged = texts(f.facts)[0];
  expect(staged.cancelled_at_ms).toBeTypeOf("number");
  expect(staged.processedAt).toBeNull();
  const count = f.facts.length;
  await f.client.beta.agents.sessions.events.create("session", { events: [message("CANCELLED")], "Idempotency-Key": "stage" });
  expect(f.facts).toHaveLength(count);
  const publicItems = (await f.client.beta.agents.sessions.items.list("session")).data;
  expect(JSON.stringify(publicItems)).not.toContain("CANCELLED");
});

it("cancel wins against a paused result admission without resurrecting its deferred input", async () => {
  const f = fixture(), result = await f.pendingResult();
  await f.client.beta.agents.sessions.events.create("session", { events: [message("NEVER_REVIVE")], "Idempotency-Key": "stage" });
  const append = (f.service as any).dependencies.store.append;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  let first = true;
  (f.service as any).dependencies.store.append = async (input: any) => {
    if (first && input.events.some((row: any) => row.type === "user.custom_tool_result")) { first = false; entered(); await gate; }
    return append(input);
  };
  const settling = f.client.beta.agents.sessions.events.create("session", { events: [result] });
  await ready;
  await f.client.beta.agents.sessions.events.create("session", { events: [{ type: "agent.session.input.cancel" }] });
  release();
  await expect(settling).rejects.toMatchObject({ status: 409 });
  expect(texts(f.facts)[0].cancelled_at_ms).toBeTypeOf("number");
  expect(f.facts.some(row => row.type === "user.custom_tool_result")).toBe(false);
  expect(f.dispatched.flatMap(batch => batch.events).some((row: any) => row.type === "user.message")).toBe(false);
});

it("a staged input releases only when every bound call is answered", async () => {
  const f = fixture();
  await f.pendingResult();
  f.facts.splice(0, f.facts.length,
    { id: "call", type: "agent.custom_tool_use", name: "lookup", input: {} },
    { id: "call2", type: "agent.custom_tool_use", name: "lookup", input: {} },
    { id: "wait", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: ["call", "call2"] } });
  const actions = (await f.client.beta.agents.sessions.retrieve("session")).required_actions.filter(action => action.type === "function_call");
  const results = actions.map(action => ({ type: "agent.session.input.tool_result" as const, call_id: action.call_id, turn_id: action.turn_id, success: true, output: "answer" }));
  await f.client.beta.agents.sessions.events.create("session", { events: [message("AFTER_BOTH")] });
  await f.client.beta.agents.sessions.events.create("session", { events: [results[0]!] });
  expect(texts(f.facts)[0].deferredUntilToolResults).toEqual(["call", "call2"]);
  expect(f.dispatched.flatMap(batch => batch.events).some((row: any) => row.type === "user.message")).toBe(false);
  await f.client.beta.agents.sessions.events.create("session", { events: [results[1]!] });
  expect(texts(f.facts)[0]).not.toHaveProperty("deferredUntilToolResults");
  expect(texts(f.facts)[0].processedAt).toBeNull();
  expect(f.dispatched.flatMap(batch => batch.events).filter((row: any) => row.type === "user.message")).toHaveLength(1);
});

it("CMA admission still rejects messages during required action without the OAI opt-in", async () => {
  const f = fixture(); await f.pendingResult();
  const before = structuredClone(f.facts);
  const accepted = await f.service.sendSessionEvents({ sessionId: "session", events: [{ type: "user.message", content: [{ type: "text", text: "CMA" }] }] });
  expect(accepted.type).toBe("invalid_request");
  expect(f.facts).toEqual(before);
  expect(f.dispatched).toEqual([]);
});
