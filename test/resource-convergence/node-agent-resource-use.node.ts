// Node Session host: agent-observed Skill / Memory / outputs behavior.
//
// EVIDENCE LEVELS (kept explicit, see docs/resource-semantics.md):
// - Model: deterministic Anthropic-wire fixture (resource-agent-fixture.ts),
//   served over loopback HTTP; no paid inference. It decides tool calls only
//   from what the production harness sent it.
// - Platform: the real `apps/main-node/src/index.ts` process (default Pi
//   harness, real SQLite, real Memory/Files blob dirs, real output collector)
//   with the local-subprocess sandbox (real /bin/sh, real files, uid != 0).
// - Owner restart: SIGKILL of that process tree and a new process on the same
//   data directory (bootOpenAINode.restart()).
// - Independent readback: Memory via the REST memories API of the (restarted)
//   process, outputs via GET /v1/sessions/:id/outputs/:name — never via the
//   sandbox the agent wrote through.
// NOT covered here: Cloudflare containers/R2 FUSE, E2B, live providers.
//
// Run (targeted, Node pool):
//   pnpm exec vitest run --config test/resource-convergence/vitest.node.config.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { bootOpenAINode, type OpenAINodeProcess } from "../../apps/main-node/test/_helpers/openai-node-process";
import {
  EXPECTED_REPORT, MEMORY_FACT, MEMORY_FACT_FILE, READONLY_SEED, READONLY_SEED_FILE, READONLY_MUTATION,
  REPORT_FILENAME, SKILL_FILES, WRONG_CONTEXT_FILENAME, decodeMarkedBase64, flattenSystem, recallTurn, turnA,
  type FixtureReply, type ResourceAgentScenario, type TurnPlanContext,
} from "./resource-agent-fixture";

const BETA = { "anthropic-beta": "managed-agents-2026-04-01" };
const MODEL = "claude-sonnet-4-20250514";
const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

type AnthropicBlock = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; id?: string; name?: string; input?: unknown };
type AnthropicMessage = { role: string; content: string | AnthropicBlock[] };

function blocks(message: AnthropicMessage): AnthropicBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}
function resultText(block: AnthropicBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
  return "";
}
/** The current turn = after the last user message carrying user text. */
function currentTurn(input: Record<string, any>): { marker: string; ctx: TurnPlanContext } {
  const messages = (input.messages ?? []) as AnthropicMessage[];
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user" && blocks(messages[i]!).some((b) => b.type === "text" && /TURN_[A-Z]/u.test(b.text ?? ""))) { start = i; break; }
  }
  const marker = start < 0 ? "" : (/TURN_[A-Z]/u.exec(blocks(messages[start]!).map((b) => b.text ?? "").join(" "))?.[0] ?? "");
  const results = messages.slice(start + 1).flatMap(blocks).filter((b) => b.type === "tool_result")
    .map((b) => ({ text: resultText(b), isError: b.is_error === true, toolUseId: b.tool_use_id }));
  return { marker, ctx: { system: flattenSystem(input.system), toolNames: ((input.tools ?? []) as Array<{ name: string }>).map((t) => t.name), results } };
}

let fixture: OpenAINodeProcess | undefined;
afterEach(async () => {
  // Read-only Memory copies are chmod a-w inside the sandbox workdir; restore
  // owner write bits so the fixture can remove its temp directory.
  if (fixture) execFileSync("chmod", ["-R", "u+w", fixture.directory]);
  await fixture?.dispose(); fixture = undefined;
});

it("Node host ACCEPTANCE: agent discovers Skill, runs its relative script into outputs, persists Memory across turns and owner restart, and observes a read-only refusal by call id", async () => {
  await runScenario("acceptance");
}, 300_000);

// DIAGNOSTIC, NOT ACCEPTANCE: the test hands the agent /mnt/memory/<name>
// paths when the prompt lacks them, isolating the Memory IO path (persist,
// read-only error by call id, owner restart) from guidance. Passing this says
// nothing about model visibility; the acceptance case above owns that.
it("Node host DIAGNOSTIC: Memory IO path with test-supplied paths (not acceptance)", async () => {
  await runScenario("diagnostic");
}, 300_000);

