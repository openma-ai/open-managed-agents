/** Explicit opt-in deployed-service acceptance; never discovered by ordinary vitest. */
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import OpenAI from "openai";
import type { SessionCreateParamsNonStreaming } from "openai/resources/beta/agents/sessions/sessions";
import { assertSingleFunctionSettlement, assertUniqueIds } from "../_helpers/openai-acceptance";

if (process.env.OMA_LIVE_LLM !== "1") throw new Error("Explicit OMA_LIVE_LLM=1 required; this suite spends real model tokens");
const bases = (process.env.OMA_LIVE_BASE_URLS ?? "").split(",").filter(Boolean);
const key = process.env.OMA_API_KEY;
const model = process.env.OMA_LIVE_MODEL;
const expectedWireModel = process.env.OMA_LIVE_WIRE_MODEL;
const output = process.env.OMA_LIVE_EVIDENCE_DIR;
const environmentTemplate = process.env.OMA_LIVE_ENVIRONMENT_TEMPLATE_ID;
const restartScript = process.env.OMA_LIVE_RESTART_SCRIPT;
if (!bases.length || !key || !model || !expectedWireModel || !output) throw new Error("Set OMA_LIVE_BASE_URLS, OMA_API_KEY, OMA_LIVE_MODEL, OMA_LIVE_WIRE_MODEL and OMA_LIVE_EVIDENCE_DIR");
for (const base of bases) { const url = new URL(base); assert(!url.username && !url.password && ["http:", "https:"].includes(url.protocol)); }
const timeout = Number(process.env.OMA_LIVE_TIMEOUT_MS ?? 180000);
assert(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 600000);
const root = resolve(output);
await mkdir(root, { recursive: true });
const secrets = [key, process.env.MINIMAX_API_KEY, process.env.E2B_API_KEY].filter((x): x is string => Boolean(x));
const redact = (text: string) => secrets.reduce((s, secret) => s.split(secret).join("<redacted>"), text);
async function save(name: string, data: unknown) { await writeFile(resolve(root, name + ".json"), redact(JSON.stringify(data, null, 2))); }
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const diff = execFileSync("git", ["diff", "HEAD"], { encoding: "utf8" });
const sourceSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
await save("fingerprint", { head, sourceSha256, diffSha256: createHash("sha256").update(diff).digest("hex"), bases, model, expectedWireModel, deployedHead: process.env.OMA_LIVE_DEPLOYED_HEAD ?? "UNVERIFIED", startedAt: new Date().toISOString(), topology: "externally managed services; no mock model or local sandbox injection" });
const cardResponse = await fetch(bases[0]!.replace(/[/]$/, "") + "/v1/oma/model_cards", { headers: { "x-api-key": key }, signal: AbortSignal.timeout(timeout) });
assert(cardResponse.ok, "model card readback must succeed");
const cards = await cardResponse.json() as any;
const card = (Array.isArray(cards) ? cards : cards.data ?? cards.model_cards ?? []).find((row: any) => row.model_id === model);
assert(card, "requested workspace model card must exist");
assert.equal(card.model, expectedWireModel, "wire model read back from workspace configuration");
await save("model-readback", { model_id: card.model_id, model: card.model, provider: card.provider, base_url: card.base_url });
let sequence = 0;
const clients = bases.map(base => new OpenAI({ apiKey: key, baseURL: base.replace(/[/]$/, "") + "/openai/v1", maxRetries: 0, timeout, fetch: async (url, init) => {
  const response = await fetch(url, init);
  const record: Record<string, unknown> = { at: new Date().toISOString(), url: String(url), method: init?.method, body: init?.body, status: response.status };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) record.response = await response.clone().text();
  await save("http-" + (++sequence), record);
  return response;
} }));
const api = (replica = 0) => clients[replica % clients.length]!.beta.agents.sessions;
const owned: string[] = [];
const results: Array<{ scenario: string; status: string; error?: string }> = [];
const message = (text: string) => ({ type: "agent.session.input.message" as const, input: [{ role: "user" as const, content: [{ type: "input_text" as const, text }] }] });
async function wait<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + timeout; let value: T;
  do { value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 500)); } while (Date.now() < deadline);
  throw new Error("Timed out waiting for durable state: " + JSON.stringify(value!));
}
async function items(id: string, replica = 0): Promise<any[]> { const rows: any[] = []; for await (const row of api(replica).items.list(id, { limit: 2, order: "asc" })) rows.push(row); assertUniqueIds(rows); await save(id + "-items-" + sequence, rows); return rows; }
async function turns(id: string, replica = 0): Promise<any[]> { const rows: any[] = []; for await (const row of api(replica).turns.list(id, { limit: 1, order: "asc" })) rows.push(row); assertUniqueIds(rows); await save(id + "-turns-" + sequence, rows); return rows; }
async function completed(id: string, count: number, replica = 0) { return wait(() => turns(id, replica), rows => rows.length === count && rows.every(r => r.status === "completed")); }
async function create(input: SessionCreateParamsNonStreaming) { const session = await api().create(input); owned.push(session.id); await save("owned-sessions", owned); return session; }
async function scenario(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ scenario: name, status: "PASS" }); }
  catch (error) { results.push({ scenario: name, status: "FAIL", error: redact(String(error instanceof Error ? error.stack : error)) }); }
  await save("results", results);
}

