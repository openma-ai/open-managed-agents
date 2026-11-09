// @ts-nocheck
// SessionDO's interrupt handling and lane drain, driven through the public API
// and the DO event log, before they move behind Ports.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const post = (path: string, body: any) =>
  exports.default.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: H, body: JSON.stringify(body) }));
const stubOf = (id: string) => env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", id])));
const texts: string[] = [];

beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  registerHarness("hang-until-abort", () => ({
    async run(ctx) {
      const text = ctx.userMessage.content[0]?.text;
      texts.push(text);
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: `started ${text}` }] });
      if (text === "finish") return;
      await new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (ctx.runtime.abortSignal.aborted) fail();
        else ctx.runtime.abortSignal.addEventListener("abort", fail, { once: true });
      });
    },
  }));
  registerHarness("record-order", () => ({
    async run(ctx) { texts.push(ctx.userMessage.content[0]?.text); },
  }));
});

async function createSession(harness: string, extra = {}) {
  const a = await post("/v1/oma/agents", { name: `host-${crypto.randomUUID()}`, model: "claude-sonnet-4-6", _oma: { harness }, ...extra });
  const e = await post("/v1/environments", { name: `env-${crypto.randomUUID()}`, config: { type: "cloud" } });
  const s = await post("/v1/sessions", { agent: ((await a.json()) as any).id, environment_id: ((await e.json()) as any).id });
  const id = ((await s.json()) as any).id as string;
  await runInDurableObject(stubOf(id), (instance: any) => instance._sandboxWarm);
  return id;
}
const events = (id: string): Promise<any[]> => runInDurableObject(stubOf(id), async (_i, state) =>
  new SqliteHistory(state.storage.sql, null).getEvents() as any[]);
async function until(id: string, pred: (e: any[]) => boolean) {
  for (let t = 0; t < 15_000; t += 100) {
    const seen = await events(id);
    if (pred(seen)) return seen;
    await new Promise((r) => setTimeout(r, 100));
  }
  return events(id);
}
const send = (id: string, event: any) => post(`/v1/sessions/${id}/events`, { events: [event] });
const message = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] });
const lifecycle = (seen: any[]) => seen
  .filter((e) => e.type === "user.interrupt" || e.type === "session.status_running" || e.type === "session.status_idle")
  .map((e) => e.type === "session.status_idle" ? `idle:${e.stop_reason?.type}` : e.type);

import { resourcesFixture } from "../../packages/openai-agents-compat/test/helpers/resources";
import { createOpenAIArtifactPublisher } from '../../packages/openai-agents-compat/src/artifact-publication';

it("publishes real immutable File bytes after completed terminal persistence, before execution settlement", async () => {
  const id = await createSession("record-order");
  const files = resourcesFixture().files;
  const observed = { listed: 0, phase: null, before: [], skips: [] };
  await runInDurableObject(stubOf(id), (instance, state) => {
    const binding = instance.env.MAIN_MCP;
    instance.env = { ...instance.env, MAIN_MCP: new Proxy(binding, { get(target, key) {
      if (key !== "publishManagedSessionArtifacts") return Reflect.get(target, key);
      return async opts => {
        const ev = new SqliteHistory(state.storage.sql, null).getEvents();
        observed.before = ev.map(event => event.type);
        
        const rows = ev.map((event, index) => ({ event, executionId: opts.executionFence.executionId, consumedByExecutionId: opts.executionFence.executionId, position: { revision: 1, index } }));
        const log = fields => observed.skips.push(fields.reason);
        await createOpenAIArtifactPublisher({
          environmentType: async () => "openai_hosted",
          historyForWorkspace: () => ({ loadSessionRuntimeHistory: async () => ({ type: "found", initialEvents: [], events: ev, orderedEvents: rows }) }),
          filesForWorkspace: () => files,
          isFenceActive: async fence => (await env.MAIN_DB.prepare("SELECT state FROM managed_session_executions WHERE id=?").bind(fence.executionId).first())?.state === "running",
          environmentId: () => "env",
          logger: { debug: log, info: log, warn: log },
        })({ workspaceId: opts.tenantId, session: { id, createdAt: new Date().toISOString(), agent: { id: "agent" } }, executionFence: opts.executionFence, 
          outputs: { listPaths: async () => { observed.listed++; return ["/workspace/outputs/report.bin"]; }, read: async () => new Uint8Array([0, 1, 127, 255]) } });
        return { type: "published" };
      };
    } }) };
  });
  await send(id, message("make file"));
  const seen = await until(id, e => e.some(x => x.type === "session.status_idle"));
  expect(observed).toMatchObject({ phase: null, listed: 1, skips: [] });
  expect(observed.before).toContain("session.status_idle");
  const result = await files.listFiles({ scopeId: id });
  expect(result.page.files).toHaveLength(1);
  const file = result.page.files[0];
  expect(file).toMatchObject({ sizeBytes: 4, origin: { type: "session_output", sessionId: id, environmentId: "env", path: "/workspace/outputs/report.bin" } });
  expect(file.origin.turnId).toMatch(new RegExp("^turn_" + id + ":root:"));
  expect(await files.downloadFile({ fileId: file.id })).toMatchObject({ file: { content: new Uint8Array([0, 1, 127, 255]) } });
  expect(seen.filter(e => e.type === "session.error")).toEqual([]);
  expect(seen.filter(e => e.type === "session.status_idle").map(e => e.stop_reason.type)).toEqual(["end_turn"]);
}, 30000);


it("reports publication failure independently without changing the completed model turn", async () => {
  const id = await createSession("record-order");
  let attempted = false;
  await runInDurableObject(stubOf(id), instance => {
    const binding = instance.env.MAIN_MCP;
    instance.env = { ...instance.env, MAIN_MCP: new Proxy(binding, { get(target, key) {
      if (key !== "publishManagedSessionArtifacts") return Reflect.get(target, key);
      return async () => { attempted = true; throw new Error("publication-copy-failed"); };
    } }) };
  });
  await send(id, message("publish"));
  for (let n = 0; n < 200; n++) {
    const row = await env.MAIN_DB.prepare("SELECT state FROM managed_session_executions WHERE session_id=?").bind(id).first();
    if (row?.state === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(attempted).toBe(true);
  expect(await env.MAIN_DB.prepare("SELECT state,failure FROM managed_session_executions WHERE session_id=?").bind(id).first()).toEqual({ state: "completed", failure: null });
  const seen = await events(id);
  expect(seen.filter(event => event.type === "session.error")).toEqual([]);
  expect(seen.filter(event => event.type === "session.status_idle").map(event => event.stop_reason.type)).toEqual(["end_turn"]);
}, 30000);