async function runScenario(mode: "acceptance" | "diagnostic"): Promise<void> {
  const scenario: { value?: ResourceAgentScenario } = {};
  const hintUses: string[] = [];
  const replies: Array<{ marker: string; reply: FixtureReply }> = [];
  fixture = await bootOpenAINode((input) => {
    const { marker, ctx } = currentTurn(input);
    const s = scenario.value!;
    const reply: FixtureReply = marker === "TURN_A" ? turnA(s, ctx)
      : marker === "TURN_B" ? recallTurn(s, ctx, [MEMORY_FACT_FILE])
      : marker === "TURN_C" ? recallTurn(s, ctx, [MEMORY_FACT_FILE, "after-restart.md"])
      : { text: `UNEXPECTED_TURN ${marker}` };
    replies.push({ marker, reply });
    return reply;
  }, { localSandbox: true });
  const f = fixture;
  const api = async (path: string, init: { method?: string; body?: unknown; form?: FormData } = {}) => {
    const response = await fetch(f.baseURL + path, {
      method: init.method ?? (init.body === undefined && init.form === undefined ? "GET" : "POST"),
      headers: { ...BETA, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.form ? { body: init.form } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return response;
  };
  const json = async (path: string, init: { method?: string; body?: unknown; form?: FormData } = {}) => {
    const response = await api(path, init);
    const text = await response.text();
    expect(response.ok, `${path}: ${response.status} ${text}`).toBe(true);
    return JSON.parse(text) as any;
  };

  // Skill package with a bundled relative script and data file.
  const form = new FormData();
  for (const file of SKILL_FILES) form.append("files[]", new File([file.content], file.name, { type: "text/plain" }));
  const skill = await json("/v1/skills", { form });
  const rwStore = await json("/v1/memory_stores", { body: { name: "notes-rw", description: "Agent notes" } });
  const roStore = await json("/v1/memory_stores", { body: { name: "notes-ro", description: "Reference only" } });
  const seeded = await json(`/v1/memory_stores/${roStore.id}/memories`, { body: { path: `/${READONLY_SEED_FILE}`, content: READONLY_SEED } });
  scenario.value = {
    skillId: skill.id, rwNames: ["notes-rw", rwStore.id], roNames: ["notes-ro", roStore.id],
    ...(mode === "diagnostic" ? { memoryHints: { rw: "/mnt/memory/notes-rw", ro: "/mnt/memory/notes-ro" }, hintUses } : {}),
  };

  const environment = await json("/v1/environments", { body: { name: "resource-use", config: { type: "cloud", networking: { type: "unrestricted" } } } });
  const agent = await json("/v1/agents", { body: {
    name: "resource-use", model: MODEL, system: "You are a careful agent.",
    tools: [{ type: "agent_toolset_20260401" }],
    skills: [{ type: "custom", skill_id: skill.id, version: "latest" }],
  } });
  const session = await json("/v1/sessions", { body: {
    agent: agent.id, environment_id: environment.id,
    resources: [
      { type: "memory_store", memory_store_id: rwStore.id, access: "read_write" },
      { type: "memory_store", memory_store_id: roStore.id, access: "read_only" },
    ],
  } });
  const eventsPath = `/v1/sessions/${session.id}/events`;
  const history = async () => (await json(`${eventsPath}?limit=1000&order=asc`)).data as any[];
  const endTurns = async () => (await history()).filter((e) => e.type === "session.status_idle").map((e) => e.stop_reason?.type);
  const runTurn = async (marker: string, expectedIdle: number) => {
    await json(eventsPath, { body: { events: [{ type: "user.message", content: [{ type: "text", text: `${marker}: go` }] }] } });
    await expect.poll(async () => (await endTurns()).length, { timeout: 90_000, interval: 250 }).toBeGreaterThanOrEqual(expectedIdle);
    expect((await endTurns()).at(-1), `turn ${marker} stop_reason`).toBe("end_turn");
  };
  const memoryBytes = async (storeId: string, path: string) => {
    const page = await json(`/v1/memory_stores/${storeId}/memories?limit=100`);
    const item = (page.data as any[]).find((m) => m.path === path);
    if (!item) return null;
    const memory = await json(`/v1/memory_stores/${storeId}/memories/${item.id}?view=full`);
    return { content: memory.content as string, sha: memory.content_sha256 as string };
  };
  const finalTexts = (marker: string) => replies.filter((r) => r.marker === marker && "text" in r.reply).map((r) => (r.reply as { text: string }).text);

  // ── Turn A ────────────────────────────────────────────────────────────
  await runTurn("TURN_A", 1);
  const discovery = replies.filter((r) => "text" in r.reply && r.reply.text.startsWith("DISCOVERY_FAILED"));
  expect(discovery.map((r) => (r.reply as { text: string }).text), "model-visible guidance must let the agent find every resource").toEqual([]);
  expect(finalTexts("TURN_A")).toEqual(["TURN_A_DONE readonly-refused-observed"]);

  const eventsA = await history();
  const uses = eventsA.filter((e) => e.type === "agent.tool_use");
  const resultFor = (id: string) => eventsA.filter((e) => e.type === "agent.tool_result" && e.tool_use_id === id);
  expect(uses.map((u) => u.name)).toEqual(["read", "bash", "bash", "write", "write"]);
  // Skill read: the manifest bytes the agent saw are the uploaded ones.
  expect(JSON.stringify(resultFor(uses[0].id)[0].content)).toContain("make-report.sh");
  // Negative control: the same relative command outside the Skill dir fails.
  expect(JSON.stringify(resultFor(uses[1].id)[0].content)).toMatch(/scripts\/make-report\.sh|not run from the skill directory/u);
  expect(JSON.stringify(resultFor(uses[2].id)[0].content)).toContain(`make-report wrote`);
  // Read-only: exactly one result for the original call id, an error.
  const roUse = uses[4];
  expect(JSON.stringify(roUse), "read-only write targets the read-only store").toMatch(new RegExp(`notes-ro|${roStore.id}`, "u"));
  const roResults = resultFor(roUse.id);
  expect(roResults, "exactly one tool_result for the read-only write call id").toHaveLength(1);
  expect(roResults[0].is_error).toBe(true);
  // The model actually observed that error on the next request, by call id.
  const lastA = f.requests.filter((r) => currentTurn(r).marker === "TURN_A").at(-1)!;
  const observed = currentTurn(lastA).ctx.results.at(-1) as { isError: boolean; toolUseId?: string };
  expect(observed.isError).toBe(true);
  expect(eventsA.some((e) => e.type === "session.error")).toBe(false);

  // Outputs: production collection/download returns the exact script bytes.
  const outputs = await json(`/v1/sessions/${session.id}/outputs`);
  const names = (outputs.data as any[]).map((o) => o.filename);
  expect(names).toContain(REPORT_FILENAME);
  expect(names, "wrong-context negative control must not produce an output").not.toContain(WRONG_CONTEXT_FILENAME);
  const download = await api(`/v1/sessions/${session.id}/outputs/${REPORT_FILENAME}`);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(EXPECTED_REPORT, "utf8"))).toBe(true);

  // Memory: independent REST readback of the authoritative store.
  expect(await memoryBytes(rwStore.id, `/${MEMORY_FACT_FILE}`)).toEqual({ content: MEMORY_FACT, sha: sha256(MEMORY_FACT) });
  expect(await memoryBytes(roStore.id, `/${READONLY_SEED_FILE}`)).toEqual({ content: READONLY_SEED, sha: sha256(READONLY_SEED) });
  expect(seeded.content_sha256 ?? sha256(READONLY_SEED)).toBe(sha256(READONLY_SEED));

  // ── Turn B: subsequent turn reads the exact persisted bytes ─────────────
  await runTurn("TURN_B", 2);
  const recalledB = f.requests.filter((r) => currentTurn(r).marker === "TURN_B").at(-1)!;
  expect(decodeMarkedBase64(currentTurn(recalledB).ctx.results[0]!.text)).toBe(MEMORY_FACT);

  // ── Owner restart ──────────────────────────────────────────────────────
  await f.restart();
  expect(await memoryBytes(rwStore.id, `/${MEMORY_FACT_FILE}`)).toEqual({ content: MEMORY_FACT, sha: sha256(MEMORY_FACT) });
  expect(await memoryBytes(roStore.id, `/${READONLY_SEED_FILE}`), "read-only bytes unchanged after restart").toEqual({ content: READONLY_SEED, sha: sha256(READONLY_SEED) });
  expect(READONLY_MUTATION).not.toBe(READONLY_SEED);
  // Authoritative change made only through the API after restart: turn C
  // must see it, proving the sandbox view is restored from the store and not
  // from a retained local copy.
  const afterRestart = "written via REST after owner restart → ok";
  await json(`/v1/memory_stores/${rwStore.id}/memories`, { body: { path: "/after-restart.md", content: afterRestart } });

  // ── Turn C after restart ────────────────────────────────────────────────
  await runTurn("TURN_C", 3);
  const recalledC = currentTurn(f.requests.filter((r) => currentTurn(r).marker === "TURN_C").at(-1)!).ctx.results;
  expect(decodeMarkedBase64(recalledC[0]!.text)).toBe(MEMORY_FACT);
  expect(decodeMarkedBase64(recalledC[1]!.text)).toBe(afterRestart);
  const again = await api(`/v1/sessions/${session.id}/outputs/${REPORT_FILENAME}`);
  expect(Buffer.from(await again.arrayBuffer()).equals(Buffer.from(EXPECTED_REPORT, "utf8"))).toBe(true);
  console.log(JSON.stringify({ op: "resource_convergence.node.scenario", mode, session_id: session.id, memory_hint_uses: hintUses, model_requests: f.requests.length }));
  if (mode === "acceptance") expect(hintUses).toEqual([]);
}