await scenario("function-RA-deferred-steer-peer-settlement-pagination", async () => {
  const nonce = "LIVE_" + randomUUID();
  const session = await create({ agent: { model, instructions: "Follow tool instructions exactly. Never invent tool results.", tools: [{ type: "function", name: "lookup", description: "Return a value for key answer", parameters: { type: "object", properties: { key: { type: "string", enum: ["answer"] } }, required: ["key"], additionalProperties: false } }] }, environment: { type: "none" }, input: "Call lookup exactly once with key answer. Wait for its result before answering." });
  const waiting = await wait(() => api(1).retrieve(session.id), value => value.status === "requires_action");
  assert.equal(waiting.required_actions.length, 1);
  const action = waiting.required_actions[0]!; assert.equal(action.type, "function_call");
  if (action.type !== "function_call") throw new Error("Expected function action");
  assert.equal(action.name, "lookup"); assert.deepEqual(action.arguments, { key: "answer" });
  await api(1).events.create(session.id, { events: [message("After the pending lookup settles, reply exactly " + nonce + ". Do not call any more tools.")] });
  const deferred = await api().retrieve(session.id);
  assert.equal(deferred.status, "requires_action"); assert.deepEqual(deferred.required_actions, waiting.required_actions);
  if (restartScript) {
    const beforeItems = await items(session.id);
    const beforeTurns = await turns(session.id);
    // Operator-owned isolated infrastructure hook, not production recovery logic.
    const restarted = await promisify(execFile)("/bin/bash", [resolve(restartScript)], { timeout, maxBuffer: 1024 * 1024 });
    await save("restart-hook", { at: new Date().toISOString(), stdout: restarted.stdout, stderr: restarted.stderr });
    await wait(() => api(1).retrieve(session.id), value => value.status === "requires_action");
    assert.deepEqual((await api(1).retrieve(session.id)).required_actions, waiting.required_actions);
    assert.deepEqual(await items(session.id, 1), beforeItems);
    assert.deepEqual(await turns(session.id, 1), beforeTurns);
  }
  const body = { events: [{ type: "agent.session.input.tool_result" as const, turn_id: action.turn_id, call_id: action.call_id, success: true as const, output: "42" }], "Idempotency-Key": randomUUID() };
  await api(1).events.create(session.id, body);
  await completed(session.id, 1, 1);
  const settled = await items(session.id, 1);
  assertSingleFunctionSettlement(settled, action.call_id, action.turn_id);
  assert(settled.some(row => row.type === "message" && row.role === "assistant" && JSON.stringify(row.content).includes(nonce)));
  assert(settled.some(row => row.type === "message" && row.role === "user" && JSON.stringify(row.content).includes(nonce) && row.turn_id === action.turn_id));
  await api().events.create(session.id, body);
  assert.deepEqual(await items(session.id), settled);
  assert.equal((await api(1).retrieve(session.id)).required_actions.length, 0);
});

await scenario("SSE-disconnect-Items-Turns-multiround-peer-history", async () => {
  const first = "FIRST_" + randomUUID(), missed = "MISSED_" + randomUUID(), last = "LAST_" + randomUUID();
  const session = await create({ agent: { model, instructions: "Reply exactly with the requested token. Do not use tools." }, environment: { type: "none" }, input: "Reply exactly " + first });
  await completed(session.id, 1);
  await api(1).events.create(session.id, { events: [message("Reply exactly " + missed)] });
  await completed(session.id, 2, 1);
  const history = await items(session.id, 1);
  assert(history.some(row => row.role === "assistant" && JSON.stringify(row.content).includes(missed)));
  const oldIds = new Set((await turns(session.id)).map(row => row.id));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Live stream bounded timeout")), timeout);
  const events: any[] = [];
  try {
    const stream = await api(1).events.stream(session.id, { signal: controller.signal });
    const receiving = (async () => { let done = false; for await (const event of stream) { events.push(event); if (event.type === "agent.session.turn.completed") done = true; if (done && event.type === "agent.session.idle") break; } })();
    await api().events.create(session.id, { events: [message("Reply exactly " + last)] });
    await receiving;
  } finally { clearTimeout(timer); controller.abort(); await save(session.id + "-SSE", events); }
  const created = events.filter(e => e.type === "agent.session.turn.created");
  assert.equal(created.length, 1); assert(!oldIds.has(created[0].turn_id));
  assert.equal(new Set(events.map(e => e.event_id)).size, events.length);
  assert.equal(events.at(-1)?.type, "agent.session.idle");
  await completed(session.id, 3, 1);
  assert((await items(session.id)).some(row => row.role === "assistant" && JSON.stringify(row.content).includes(last)));
});

