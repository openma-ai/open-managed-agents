import { workRuntimeModules } from "./helpers/work-runtime-modules.js";
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import type { AgentSpec } from "@open-managed-agents/acp-runtime";
import { WorkTurnActivities } from "../src/node-work-composition.js";
import { runNodeWorkItemCli } from "../src/node-work-item-cli.js";
import { loadNodeConfig } from "../../../apps/main-node/src/config.js";
import { nodeDefaults } from "../../../apps/main-node/src/components.js";
import { createNodeControlPlane } from "../../../apps/main-node/src/control-plane.js";
import { WorkFinalizationApplication } from "../../managed-agents-application/src/work-finalization/application.js";
import { SqlWorkFinalization } from "../../managed-agents-adapters-sql/src/work-finalization.js";
import { buildWorkFinalizationRoutes } from "../../http-routes/src/work-finalization.js";
import { authenticateWorkFinalizationBearer } from "../../managed-agents-adapters-runtime/src/environment-work-session-token.js";
import { SqlEnvironmentWorkStore } from "../../environment-work-store-sql/src/index.js";
const { getRequestListener } = createRequire(new URL("../../../apps/main-node/package.json", import.meta.url).href)("@hono/node-server") as typeof import("../../../apps/main-node/node_modules/@hono/node-server");

type Behaviour = "no-mode" | "die-after-consume" | "must-not-prompt" | "ok";

/** Real Node HTTP/SQLite control plane, real common, real ACP JSON-RPC. Each
 * `generation()` reproduces one dispatcher re-launch after TTL reclaim: a new
 * claim generation + holder, a new scoped token, the same Work and Session. */
