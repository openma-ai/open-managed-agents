import { createScriptedMcpServer } from "../../../test/fakes/scripted-mcp-server";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { earlyCustomModel } from "../../../packages/agent-harness/test/early-custom-model";
import { PiHarness, registerHarness, type HarnessContext } from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

it.each([{ ordinary: "bash", earlyAll: false, steering: false }, { ordinary: "mcp", earlyAll: false, steering: false }, { ordinary: "bash", earlyAll: true, steering: false }, { ordinary: "bash", earlyAll: false, steering: true }])("$ordinary earlyAll=$earlyAll steering=$steering: accepts an early custom answer over HTTP/SSE while bash is blocked, reconnects and resumes a durable park after restart without replay", async ({ ordinary, earlyAll, steering }) => {
  const dir = mkdtempSync(join(tmpdir(), "oma-early-custom-"));
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let completed = false;
  const model = earlyCustomModel(ordinary === "mcp" ? "mcp__docs__lookup" : "bash");
  const { faux, models } = model;
  const phases: Array<Record<string, unknown>> = [];
  const recordPhase = (phase: string) => phases.push({ phase, at: new Date().toISOString(), samples: faux.state.callCount, ordinaryEntered: entered, ordinaryCompleted: completed });
  const effect = async () => {
    appendFileSync(join(dir, "effects"), `${ordinary}\n`); entered = true;
    await latch; completed = true; return "ordinary completed";
  };
  const mcp = createScriptedMcpServer({ requireSession: false,
    tools: [{ name: "lookup", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
    callTool: async () => ({ content: [{ type: "text", text: await effect() }] }),
  });
  const upstream = serve({ fetch: request => mcp.fetch(request), hostname: "127.0.0.1", port: 0 });
  if (!upstream.listening) await new Promise<void>(resolve => upstream.once("listening", resolve));
  const upstreamAddress = upstream.address(); if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No MCP port");
  const mcpUrl = `http://127.0.0.1:${upstreamAddress.port}/mcp`;
  const harnessHistories: unknown[] = [];
  const harnessId = `early-custom-${Date.now()}`;
  registerHarness(harnessId, () => ({ async run(ctx: HarnessContext) {
    harnessHistories.push(structuredClone(ctx.runtime.history.getEvents()));
    await new PiHarness().run({ ...ctx,
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      tools: ordinary === "bash" ? { ...ctx.tools, bash: { ...ctx.tools.bash!, execute: effect } } : ctx.tools,
    });
  } }));
  const config = loadNodeConfig({ NODE_ENV: "test", AUTH_DISABLED: "1",
    PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"), AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"), MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"), SESSION_OUTPUTS_DIR: join(dir, "outputs"),
  });
  let cp: NodeControlPlane = await createNodeControlPlane(await nodeDefaults(config));
  await cp.start();
  const inspection = new Database(join(dir, "oma.db"), { readonly: true });
  const server = serve({ fetch: request => cp.fetch(request), hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No HTTP port");
  const base = `http://127.0.0.1:${address.port}`;
  const controllers: AbortController[] = [];
  const readers: Promise<void>[] = [];
  const streamEvents: any[] = [];
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); expect(response.ok, JSON.stringify(value)).toBe(true); return value as any;
  };
  const openStream = async (id: string) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${base}/v1/sessions/${id}/events/stream`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    readers.push((async () => {
      let buffer = ""; const decoder = new TextDecoder();
      try { while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (data) streamEvents.push(JSON.parse(data));
        }
      } } catch (error) { if (!controller.signal.aborted) throw error; }
    })());
    return controller;
  };
  try {
    await request("/v1/oma/model_cards", { provider: "ant", model_id: "early-test-model", api_key: "test", base_url: "http://unused.invalid" });
    const agent = await request("/v1/agents", { name: "early", model: "early-test-model", system: "test",
      _oma: { harness: harnessId },
      ...(ordinary === "mcp" ? { mcp_servers: [{ name: "docs", type: "url", url: mcpUrl }] } : {}),
      tools: [{ type: "agent_toolset_20260401" }, ...(ordinary === "mcp" ? [{ type: "mcp_toolset", mcp_server_name: "docs" }] : []), { type: "custom", name: "approve", description: "answer",
        input_schema: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] } }] });
    const environment = await request("/v1/environments", { name: "early", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const session = await request("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environment.id });
    const eventsPath = `/v1/sessions/${session.id}/events`;
    const history = async () => (await request(eventsPath)).data as any[];
    const stream = await openStream(session.id); // MUST precede input.
    await request(eventsPath, { events: [{ type: "user.message", content: [{ type: "text", text: "mixed" }] }] });
    await expect.poll(() => streamEvents.filter(e => e.type === "agent.custom_tool_use").length).toBe(2);
    await expect.poll(() => entered).toBe(true);
    expect(completed).toBe(false);
    expect((await request(`/v1/sessions/${session.id}`)).status).toBe("running");
    const answer = (id: string) => request(eventsPath, { events: [{ type: "user.custom_tool_result", custom_tool_use_id: id, content: [{ type: "text", text: `answer:${id}` }] }] });
    if (steering) await request(eventsPath, { events: [{ type: "user.message", content: [{ type: "text", text: "queued steering must wait for custom barriers" }] }] });
    recordPhase("canonical calls received while ordinary blocked");
    const early = await answer("early-first");
    expect(early.data[0].processed_at).toBeTruthy();
    await answer("early-first");
    expect((await history()).filter(e => e.type === "user.custom_tool_result")).toHaveLength(2);
    if (earlyAll) await answer("early-last");
    expect(faux.state.callCount).toBe(1); expect(completed).toBe(false);
    recordPhase("early answers accepted; ordinary still blocked");
    stream.abort(); await openStream(session.id);
    const rebuilt = new Map((await history()).map(e => [e.id, e]));
    for (const event of streamEvents) if (event.id) rebuilt.set(event.id, event);
    expect([...rebuilt.values()].filter(e => e.type === "agent.custom_tool_use")).toHaveLength(2);
    recordPhase("reconnected before releasing ordinary");
    release();
    if (!earlyAll) {
    await expect.poll(async () => (await history()).some(e => e.type === "session.status_idle" && e.stop_reason?.type === "requires_action")).toBe(true);
    expect(faux.state.callCount).toBe(1);
    expect((await history()).filter(e => (e.type === "agent.tool_result" && e.tool_use_id === "ordinary") || (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === "ordinary"))).toHaveLength(1);
    for (const controller of controllers) controller.abort(); await Promise.all(readers);
    recordPhase("ordinary persisted and parked before control-plane restart");
    await cp.stop("durable-restart");
    cp = await createNodeControlPlane(await nodeDefaults(config)); await cp.start();
    await openStream(session.id); await history();
    recordPhase("recreated control plane from durable SQLite");
    await answer("early-last");
    }
    await expect.poll(async () => (await history()).some(e => e.type === "agent.message" && JSON.stringify(e).includes("done after both answers")), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await request(`/v1/sessions/${session.id}`)).status).toBe("idle");
    await answer("early-first"); await answer("early-last");
    // Accepted custom receipts have processed_at immediately, so public idle
    // alone cannot prove their queued continuations finished. Read the real
    // execution store before asserting that late duplicates never sampled.
    await expect.poll(() => (inspection.prepare("SELECT COUNT(*) AS count FROM managed_session_executions WHERE state IN ('queued', 'running')").get() as { count: number }).count).toBe(0);
    recordPhase("final idle; duplicate late replies accepted");
    if (process.env.PR545_LOCAL_EVIDENCE_DIR) {
      mkdirSync(process.env.PR545_LOCAL_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.PR545_LOCAL_EVIDENCE_DIR, `early-${ordinary}-${earlyAll}-${steering}.json`), JSON.stringify({
        ordinary, earlyAll, steering, phases, assertionCalls: expect.getState().assertionCalls,
        effects: readFileSync(join(dir, "effects"), "utf8"), mcpCalls: mcp.state.counts["tools/call"] ?? 0,
        history: await history(), modelHistory: model.history(), harnessHistories,
        restart: earlyAll ? "none" : "new control-plane object; same SQLite; same OS process",
      }, null, 2));
    }
    expect(faux.state.callCount).toBe(2);
    expect(readFileSync(join(dir, "effects"), "utf8")).toBe(`${ordinary}\n`);
    if (ordinary === "mcp") expect(mcp.state.counts["tools/call"]).toBe(1);
    expect(JSON.stringify(model.history())).toContain("answer:early-first");
    expect(JSON.stringify(model.history())).toContain("answer:early-last");
    expect(JSON.stringify(model.history())).toContain("ordinary completed");
    if (steering) expect(JSON.stringify(model.history())).toContain("queued steering must wait for custom barriers");
    expect((await history()).some(e => e.type === "session.status_idle" && e.stop_reason?.type === "requires_action")).toBe(true);

  } finally {
    release(); for (const controller of controllers) controller.abort();
    await Promise.all(readers); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    inspection.close();
    await cp.stop("test"); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