await scenario("real-tool-binary-artifact-peer-download", async () => {
  const session = await create({ agent: { model, instructions: "Use bash to write the requested files. Do not claim completion without executing the command." }, environment: { type: "openai_hosted", ...(environmentTemplate ? { environment_template_id: environmentTemplate } : {}) }, input: "Use bash once: mkdir -p /workspace/outputs && printf '\\000\\377\\376\\015\\012A' > /workspace/outputs/live.bin . Then reply DONE." });
  await completed(session.id, 1, 1);
  const artifacts = await wait(async () => (await api(1).artifacts.list(session.id)).data, rows => rows.some(row => row.path === "/workspace/outputs/live.bin"));
  const artifact = artifacts.find(row => row.path === "/workspace/outputs/live.bin")!;
  assert.equal(artifact.size_bytes, 6);
  const response = await api().artifacts.content(artifact.id, { session_id: session.id });
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("hex"), "00fffe0d0a41");
  await save(session.id + "-artifacts", artifacts);
  const durable = await items(session.id, 1);
  assert(durable.some(row => row.type === "command_execution" && row.command.includes("/workspace/outputs/live.bin") && row.status === "completed"), "real persisted bash execution, not model self-report");
});

await scenario("real-subagent-root-child-history-isolation", async () => {
  const childToken = "CHILD_" + randomUUID();
  const rootToken = "ROOT_" + randomUUID();
  const session = await create({ agent: { model, instructions: "Follow the requested delegation using the subagent tools; wait for completion before answering.", multi_agent: { enabled: true, max_concurrent_subagents: 1 } }, environment: { type: "none" }, input: "Create one subagent whose task is to reply exactly " + childToken + ". Wait for it to complete, then close it and reply exactly " + rootToken + ". Do not include the child token in your final answer." });
  await wait(() => turns(session.id, 1), rows => rows.some(row => row.subagent_id === null && row.status === "completed"));
  const children = [];
  for await (const row of api(1).subagents.list(session.id, { limit: 1 })) children.push(row);
  assert.equal(children.length, 1);
  assert.equal(children[0]!.status, "closed");
  const rootItems = await items(session.id, 1);
  assert(rootItems.some(row => row.type === "create_subagent_call" && row.status === "completed"));
  assert(rootItems.some(row => row.type === "wait_for_subagents_call" && row.status === "completed"));
  const childItems = [];
  for await (const row of api().subagents.items.list(children[0]!.id, { session_id: session.id, limit: 2 })) childItems.push(row);
  assertUniqueIds(childItems);
  await save(session.id + "-child-items", childItems);
  assert(childItems.some(row => row.type === "message" && row.role === "assistant" && JSON.stringify(row.content).includes(childToken)));
  assert(rootItems.some(row => row.type === "message" && row.role === "assistant" && JSON.stringify(row.content).includes(rootToken)));
  assert(!childItems.some(row => row.type === "message" && row.role === "assistant" && JSON.stringify(row.content).includes(rootToken)));
});

results.push(restartScript
  ? { scenario: "process-restart-during-RA", status: results[0]?.status === "PASS" ? "PASS" : "FAIL", ...(results[0]?.error ? { error: results[0].error } : {}) }
  : { scenario: "process-restart-during-RA", status: "NOT_RUN", error: "Set OMA_LIVE_RESTART_SCRIPT to an operator-owned isolated process restart hook" });

for (const id of owned) {
  try { await api().delete(id); }
  catch (error) { results.push({ scenario: "cleanup:" + id, status: "FAIL", error: redact(String(error)) }); }
}
await save("results", results);
console.log(JSON.stringify({ head, results, evidence: root }, null, 2));
if (results.some(row => row.status === "FAIL")) process.exitCode = 1;
