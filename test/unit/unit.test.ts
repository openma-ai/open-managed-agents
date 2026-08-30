// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { registerHarness, resolveHarness } from "../../apps/agent/src/harness/registry";

// ============================================================
// 1. Harness registry
// ============================================================
describe("Harness registry", () => {
  it("resolves registered harness by name", () => {
    registerHarness("reg-test", () => ({
      async run() {},
    }));
    const h = resolveHarness("reg-test");
    expect(h).toBeTruthy();
    expect(typeof h.run).toBe("function");
  });

  it("throws for unknown harness", () => {
    expect(() => resolveHarness("nonexistent-harness")).toThrow("Unknown harness");
  });

  it("default harness is registered", async () => {
    // Worker entry (apps/agent/src/index.ts) registers "default" at import
    // time; this unit test doesn't import the entry, so register the same
    // way the worker would.
    const { DefaultHarness } = await import("../../apps/agent/src/harness/default-loop");
    registerHarness("default", () => new DefaultHarness());
    const h = resolveHarness("default");
    expect(h).toBeTruthy();
  });

  it("each call returns a new instance", () => {
    registerHarness("fresh", () => ({ async run() {} }));
    const a = resolveHarness("fresh");
    const b = resolveHarness("fresh");
    expect(a).not.toBe(b); // factory creates new each time
  });
});

// ============================================================
// 2. Tool building — enable/disable logic
// ============================================================
describe("Tool building", () => {
  // Import buildTools to test directly
  // We can't import it directly in pool-workers, but we can test via
  // the harness by checking which tools are available.

  const HEADERS = { "x-api-key": "test-key", "Content-Type": "application/json" };
  function api(path: string, init?: RequestInit) {
    return exports.default.fetch(new Request(`http://localhost${path}`, init));
  }

  async function getToolNames(toolConfig: any[]): Promise<string[]> {
    const harnessName = `tool-check-${Date.now()}-${Math.random()}`;
    const toolNames: string[] = [];

    registerHarness(harnessName, () => ({
      async run(ctx) {
        // The buildTools function is called inside DefaultHarness,
        // but we can inspect the agent config to verify tool config is passed through.
        // For a more direct test, we report the tool config.
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: JSON.stringify(ctx.agent.tools) }],
        });
      },
    }));

    const agentRes = await api("/v1/oma/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Tool Test",
        model: "claude-sonnet-4-6",
        tools: toolConfig,
        harness: harnessName,
      }),
    });
    return ((await agentRes.json()) as any).tools;
  }

  it("default toolset enables all tools", async () => {
    const tools = await getToolNames([{ type: "agent_toolset_20260401" }]);
    expect(tools).toEqual([{ type: "agent_toolset_20260401" }]);
  });

  it("selective config is preserved", async () => {
    const config = [{
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: [
        { name: "bash", enabled: true },
        { name: "read", enabled: true },
      ],
    }];
    const tools = await getToolNames(config);
    const ts = tools[0] as any;
    expect(ts.default_config.enabled).toBe(false);
    expect(ts.configs).toHaveLength(2);
    expect(ts.configs[0].name).toBe("bash");
  });

  it("empty tools array defaults to full toolset", async () => {
    const agentRes = await api("/v1/oma/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "NoTools", model: "claude-sonnet-4-6" }),
    });
    const agent = (await agentRes.json()) as any;
    expect(agent.tools).toEqual([{ type: "agent_toolset_20260401" }]);
  });
});

// ============================================================
// 3. Edge cases — unicode, large messages, special chars
// ============================================================
describe("Edge cases", () => {
  const HEADERS = { "x-api-key": "test-key", "Content-Type": "application/json" };
  function api(path: string, init?: RequestInit) {
    return exports.default.fetch(new Request(`http://localhost${path}`, init));
  }

  async function createSession() {
    registerHarness("noop", () => ({ async run() {} }));
    const agentRes = await api("/v1/oma/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Edge", model: "claude-sonnet-4-6", harness: "noop" }),
    });
    const agent = (await agentRes.json()) as any;
    const envRes = await api("/v1/oma/environments", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "e", config: { type: "cloud" } }),
    });
    const environment = (await envRes.json()) as any;
    const sessRes = await api("/v1/oma/sessions", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ agent: agent.id, environment_id: environment.id }),
    });
    return (await sessRes.json()) as any;
  }

  it("handles unicode in messages", async () => {
    const session = await createSession();
    const text = "你好世界 🌍 こんにちは мир 🚀";
    const res = await api(`/v1/oma/sessions/${session.id}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      }),
    });
    expect(res.status).toBe(202);

    // Verify via WebSocket replay
    await new Promise((r) => setTimeout(r, 100));
    const doId = env.SESSION_DO!.idFromName(session.id);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(new Request("http://internal/ws", { headers: { Upgrade: "websocket", "x-oma-replay": "1", "x-oma-include": "chunks" } }));
    const ws = wsRes.webSocket!;
    ws.accept();
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => {
        events.push(JSON.parse(e.data as string));
      });
      setTimeout(() => { ws.close(); resolve(); }, 50);
    });

    const userMsg = events.find((e) => e.type === "user.message");
    expect(userMsg.content[0].text).toBe(text);
  });

  it("handles large message payload (100KB)", async () => {
    const session = await createSession();
    const bigText = "x".repeat(100_000);
    const res = await api(`/v1/oma/sessions/${session.id}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: bigText }] }],
      }),
    });
    expect(res.status).toBe(202);
  });

  it("handles special characters in agent name and system prompt", async () => {
    const res = await api("/v1/oma/agents", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: 'Agent "with" <special> & chars',
        model: "claude-sonnet-4-6",
        system: "Respond with `code` and 'quotes' and line\nbreaks",
      }),
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;

    const getRes = await api(`/v1/oma/agents/${agent.id}`, { headers: HEADERS });
    const fetched = (await getRes.json()) as any;
    expect(fetched.name).toBe('Agent "with" <special> & chars');
    expect(fetched.system).toContain("\n");
  });

  it("handles empty content array in user message", async () => {
    const session = await createSession();
    const res = await api(`/v1/oma/sessions/${session.id}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [] }],
      }),
    });
    // Should accept — empty content is valid (model will handle it)
    expect(res.status).toBe(202);
  });

  it("agent IDs are unique across creates", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await api("/v1/oma/agents", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ name: `U${i}`, model: "claude-sonnet-4-6" }),
      });
      const agent = (await res.json()) as any;
      ids.add(agent.id);
    }
    expect(ids.size).toBe(5);
  });
});
