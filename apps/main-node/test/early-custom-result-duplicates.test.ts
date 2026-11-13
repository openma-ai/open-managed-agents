// PR545 E1 regression (real E2E session_QZNPXuLjX75Qgy9F09QEF, two-Node/PG/E2B,
// 2026-11-12 09:20 Asia/Shanghai): while a slow ordinary tool ran, the client
// POSTed an unknown custom result, the valid one and a duplicate of it. Node
// accepted all three (200), parked at requires_action for the already-answered
// call and never resumed. Reproduced here over actual HTTP + durable SQLite:
//   - a queued duplicate receipt counted as having closed the call before the
//     valid answer's own execution ran, so every answer planned no_effect;
//   - an answer for a custom_tool_use_id the Session never had, arriving after
//     the turn ended, started another model sampling. (Node admission accepts
//     such answers with 200 as in HEAD; Cloudflare rejects them with 400. That
//     admission difference is an open policy decision and is not changed here.)
import { mkdtempSync, rmSync } from "node:fs";
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

const VALID = "toolu_custom_0";
type Step = "unknown" | "valid";

it.each<[string, Step[], "while-blocked" | "after-end"]>([
  ["real E2E order: unknown, valid, duplicate", ["unknown", "valid", "valid"], "while-blocked"],
  ["valid then duplicate", ["valid", "valid"], "while-blocked"],
  ["unknown then valid", ["unknown", "valid"], "while-blocked"],
  ["valid only (control)", ["valid"], "while-blocked"],
  ["late unknown after the turn ended", ["valid", "unknown"], "after-end"],
])("%s: one ordinary effect, unknown IDs inert, resumes once with every answer", async (_label, steps, unknownTiming) => {
  const dir = mkdtempSync(join(tmpdir(), "oma-early-dup-"));
  let release!: () => void; const latch = new Promise<void>(r => { release = r; });
  let entered = false; let bashRuns = 0;
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const seen: string[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("approve_ticket", { ticket: "A1" }, { id: VALID }), fauxToolCall("bash", { command: "slow" }, { id: "toolu_bash_1" })], { stopReason: "toolUse" }),
    context => { seen.push(JSON.stringify(context.messages)); return fauxAssistantMessage("done after answers"); },
    () => fauxAssistantMessage("UNEXPECTED extra sampling"),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const harnessId = "early-dup-" + Math.random().toString(36).slice(2);
  registerHarness(harnessId, () => ({ async run(ctx: HarnessContext) {
    await new PiHarness().run({ ...ctx, pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      tools: { ...ctx.tools, bash: { ...ctx.tools.bash!, execute: async () => { bashRuns++; entered = true; await latch; return "slow done"; } } } });
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
    await ok("/v1/oma/model_cards", { provider: "ant", model_id: "early-dup-model", api_key: "test", base_url: "http://unused.invalid" });
    const agent = await ok("/v1/agents", { name: "dup", model: "early-dup-model", system: "t", _oma: { harness: harnessId },
      tools: [{ type: "agent_toolset_20260401" }, { type: "custom", name: "approve_ticket", description: "a", input_schema: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] } }] });
    const env = await ok("/v1/environments", { name: "dup", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const session = await ok("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: env.id });
    const path = `/v1/sessions/${session.id}/events`;
    const history = async () => (await ok(path + "?limit=1000&order=asc")).data as any[];
    const answer = (id: string) => call(path, { events: [{ type: "user.custom_tool_result", custom_tool_use_id: id, content: [{ type: "text", text: `answer:${id}` }] }] });
    await ok(path, { events: [{ type: "user.message", content: [{ type: "text", text: "Run scenario M-CUSTOM-FIRST." }] }] });
    await expect.poll(() => entered).toBe(true);
    const statuses: Array<[Step, number]> = [];
    const send = async (step: Step) => statuses.push([step, (await answer(step === "valid" ? VALID : "invalid-pr545")).status]);
    for (const step of steps) if (step === "valid" || unknownTiming === "while-blocked") await send(step);
    expect(faux.state.callCount).toBe(1);
    release();
    await expect.poll(async () => live() === 0 && (await history()).some(e => e.type === "session.status_idle" && e.stop_reason?.type === "end_turn"), { timeout: 15_000 }).toBe(true);
    if (unknownTiming === "after-end") for (const step of steps) if (step === "unknown") await send(step);
    await expect.poll(live, { timeout: 15_000 }).toBe(0);
    const events = await history();
    // Every answer is accepted and durably recorded (HEAD Node admission);
    // an unknown ID is inert: never sampled, never in the model's history.
    for (const [step, status] of statuses) expect(status, step).toBe(200);
    expect(events.filter(e => e.type === "user.custom_tool_result")).toHaveLength(steps.length);
    expect(seen.join("")).not.toContain("invalid-pr545");
    // Well-formed for a real provider: exactly one result per call, no orphans.
    const resumed = JSON.parse(seen[0]!) as Array<{ role: string; toolCallId?: string; content?: Array<{ type: string; id?: string }> }>;
    const calls = resumed.flatMap(m => m.role === "assistant" && Array.isArray(m.content) ? m.content.filter(p => p.type === "toolCall").map(p => p.id) : []);
    expect(calls.sort()).toEqual(["toolu_bash_1", VALID].sort());
    expect(resumed.filter(m => m.role === "toolResult").map(m => m.toolCallId).sort()).toEqual(["toolu_bash_1", VALID].sort());
    // Exactly one ordinary effect, exactly two model samplings, the second with both results.
    expect(bashRuns).toBe(1);
    expect(faux.state.callCount).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("answer:" + VALID);
    expect(seen[0]).toContain("slow done");
    expect(events.filter(e => e.type === "agent.message").map(e => JSON.stringify(e.content))).toEqual([JSON.stringify([{ type: "text", text: "done after answers" }])]);
    expect(events.filter(e => e.type === "session.status_idle").map(e => e.stop_reason?.type)).toEqual(["requires_action", "end_turn"]);
  } finally {
    release(); server.closeAllConnections(); await new Promise(r => server.close(() => r(null))); db.close(); await cp.stop("test"); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
