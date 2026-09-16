import { registerHarness } from "../../apps/agent/src/harness/registry";
import { DefaultHarness } from "../../apps/agent/src/harness/default-loop";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const headers = { Authorization: "Bearer test-key", "OpenAI-Beta": "agents=v1", "Content-Type": "application/json" };
const request = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://localhost/openai/v1${path}`, { ...init, headers: init?.headers ?? headers }));

describe("Cloudflare OpenAI Agents mount", () => {
  it("rejects unauthenticated requests with API JSON instead of Console HTML", async () => {
    const response = await request("/agents", { headers: {} });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: "authentication_error", code: "invalid_api_key" } });
  });
  it("uses the native tenant store for resource CRUD and preserves protocol errors", async () => {
    const created = await request("/agents", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", name: "CF OpenAI integration" }) });
    const agent = await created.json() as { id: string };
    expect(created.status, JSON.stringify(agent)).toBe(200);
    const retrieved = await request(`/agents/${agent.id}`);
    expect(await retrieved.json()).toMatchObject({ id: agent.id, name: "CF OpenAI integration" });
    const listed = await request("/agents");
    expect(await listed.json()).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: agent.id })]) });
    const native = await exports.default.fetch(new Request(`http://localhost/v1/agents/${agent.id}`, { headers: { "x-api-key": "test-key", "anthropic-beta": "managed-agents-2026-04-01" } }));
    expect(await native.json()).toMatchObject({ id: agent.id });
    const missing = await request("/unknown");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "resource_not_found" } });
  });
  it("creates hosted sessions through the native session application", async () => {
    const response = await request("/agents/sessions", { method: "POST", body: JSON.stringify({ agent: { model: "claude-sonnet-4-6" }, environment: { type: "openai_hosted" } }) });
    const session = await response.json() as { id: string };
    expect(response.status, JSON.stringify(session)).toBe(200);
    const retrieved = await request(`/agents/sessions/${session.id}`);
    expect(await retrieved.json()).toMatchObject({ id: session.id, environment: { type: "openai_hosted" } });
  });
  it("runs none sessions through the shared runtime without allocating a Cloudflare sandbox", async () => {
    let turns = 0;
    registerHarness("default", () => ({
      async run(ctx) {
        await expect(ctx.runtime.sandbox.exec("true")).rejects.toThrow("No execution environment");
        ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: `No sandbox reply ${++turns}` }] });
      },
    }));
    try {
      const response = await request("/agents/sessions", { method: "POST", body: JSON.stringify({ agent: { model: "claude-sonnet-4-6" }, environment: { type: "none" }, input: "Hello" }) });
      const session = await response.json() as { id: string };
      expect(response.status, JSON.stringify(session)).toBe(200);
      const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
      await runInDurableObject(stub, async (instance) => {
        const runtime = instance as unknown as {
          getOrCreateSandbox(): Promise<{ exec(command: string): Promise<string>; runtimeHandle?: unknown }>;
          warmUpSandbox(): Promise<void>;
        };
        const sandbox = await runtime.getOrCreateSandbox();
        expect(sandbox.runtimeHandle).toBeUndefined();
        await expect(sandbox.exec("true")).rejects.toThrow("No execution environment");
        await runtime.warmUpSandbox();
      });
      await expect.poll(async () => {
        const response = await request(`/agents/sessions/${session.id}/items`);
        return JSON.stringify(await response.json());
      }, { timeout: 15000 }).toContain("No sandbox reply 1");
      const sent = await request(`/agents/sessions/${session.id}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "Continue" }] }] }] }),
      });
      expect(sent.status).toBe(204);
      await expect.poll(async () => JSON.stringify(await (await request(`/agents/sessions/${session.id}/items`)).json()), { timeout: 15000 }).toContain("No sandbox reply 2");
      expect(turns).toBe(2);
      const history = await (await request(`/agents/sessions/${session.id}/items`)).json() as { data: Array<{ id: string; role?: string }> };
      expect(history.data.filter(item => item.role === "user")).toHaveLength(2);
      expect(new Set(history.data.map(item => item.id)).size).toBe(history.data.length);
    } finally {
      registerHarness("default", () => new DefaultHarness());
    }
  }, 30000);

  it("isolates native resources between authenticated workspaces", async () => {
    const token = `other-${crypto.randomUUID()}`;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join("");
    await env.CONFIG_KV.put(`apikey:${hash}`, JSON.stringify({ tenant_id: "openai-other-workspace", credential: { type: "workspace" } }));
    try {
      const created = await request("/agents", { method: "POST", body: JSON.stringify({ name: "Scoped", model: "claude-sonnet-4-6" }) });
      const agent = await created.json() as { id: string };
      expect(created.status).toBe(200);
      const isolatedHeaders = { ...headers, Authorization: `Bearer ${token}` };
      const foreign = await request(`/agents/${agent.id}`, { headers: isolatedHeaders });
      expect(foreign.status).toBe(404);
      const listed = await request("/agents", { headers: isolatedHeaders });
      expect(JSON.stringify(await listed.json())).not.toContain(agent.id);
    } finally { await env.CONFIG_KV.delete(`apikey:${hash}`); }
  });

});