async function controlPlane() {
  const { common, modes, AcpRuntimeImpl } = await workRuntimeModules();
  const cleanup: Array<() => Promise<unknown>> = [];
  const root = await mkdtemp(join(tmpdir(), "work-settlement-loop-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const controlServer = createServer();
  await new Promise<void>(resolve => controlServer.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (controlServer.address() as { port: number }).port;
  cleanup.push(() => new Promise<void>(resolve => { controlServer.closeAllConnections(); controlServer.close(() => resolve()); }));
  const config = loadNodeConfig({ PUBLIC_BASE_URL: base, GATEWAY_ORIGIN: base, NODE_ENV: "test", AUTH_DISABLED: "0", API_KEY: "test-admin", PROCESS_MODE: "api", LOG_LEVEL: "silent", PLATFORM_ROOT_SECRET: "test-work-inputs-root-secret-32-characters", OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", DATABASE_PATH: join(root, "db.sqlite"), AUTH_DATABASE_PATH: join(root, "auth.sqlite"), MEMORY_BLOB_DIR: join(root, "memory"), SESSION_OUTPUTS_DIR: join(root, "outputs"), SANDBOX_WORKDIR: join(root, "sandbox"), MEMORY_QUEUE: "disabled" });
  const components = await nodeDefaults(config); const cp = await createNodeControlPlane(components); cleanup.push(() => cp.stop("test"));
  const sql = components.database.sql;
  const cipher = components.secrets!.cipherFor("managed.environment-work.secret");
  const store = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }) });
  const published: string[] = [];
  // Real canonical CAS; only the physical sandbox checkpoint/artifact host is a fixture.
  const finalRoutes = buildWorkFinalizationRoutes({
    authenticate: (token, method, path) => authenticateWorkFinalizationBearer({ token, method, path, crypto: components.secrets!.cipherFor("managed.environment-work.session-token"), now: () => new Date(), find: claim => store.find(claim) }),
    applicationFor: async () => new WorkFinalizationApplication({ persistence: new SqlWorkFinalization(sql), host: {
      async prepare() { return { type: "prepared" }; },
      async publish(scope) { published.push(scope.terminal.eventId); return { type: "published" }; },
    } }),
  });
  controlServer.on("request", getRequestListener(request => {
    const url = new URL(request.url);
    if (["work-checkpoint", "work-finalize", "work-publish", "work-failed"].some(action => url.pathname.endsWith("/" + action))) { url.pathname = url.pathname.replace("/v1/oma/sessions", ""); return finalRoutes.fetch(new Request(url, request)); }
    return cp.fetch(request);
  }));
  async function create(path: string, body: unknown): Promise<Record<string, unknown>> { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-admin" }, body: JSON.stringify(body) }); expect(r.status, await r.clone().text()).toBeLessThan(300); return await r.json() as Record<string, unknown>; }
  const env = await create("/v1/environments", { name: "loop", config: { type: "cloud", networking: { type: "unrestricted" } } });
  const agent = await create("/v1/agents", { name: "loop", model: "test", _oma: { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } } });
  const session = await create("/v1/sessions", { agent: agent.id, environment_id: env.id, initial_events: [{ type: "user.message", content: [{ type: "text", text: "first" }] }] });
  const scope = { workspaceId: "default", environmentId: String(env.id), sessionId: String(session.id), workId: "loop-work" };
  await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(session.id).run();
  let inserted = false;

  async function generation(generation: number, behaviour: Behaviour, workId = scope.workId, options: { onResidentPoll?: () => Promise<unknown> } = {}) {
    const scope_ = { ...scope, workId };
    const now = new Date().toISOString();
    const token = "sk-ant-req-v1." + await components.secrets!.cipherFor("managed.environment-work.session-token").encrypt(JSON.stringify({ version: 1, ...scope_, issuedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(), claimedAt: now, generation, skills: [], files: [], memoryStores: [] }));
    if (!inserted && workId === scope.workId) {
      inserted = true;
      await store.insert({ workspaceId: "default", record: { work: { id: scope.workId, environmentId: scope.environmentId, data: { type: "session", id: scope.sessionId }, state: "queued", createdAt: now, acknowledgedAt: null, latestHeartbeatAt: null, startedAt: null, metadata: {}, stopRequestedAt: null, stoppedAt: null }, secret: { sessionsToken: token }, claim: { generation, workerId: "holder-" + generation, claimedAt: now }, heartbeatTtlSeconds: 90 } });
    } else {
      // The dispatcher's TTL reclaim: same Work, next generation/holder.
      const sealed = await cipher.encrypt(JSON.stringify({ sessionsToken: token }));
      await sql.prepare("UPDATE managed_environment_work SET claim_generation=?, claim_worker_id=?, claim_at=?, sealed_secret=?, sandbox_token_hashes=NULL, state='queued', revision=revision+1 WHERE workspace_id='default' AND id=? AND state<>'stopped'")
        .bind(generation, "holder-" + generation, Date.now(), sealed, workId).run();
    }
    const controller = new AbortController();
    let prompts = 0, newSessions = 0, buffer = "";
    const promptTexts: string[] = [];
    let send!: (value: object) => void;
    const exit = (() => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; })();
    let configOptions = behaviour === "no-mode" ? [] : [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "read-only", options: [{ value: "read-only", name: "Read only" }, { value: "agent", name: "Agent" }, { value: "agent-full-access", name: "Full" }] }];
    const spawner = { async spawn(spec: AgentSpec) {
      if (spec.command === "/bin/sh") return new NodeSpawner().spawn(spec);
      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { send = value => c.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")); } }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stdin: new WritableStream<Uint8Array>({ async write(bytes) {
          buffer += new TextDecoder().decode(bytes);
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n"); const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "@agentclientprotocol/codex-acp", version: "1.8.0" } } });
            else if (m.method === "session/new") { newSessions++; send({ id: m.id, result: { sessionId: "native", configOptions } }); }
            else if (m.method === "session/set_config_option") { configOptions = configOptions.map(o => ({ ...o, currentValue: m.params.value })); send({ id: m.id, result: { configOptions } }); }
            else if (m.method === "session/prompt") {
              prompts++; promptTexts.push(JSON.stringify(m.params.prompt));
              // The input is already consumed: the worker dies (OOM, sandbox
              // kill) before any terminal is committed. No settlement possible.
              if (behaviour === "die-after-consume") controller.abort(new Error("worker process died after consume"));
              else send({ id: m.id, result: { stopReason: "end_turn" } });
            }
          }
        } }),
        async kill() { exit.resolve(); }, exited: exit.promise.then(() => ({ code: 0, signal: null })),
      };
    } };
    const requests: string[] = [];
    const plans: string[] = [];
    let residentPolls = 0;
    const fetcher: typeof fetch = async (raw, init) => {
      const action = new URL(String(raw)).pathname.split("/").at(-1)!; requests.push(action);
      const response = await fetch(raw, init);
      if (action === "work-bootstrap") {
        const plan = await response.clone().json() as { type: string; reason?: string; terminal?: { stopReason?: { type?: string } } };
        plans.push(plan.type + (plan.reason ? ":" + plan.reason : "") + (plan.terminal?.stopReason?.type ? ":" + plan.terminal.stopReason.type : ""));
        // A resident consumer with nothing left to settle polls forever: a
        // re-read after this claim published, or a plain idle, is its steady
        // state. End the generation there unless the test injects new input.
        if (plan.type !== "run" && (plan.type === "idle" || requests.slice(0, -1).includes("work-publish"))) {
          residentPolls++;
          const hook = options.onResidentPoll; options.onResidentPoll = undefined;
          if (hook) await hook();
          else setTimeout(() => controller.abort(new Error("resident poll")), 10);
        }
      }
      // A healthy resident consumer never exits by itself; end the test run
      // once its one terminal has been durably published.
      if (behaviour === "ok" && prompts > 0 && action === "work-publish" && response.ok) setTimeout(() => controller.abort(new Error("test done")), 10);
      return response;
    };
    const error = await runNodeWorkItemCli({
      workspacePath: root, signal: controller.signal, fetch: fetcher, heartbeatIntervalMs: 20,
      environment: { ANTHROPIC_ENVIRONMENT_ID: scope.environmentId, ANTHROPIC_SESSION_ID: scope.sessionId, ANTHROPIC_WORK_ID: workId, OPENMA_HARNESS_ID: "acp", OPENMA_ACP_AGENT_ID: "codex-acp", ANTHROPIC_WORK_SECRET: Buffer.from(JSON.stringify({ sessions_token: token, api_base_url: base })).toString("base64url") },
      runtime: { activities: new WorkTurnActivities(), spawner, modules: { control: { createSupervisor: common.createManagedAcpSupervisorHarness, createControlChannel: common.createManagedHarnessHttpControlChannel, applyPermissionMode: modes.applyAcpPermissionMode }, createAcpRuntime: spawner => new AcpRuntimeImpl(spawner) },
        stateIo: { async readFile() { throw Object.assign(Error("missing"), { code: "ENOENT" }); }, async writeFile() {}, async writeFileBytes() {}, async exec() { return ""; } } },
    }).then(() => undefined, (error: unknown) => error);
    return { error, prompts, promptTexts, newSessions, requests, plans, residentPolls };
  }
  const work = async () => (await sql.prepare("SELECT state FROM managed_environment_work WHERE id=?").bind(scope.workId).first<{ state: string }>())!.state;
  const facts = async () => (await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=?").bind(scope.sessionId).all<{ document: string }>()).results!.map(row => JSON.parse(row.document));
  const status = async () => (await sql.prepare("SELECT status FROM managed_sessions WHERE id=?").bind(scope.sessionId).first<{ status: string }>())!.status;
  const root$ = async () => JSON.parse((await sql.prepare("SELECT document FROM managed_session_initial_events WHERE session_id=?").bind(scope.sessionId).first<{ document: string }>())!.document);
  const send = (text: string) => create(`/v1/sessions/${scope.sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  const latestWork = async () => (await sql.prepare("SELECT id,state FROM managed_environment_work WHERE session_id=? ORDER BY created_at DESC LIMIT 1").bind(scope.sessionId).first<{ id: string; state: string }>())!;
  return { generation, send, latestWork, work, facts, status, root: root$, published, close: async () => { for (const close of cleanup.reverse()) await close(); } };
}

it("class (a): a not-dispatched refusal before input consumption settles once as startup failure and stops the Work loop", async () => {
  const f = await controlPlane();
  try {
    const first = await f.generation(2, "no-mode");
    expect(first.error).toBeInstanceOf(Error);
    expect(first.prompts).toBe(0);
    // Never consumed, never dispatched.
    expect((await f.root()).source_position?.consumed_by_execution_id).toBeUndefined();
    expect(first.requests).toContain("startup-failed");
    expect(await f.work()).toBe("stopped");
    expect(await f.status()).toBe("idle");
    const errors = (await f.facts()).filter(e => e.type === "session.error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error.retryStatus).toBe("exhausted");

    // The original Work loop is over: a stopped Work is never reclaimed. A
    // later fresh Work still fails closed on this startup terminal (no model,
    // no consumption) - see the open question on cross-Work startup terminals.
    await f.send("second");
    const fresh = await f.latestWork();
    expect(fresh.id).not.toBe("loop-work"); expect(fresh.state).toBe("queued");
    const next = await f.generation(1, "ok", fresh.id);
    expect(next.prompts).toBe(0);
    expect(next.requests).not.toContain("inputs-consume");
    expect(String((next.error as Error | undefined)?.message)).toContain("canonical_terminal_root_missing");
  } finally { await f.close(); }
}, 30000);

it("class (b): a consumed-without-terminal gap is settled once as retries_exhausted by the current claim, never redispatched", async () => {
  const f = await controlPlane();
  try {
    const dead = await f.generation(2, "die-after-consume");
    expect(dead.error).toBeInstanceOf(Error);
    expect(dead.prompts).toBe(1);
    expect((await f.root()).source_position?.consumed_by_execution_id).toBeTruthy();
    expect((await f.facts()).some(e => e.type === "session.status_idle")).toBe(false);

    // Dispatcher re-launch under a new claim generation.
    const next = await f.generation(3, "must-not-prompt");
    expect(next.prompts).toBe(0); expect(next.newSessions).toBe(0);
    expect(next.requests).toContain("work-failed"); expect(next.requests).toContain("work-publish");
    expect(next.requests).not.toContain("inputs-consume");
    const terminals = (await f.facts()).filter(e => e.type === "session.status_idle");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ stopReason: { type: "retries_exhausted" }, source_position: { environment_work: { generation: 3 } } });
    expect(await f.status()).toBe("idle");
    expect(f.published).toEqual([terminals[0].id]);

    // A further re-launch finds a committed terminal: cleanup only, no gap, no model.
    const after = await f.generation(4, "must-not-prompt");
    expect(after.prompts).toBe(0);
    expect(String((after.error as Error | undefined)?.message)).not.toContain("gap");
    expect(after.requests).not.toContain("work-failed");
    expect((await f.facts()).filter(e => e.type === "session.status_idle")).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);


const count = (values: string[], value: string) => values.filter(v => v === value).length;

it("class (b) across claim generations: a committed+published exhausted terminal leaves the Work resident idle, never re-failing or reclaim-looping", async () => {
  const f = await controlPlane();
  try {
    await f.generation(2, "die-after-consume");
    // Settling generation stays resident instead of exiting into a TTL reclaim.
    const settle = await f.generation(3, "must-not-prompt");
    expect(settle.prompts).toBe(0);
    expect(settle.requests).toContain("work-failed");
    expect(count(settle.requests, "work-publish")).toBe(1);
    expect(settle.residentPolls).toBeGreaterThan(0);
    expect(String((settle.error as Error | undefined)?.message)).toContain("resident poll");
    const terminal = (await f.facts()).filter(e => e.type === "session.status_idle");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].stopReason.type).toBe("retries_exhausted");

    // Every later re-launch (sandbox died, lease reclaimed) is the same steady
    // state: at most one idempotent republish of the SAME receipt, then idle.
    for (const g of [4, 5, 6]) {
      const later = await f.generation(g, "must-not-prompt");
      expect(later.prompts).toBe(0); expect(later.newSessions).toBe(0);
      expect(later.requests).not.toContain("work-failed");
      expect(later.requests).not.toContain("inputs-consume");
      expect(later.requests).not.toContain("startup-boundary");
      expect(count(later.requests, "work-publish")).toBeLessThanOrEqual(1);
      expect(later.plans[0]).toBe("cleanup-only:retries_exhausted");
      expect(later.residentPolls).toBeGreaterThan(0);
      expect(String((later.error as Error | undefined)?.message)).toContain("resident poll");
      expect(String((later.error as Error | undefined)?.message)).not.toContain("already ended");
      expect(await f.work()).toBe("active");
    }
    expect((await f.facts()).filter(e => e.type === "session.status_idle")).toHaveLength(1);
    expect(new Set(f.published)).toEqual(new Set([terminal[0].id]));
    expect(await f.status()).toBe("idle");
  } finally { await f.close(); }
}, 60000);

it("class (b): a new user message after the exhausted turn is served by a fresh turn, never by redispatching the consumed input", async () => {
  const f = await controlPlane();
  try {
    await f.generation(2, "die-after-consume");
    // Same resident process: settles, idles, then picks up the new message.
    const resident = await f.generation(3, "ok", undefined, { onResidentPoll: () => f.send("second") });
    expect(resident.prompts).toBe(1);
    expect(resident.promptTexts[0]).toContain("second");
    expect(resident.promptTexts.join()).not.toContain("first");
    let idles = (await f.facts()).filter(e => e.type === "session.status_idle");
    expect(idles.map(e => e.stopReason.type)).toEqual(["retries_exhausted", "end_turn"]);
    expect(idles[0].execution_id ?? idles[0].source_position?.execution_id).not.toBe(idles[1].execution_id ?? idles[1].source_position?.execution_id);

    // A later reclaimed generation serves the next message as its own turn.
    await f.send("third");
    const fresh = await f.generation(4, "ok");
    expect(fresh.prompts).toBe(1);
    expect(fresh.promptTexts[0]).toContain("third");
    // Fresh native state is rebuilt from canonical history; the exhausted
    // consumed input is never replayed, the new message is the request.
    expect(fresh.promptTexts[0]).toMatch(/Current request:\\nthird/);
    expect(fresh.promptTexts.join()).not.toContain("first");
    idles = (await f.facts()).filter(e => e.type === "session.status_idle");
    expect(idles.map(e => e.stopReason.type)).toEqual(["retries_exhausted", "end_turn", "end_turn"]);
    expect(await f.work()).toBe("active");
  } finally { await f.close(); }
}, 60000);
