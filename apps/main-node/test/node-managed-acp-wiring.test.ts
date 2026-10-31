import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { getRequestListener } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { createEgressCertificateAuthority, loadOrCreateEgressCa } from "../../../packages/sandbox-egress/src/ca";
import { NodeSessionExecutionWorker } from "../../../packages/control-plane-node/src/lib/node-session-execution-worker";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";

// Real Node control plane + SQL execution worker + sandbox spawner. Both ACP and
// upstream model/MCP are deliberately fake; this is NOT live Claude certification.
const fakeAgent = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
let servers; let mode = 'new';
const native = process.env.CLAUDE_CONFIG_DIR + '/projects/transcript.json';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const msg = JSON.parse(line); const reply = result => send({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } } });
  if (msg.method === 'session/new') { servers = msg.params.mcpServers; return reply({ sessionId: 'fake-acp' }); }
  if (msg.method === 'session/resume') { servers = msg.params.mcpServers; mode = 'resumed:' + fs.readFileSync(native, 'utf8'); return reply({}); }
  if (msg.method === 'session/prompt') {
    try {
      fs.appendFileSync('prompts.jsonl', JSON.stringify(msg.params.prompt) + '\n');
      fs.writeFileSync('launch.json', JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY, maxcompute: process.env.MAXCOMPUTE_TOKEN, model: process.env.ANTHROPIC_MODEL, pid: process.pid, mode, servers, prompt: msg.params.prompt }));
      const model = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.ANTHROPIC_AUTH_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, messages: [] }) });
      const mcp = await fetch(servers[0].url, { method: 'POST', headers: { ...Object.fromEntries(servers[0].headers.map(h => [h.name, h.value])), 'x-oma-tenant': 'other', 'x-oma-session': 'other', 'x-oma-agent-id': 'other', 'x-oma-agent-version': '999' }, body: '{}' });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-acp', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fake-result:' + model.status + ':' + mcp.status } } } });
      fs.mkdirSync(require('node:path').dirname(native), { recursive: true });
      fs.writeFileSync(native, 'prior-turn');
      reply({ stopReason: 'end_turn' });
    } catch (e) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); }
  }
});
`;

async function listen(server: ReturnType<typeof createServer>, protocol = "http") {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `${protocol}://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("Node managed ACP wiring (fake ACP/model, real spawner)", () => {
  it.each(["root", "v1", "missing-card", "unsupported-protocol", "queued-inputs", "recovered-queued-inputs"] as const)("enforces scoped model/MCP wiring and native resume: %s", async variant => {
    const root = await mkdtemp(join(tmpdir(), "oma-managed-acp-"));
    const controlCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(root, "control-ca")));
    const upstreamRequests: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
    let releaseFirstModel!: () => void;
    const firstModelGate = new Promise<void>(resolve => { releaseFirstModel = resolve; });
    let sawFirstModel!: () => void;
    const firstModelSeen = new Promise<void>(resolve => { sawFirstModel = resolve; });
    const upstream = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      upstreamRequests.push({ path: req.url!, headers: req.headers, body });
      if (variant === "recovered-queued-inputs" && req.url === "/v1/messages" && upstreamRequests.length === 1) {
        sawFirstModel();
        await firstModelGate;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
    });
    const upstreamUrl = await listen(upstream);
    let cp: Awaited<ReturnType<typeof createNodeControlPlane>> | undefined;
    const gateway = createHttpsServer(await controlCA.leafFor("127.0.0.1"));
    const base = await listen(gateway, "https");
    // Observe the real worker, without replacing execution or SQL behavior.
    // status_idle precedes coordinator settlement, so it is not a drain signal.
    let worker: NodeSessionExecutionWorker | undefined;
    const poll = NodeSessionExecutionWorker.prototype.poll;
    const polling = vi.spyOn(NodeSessionExecutionWorker.prototype, "poll").mockImplementation(function () {
      worker = this;
      return poll.call(this);
    });
    const sandbox = new LocalSubprocessSandbox({ workdir: join(root, "workspace"), outputsRoot: join(root, "outputs") });
    await sandbox.setEnvVars({ ANTHROPIC_API_KEY: "inherited-test-provider-key" });
    let releaseSandbox!: () => void;
    const sandboxReady = new Promise<void>(resolve => { releaseSandbox = resolve; });
    if (variant !== "queued-inputs") releaseSandbox();
    try {
      cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
        NODE_ENV: "test", AUTH_DISABLED: "0", API_KEY: "test-admin", PLATFORM_ROOT_SECRET: "test-root-secret-not-production",
        PUBLIC_BASE_URL: base, MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent",
        DATABASE_PATH: join(root, "db.sqlite"), AUTH_DATABASE_PATH: join(root, "auth.sqlite"),
        SANDBOX_WORKDIR: join(root, "sandboxes"), MEMORY_BLOB_DIR: join(root, "memories"), FILES_BLOB_DIR: join(root, "files"), SESSION_OUTPUTS_DIR: join(root, "outputs"),
        ANTHROPIC_API_KEY: "platform-key-must-not-be-used",
      }), { sandbox: async () => { await sandboxReady; return sandbox; } }));
      gateway.on("request", getRequestListener(cp.fetch));
      const request = async (path: string, body?: unknown) => {
        const response = await cp!.fetch(new Request(base + path, { method: body === undefined ? "GET" : "POST", headers: { "x-api-key": "test-admin", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        const data = await response.json() as any;
        expect(response.status, JSON.stringify(data)).toBeLessThan(300); return data;
      };
      if (variant !== "missing-card") await request("/v1/oma/model_cards", { model_id: "workspace-model", model: "claude-sonnet-5-5", provider: variant === "unsupported-protocol" ? "openai" : "anthropic", base_url: upstreamUrl + (variant === "v1" ? "/v1" : ""), api_key: "workspace-model-secret" });
      const vault = await request("/v1/vaults", { display_name: "MCP secrets" });
      await request(`/v1/vaults/${vault.id}/credentials`, { display_name: "MaxCompute", auth: { type: "static_bearer", mcp_server_url: upstreamUrl + "/mcp", token: "maxcompute-server-secret" } });
      await request(`/v1/vaults/${vault.id}/credentials`, { display_name: "Forbidden raw env", auth: { type: "environment_variable", secret_name: "MAXCOMPUTE_TOKEN", secret_value: "raw-vault-test-secret", networking: { type: "unrestricted" } } });
      const env = await request("/v1/environments", { name: "sandbox", config: { type: "cloud", networking: { type: "unrestricted" } } });
      const agent = await request("/v1/agents", { name: "Claude sandbox", model: "workspace-model", system: "Pinned instructions", tools: [{ type: "mcp_toolset", mcp_server_name: "maxcompute" }], mcp_servers: [{ name: "maxcompute", type: "url", url: upstreamUrl + "/mcp" }], _oma: { harness: "acp-sandbox", acp: { agent: { id: "claude-acp", command: process.execPath, env: { NODE_EXTRA_CA_CERTS: join(root, "control-ca", "ca.crt") }, args: ["-e", variant === "recovered-queued-inputs" ? fakeAgent.replace("fs.mkdirSync(require('node:path').dirname(native), { recursive: true });", "").replace("fs.writeFileSync(native, 'prior-turn');", "// Deliberately lose native state but retain the ACP checkpoint.") : fakeAgent], cwd: "/workspace" } } } });
      const session = await request("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: env.id, vault_ids: [vault.id] });
      // Credential creation may probe MCP; measure only execution traffic.
      upstreamRequests.length = 0;
      if (variant === "recovered-queued-inputs") {
        await cp.start();
        // The old turn intentionally has the same text as A. Identity, not
        // text, determines whether it belongs in recovered conversation.
        await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "execution-A" }] }] });
        await firstModelSeen;
        // Queue both executions while the previous turn is still running:
        // its reply will be persisted AFTER A/B, so slicing history at A is wrong.
        await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "execution-A" }] }, { type: "user.message", content: [{ type: "text", text: "A-followup" }] }] });
        await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "execution-B" }] }] });
        releaseFirstModel();
        let recoveredEvents: any[] = [];
        for (let i = 0; i < 200; i++) {
          recoveredEvents = (await request(`/v1/sessions/${session.id}/events?limit=1000`)).data;
          if (recoveredEvents.filter(event => event.type === "session.status_idle").length === 3) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(recoveredEvents.filter(event => event.type === "session.status_idle")).toHaveLength(3);
        expect(recoveredEvents.filter(event => event.type === "session.error")).toEqual([]);
        const prompts = (await readFile(join(root, "workspace", "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).map((block: { text: string }) => block.text).join(""));
        expect(prompts).toHaveLength(3);
        expect(prompts[1]).toContain("native-state-missing");
        expect(prompts[1]).not.toContain("execution-B");
        const [history, current] = prompts[1].split("Current request:\n");
        expect(history.match(/User: execution-A/g)).toHaveLength(1);
        expect(history).not.toContain("A-followup");
        expect(history).toContain("Assistant: fake-result:200:200");
        expect(current).toBe("execution-A\nA-followup\n</openma-recovery>");
        expect(prompts[2].split("Current request:\n")[1]).toBe("execution-B\n</openma-recovery>");
        return;
      }
      if (variant === "queued-inputs") {
        // Persist A and B before the real SQL worker claims either execution.
        await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "execution-A" }] }, { type: "user.message", content: [{ type: "text", text: "A-followup" }] }] });
        await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "execution-B" }] }] });
        releaseSandbox();
        await cp.start();
        let queuedEvents: any[] = [];
        for (let i = 0; i < 200; i++) {
          queuedEvents = (await request(`/v1/sessions/${session.id}/events`)).data;
          if (queuedEvents.filter(event => event.type === "session.status_idle").length === 2) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(queuedEvents.filter(event => event.type === "session.error")).toEqual([]);
        const prompts = (await readFile(join(root, "workspace", "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).map((block: { text: string }) => block.text).join(""));
        expect(prompts).toEqual(["execution-A\nA-followup", "execution-B"]);
        return;
      }
      await cp.start();
      await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "Use the configured model and MaxCompute" }] }] });
      let events: any[] = [];
      for (let i = 0; i < 100; i++) {
        events = (await request(`/v1/sessions/${session.id}/events`)).data;
        if (events.some(event => event.type === "session.status_idle" || (variant === "missing-card" && event.type === "session.error"))) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (variant === "missing-card" || variant === "unsupported-protocol") {
        expect(JSON.stringify(events)).toMatch(variant === "missing-card" ? /active workspace model card/ : /requires \[anthropic-messages\]/);
        expect(events.some(event => event.type === "session.error")).toBe(true);
        expect(upstreamRequests).toEqual([]);
        await expect(readFile(join(root, "workspace", "launch.json"), "utf8")).rejects.toThrow();
        return;
      }
      expect(JSON.stringify(events)).toContain("fake-result:200:200");
      expect(events.filter(event => event.type === "session.error")).toEqual([]);
      const launch = JSON.parse(await readFile(join(root, "workspace", "launch.json"), "utf8"));
      expect(launch.base).toBe(`${base}/v1/oma/inference-proxy/${session.id}/anthropic`);
      expect(launch.token).toMatch(/^sk-ant-req-v1\./);
      expect(launch.key).toBeUndefined(); expect(launch.maxcompute).toBeUndefined();
      expect(launch.model).toBe("workspace-model");
      expect(launch.servers[0].url).toBe(`${base}/v1/oma/mcp-proxy/${session.id}/maxcompute`);
      expect(JSON.stringify(launch)).not.toContain("workspace-model-secret");
      expect(JSON.stringify(launch)).not.toContain("maxcompute-server-secret");
      expect(JSON.stringify(launch.prompt)).toContain("Use the configured model");
      expect(upstreamRequests).toHaveLength(2);
      expect(upstreamRequests[0].path).toBe("/v1/messages");
      expect(JSON.parse(upstreamRequests[0].body).model).toBe("claude-sonnet-5-5");
      expect(upstreamRequests[0].headers["x-api-key"]).toBe("workspace-model-secret");
      expect(upstreamRequests[1].path).toBe("/mcp");
      expect(upstreamRequests[1].headers.authorization).toBe("Bearer maxcompute-server-secret");
      for (const key of ["x-oma-tenant", "x-oma-session", "x-oma-agent-id", "x-oma-agent-version"]) expect(upstreamRequests[1].headers).not.toHaveProperty(key);
      expect(() => process.kill(launch.pid, 0)).toThrow();
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const path of [`/v1/oma/mcp-proxy/${session.id}/maxcompute`, `/v1/oma/inference-proxy/${session.id}/anthropic/v1/messages`, "/v1/agents"]) {
        const response = await cp.fetch(new Request(base + path, { headers: { authorization: `Bearer ${launch.token}` } }));
        expect(response.status).toBe(401);
      }
      await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "Continue with the retained state" }] }] });
      for (let i = 0; i < 100; i++) {
        events = (await request(`/v1/sessions/${session.id}/events`)).data;
        if (events.filter(event => event.type === "session.status_idle").length === 2) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(events.filter(event => event.type === "agent.message")).toHaveLength(2);
      expect(events.filter(event => event.type === "session.error")).toEqual([]);
      const resumed = JSON.parse(await readFile(join(root, "workspace", "launch.json"), "utf8"));
      expect(resumed.mode).toBe("resumed:prior-turn");
      expect(resumed.token).not.toBe(launch.token);
      expect(resumed.pid).not.toBe(launch.pid);
      expect(() => process.kill(resumed.pid, 0)).toThrow();
      expect(JSON.stringify(resumed.prompt)).toContain("Continue with the retained state");
      expect(upstreamRequests).toHaveLength(4);
    } finally {
      releaseFirstModel();
      releaseSandbox();
      try {
        await worker?.waitForIdle();
        await cp?.stop("test");
        await sandbox.destroy();
        await close(gateway); await close(upstream);
        await rm(root, { recursive: true, force: true });
      } finally {
        polling.mockRestore();
      }
    }
  }, 20_000);
});
