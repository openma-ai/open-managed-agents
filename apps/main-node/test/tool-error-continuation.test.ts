import { createServer } from "node:http";
// Real Node HTTP/SQLite and local sandbox filesystem failure. Only model
// responses are controlled; no sandbox/tool operation is replaced.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiHarness, registerHarness, type HarnessContext } from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";


it.each(["read", "mcp"])("delivers a %s failure by call ID and continues to normal idle", async (operation) => {
  const dir = mkdtempSync(join(tmpdir(), "oma-tool-error-"));
  let mcpCalls = 0; const methods: string[] = [];
  const rpc = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    methods.push(message.method);
    const failedJob = () => {
      mcpCalls++;
      try { readFileSync(join(dir, "missing-mcp-job-input")); throw new Error("expected missing job input"); }
      catch (error) { return { isError: true, content: [{ type: "text", text: (error as Error).message }] }; }
    };
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "failed-job", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "fail", description: "return a failed execution", inputSchema: { type: "object", properties: {} } }] }
      : message.method === "tools/call" ? failedJob() : {};
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  let seen = ""; let afterAction = "";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(operation === "read" ? "read" : "mcp__jobs__fail", operation === "read" ? { file_path: join(dir, "absent-file.txt") } : {}, { id: "failed-read" })], { stopReason: "toolUse" }),
    context => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage([fauxToolCall("write", {
        file_path: "/continued-action.txt", content: "successful action after error",
      }, { id: "successful-after-error" })], { stopReason: "toolUse" });
    },
    context => { afterAction = JSON.stringify(context.messages); return fauxAssistantMessage("continued after tool error"); },
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const harnessId = "tool-error-" + Math.random().toString(36).slice(2);
  registerHarness(harnessId, () => ({ async run(ctx: HarnessContext) {
    await new PiHarness().run({ ...ctx, pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" } });
  } }));
  const config = loadNodeConfig({ NODE_ENV: "test", AUTH_DISABLED: "1", PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", MEMORY_QUEUE: "disabled", DATABASE_PATH: join(dir, "oma.db"), AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"), MEMORY_BLOB_DIR: join(dir, "memories"), FILES_BLOB_DIR: join(dir, "files"), SESSION_OUTPUTS_DIR: join(dir, "outputs") });
  const cp = await createNodeControlPlane(await nodeDefaults(config)); await cp.start();
  const db = new Database(join(dir, "oma.db"), { readonly: true });
  const server = serve({ fetch: r => cp.fetch(r), hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const ok = async (path: string, body?: unknown) => { const r = await call(path, body); expect(r.status, JSON.stringify(r.body)).toBeLessThan(300); return r.body; };
  const live = () => (db.prepare("SELECT COUNT(*) c FROM managed_session_executions WHERE state IN ('queued','running')").get() as { c: number }).c;
  try {
    await ok("/v1/oma/model_cards", { provider: "ant", model_id: "tool-error-local-model", api_key: "test", base_url: "http://unused.invalid" });
    const agent = await ok("/v1/agents", { name: "dup", model: "tool-error-local-model", system: "t", _oma: { harness: harnessId },
      ...(operation === "mcp" ? { mcp_servers: [{ name: "jobs", type: "url", url: `http://127.0.0.1:${(rpc.address() as any).port}/mcp` }] } : {}),
      tools: [{ type: "agent_toolset_20260401" }, ...(operation === "mcp" ? [{ type: "mcp_toolset", mcp_server_name: "jobs" }] : []), { type: "custom", name: "approve_ticket", description: "a", input_schema: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] } }] });
    const env = await ok("/v1/environments", { name: "dup", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const session = await ok("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: env.id });
    const path = `/v1/sessions/${session.id}/events`;
    const history = async () => (await ok(path + "?limit=1000&order=asc")).data as any[];
    await ok(path, { events: [{ type: "user.message", content: [{ type: "text", text: "Read a missing file and continue" }] }] });
    await expect.poll(async () => live() === 0 && (await history()).some(e => e.type === "session.status_idle" && e.stop_reason?.type === "end_turn"), { timeout: 15_000 }).toBe(true);
    const events = await history();
    const results = events.filter(e => (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") && (e.tool_use_id ?? e.mcp_tool_use_id) === "failed-read");
    expect(results).toHaveLength(1); expect(results[0].is_error).toBe(true);
    expect(seen).toContain("failed-read");
    expect(faux.state.callCount).toBe(3);
    const success = events.filter(e => e.type === "agent.tool_result" && e.tool_use_id === "successful-after-error");
    expect(success).toHaveLength(1); expect(success[0].is_error).not.toBe(true);
    expect(readFileSync(join(dir, "sandboxes", session.id, "continued-action.txt"), "utf8")).toBe("successful action after error");
    expect(afterAction).toContain("successful-after-error");
    expect(events.indexOf(results[0])).toBeLessThan(events.indexOf(success[0]));
    expect(events.slice(0, events.indexOf(success[0])).some(e => e.type === "session.status_idle" || e.type === "session.status_terminated")).toBe(false);
    if (operation === "mcp") { console.log(JSON.stringify({ op: "mcp_failure_gate", methods, mcpCalls })); expect(mcpCalls).toBe(1); }
    expect(events.filter(e => e.type === "session.status_idle").map(e => e.stop_reason.type)).toEqual(["end_turn"]);
    expect(events.some(e => e.type === "agent.message" && JSON.stringify(e).includes("continued after tool error"))).toBe(true);
    expect(db.prepare("SELECT state,attempt_count FROM managed_session_executions WHERE session_id=?").all(session.id)).toEqual([expect.objectContaining({ state: "completed", attempt_count: 1 })]);
    expect(events.findIndex(e => e === results[0])).toBeLessThan(events.findIndex(e => e.type === "session.status_idle"));
  } finally {
    await new Promise<void>(r => server.close(() => r())); db.close(); await cp.stop("test"); rpc.closeAllConnections(); await new Promise<void>(r => rpc.close(() => r())); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
