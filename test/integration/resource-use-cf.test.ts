// Cloudflare SessionDO: agent-observed Skill / Memory / outputs behavior.
//
// EVIDENCE LEVELS (see docs/resource-semantics.md):
// - Real: SessionDO (processUserMessage, warmup, Skill materialization,
//   mount planning, prompt composition), D1, the default Pi loop and tool
//   error path, the production Session outputs route reading miniflare R2.
// - Deterministic model fixture: pi faux provider; it decides tool calls only
//   from the prompt/tool results the real harness gave it (no paid inference).
// - FIXTURE FUSE (not CF containers): workerd cannot run a container, so the
//   provider runtime's file IO is served by an in-test filesystem. Its mount
//   table is exactly what SessionDO asked `provisionSandbox` to mount (path,
//   R2 prefix, readOnly); writes under a read-only mount fail with EROFS and
//   writes under a read-write mount are PUT to the real miniflare R2 binding
//   at that mount's prefix (the s3fs behavior). Agent-issued bundled scripts
//   execute through a loopback Node subprocess bridge using materialized bytes.
//   Canonical Memory reconciliation/readback is exercised,
//   including owner restart against local Miniflare storage. Native FUSE
//   durability is NOT claimed; the script bridge is not a CF container.
import { OAUTH_MCP_TEST_PORT } from "../fixtures/oauth-mcp-local-endpoint";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../packages/agent-harness/node_modules/@earendil-works/pi-ai/dist/index.js";
import { afterEach, beforeAll, expect, it } from "vitest";
import { PiHarness } from "../../packages/agent-harness/src/pi-loop";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { ensureModelCards } from "./_model-cards";
import {
  EXPECTED_REPORT, MEMORY_FACT, MEMORY_FACT_FILE, READONLY_MUTATION, READONLY_SEED, READONLY_SEED_FILE, REPORT_FILENAME, SKILL_FILES, SKILL_MD,
  discoverMemoryPath, discoverOutputsDir, discoverSkillManifest, shq,
} from "../resource-convergence/resource-agent-fixture";

const MODEL = "resource-use-cf-local";
beforeAll(() => ensureModelCards([MODEL]));

type Mount = { bucket: string; mountPath: string; options: { prefix?: string; readOnly?: boolean } };
type PiMessage = { role: string; content?: unknown; toolCallId?: string; isError?: boolean };
type PiContext = { systemPrompt?: string; messages: PiMessage[] };

function systemText(context: PiContext): string {
  return [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m))].join("\n");
}
function toolResults(context: PiContext): Array<{ id?: string; text: string; isError: boolean }> {
  const lastUser = context.messages.map((m) => m.role).lastIndexOf("user");
  return context.messages.slice(lastUser + 1).filter((m) => m.role === "toolResult").map((m) => ({
    id: m.toolCallId, isError: m.isError === true,
    text: Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("\n") : String(m.content ?? ""),
  }));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

it("CF SessionDO: agent reads the materialized Skill at the advertised path, writes outputs/Memory at advertised mounts, and continues after a read-only EROFS by call id", async () => {
  const id = crypto.randomUUID();
  const decisions: string[] = [];
  const observed: Array<{ step: number; results: ReturnType<typeof toolResults> }> = [];
  let skillId = "";
  let phase: "write" | "next-turn" | "restored" = "write";
  let rwNames: string[] = [], roNames: string[] = [];
  const decide = (context: PiContext) => {
    const system = systemText(context);
    const results = toolResults(context);
    observed.push({ step: results.length, results });
    const step = results.length;
    if (phase !== "write") {
      const rw = discoverMemoryPath(system, rwNames);
      if (step === 0) return rw
        ? fauxAssistantMessage([fauxToolCall("read", { file_path: `${rw}/${MEMORY_FACT_FILE}` }, { id: `cf_${phase}_read` })], { stopReason: "toolUse" })
        : fauxAssistantMessage("DISCOVERY_FAILED:recall_path");
      return fauxAssistantMessage(!results[0]!.isError && results[0]!.text.includes(MEMORY_FACT)
        ? `CF_RECALL_OK:${phase}` : `CF_RECALL_FAILED:${phase}`);
    }
    const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args, { id: `cf_${step}_${name}` })], { stopReason: "toolUse" });
    if (step === 0) {
      const manifest = discoverSkillManifest(system, skillId);
      decisions.push(manifest ? `manifest:${manifest}` : "DISCOVERY_FAILED:skill_manifest");
      return manifest ? call("read", { file_path: manifest }) : fauxAssistantMessage("DISCOVERY_FAILED:skill_manifest");
    }
    if (step === 1) {
      const outputs = discoverOutputsDir(system);
      decisions.push(outputs ? `outputs:${outputs}` : "DISCOVERY_FAILED:outputs_dir");
      const manifest = discoverSkillManifest(system, skillId);
      const command = /`(sh scripts\/[^`<]+)<output-file>`/u.exec(results[0]!.text)?.[1]?.trim();
      if (!manifest || !command || !outputs) return fauxAssistantMessage("DISCOVERY_FAILED:skill_command");
      return call("bash", { command: `cd ${shq(manifest.slice(0, -"/SKILL.md".length))} && ${command} ${outputs}/${REPORT_FILENAME}` });
    }
    if (step === 2) {
      const rw = discoverMemoryPath(system, rwNames);
      decisions.push(rw ? `rw:${rw}` : "DISCOVERY_FAILED:memory_read_write_path");
      return rw ? call("write", { file_path: `${rw}/${MEMORY_FACT_FILE}`, content: MEMORY_FACT }) : fauxAssistantMessage("DISCOVERY_FAILED:memory_read_write_path");
    }
    if (step === 3) {
      const ro = discoverMemoryPath(system, roNames);
      decisions.push(ro ? `ro:${ro}` : "DISCOVERY_FAILED:memory_read_only_path");
      return ro ? call("write", { file_path: `${ro}/${READONLY_SEED_FILE}`, content: READONLY_MUTATION }) : fauxAssistantMessage("DISCOVERY_FAILED:memory_read_only_path");
    }
    return fauxAssistantMessage(results.at(-1)!.isError ? "CF_DONE readonly-refused-observed" : "CF_DONE readonly-write-NOT-refused");
  };
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(Array.from({ length: 20 }, () => decide as never));
  const models = createModels(); models.setProvider(faux.provider);
  const harness = `resource-use-cf-${id}`;
  registerHarness(harness, () => ({ async run(ctx) { await new PiHarness().run({ ...ctx, pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" } }); } }));

  const request = async (path: string, init: { body?: unknown; form?: FormData } = {}) => {
    const response = await exports.default.fetch(new Request(`http://localhost${path}`, {
      method: init.body === undefined && init.form === undefined ? "GET" : "POST",
      headers: { "x-api-key": "test-key", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.form ? { body: init.form } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }));
    return response;
  };
  const json = async (path: string, init: { body?: unknown; form?: FormData } = {}) => {
    const response = await request(path, init); const text = await response.text();
    expect(response.ok, `${path}: ${response.status} ${text}`).toBe(true); return JSON.parse(text) as any;
  };

  const form = new FormData();
  for (const file of SKILL_FILES) form.append("files[]", new File([file.content], file.name, { type: "text/plain" }));
  const skill = await json("/v1/skills", { form });
  skillId = skill.id;
  const rwStore = await json("/v1/memory_stores", { body: { name: `cf-rw-${id.slice(0, 8)}` } });
  const roStore = await json("/v1/memory_stores", { body: { name: `cf-ro-${id.slice(0, 8)}` } });
  const seeded = await json(`/v1/memory_stores/${roStore.id}/memories`, { body: { path: `/${READONLY_SEED_FILE}`, content: READONLY_SEED } });
  const authoritativeContent = async (storeId: string, filename: string) => {
    const page = await json(`/v1/memory_stores/${storeId}/memories?limit=100`);
    const item = page.data.find((entry: any) => entry.path === `/${filename}`);
    expect(item, `canonical memory ${storeId}/${filename}`).toBeDefined();
    const memory = await json(`/v1/memory_stores/${storeId}/memories/${item.id}?view=full`);
    return memory.content;
  };
  rwNames = [rwStore.name, rwStore.id]; roNames = [roStore.name, roStore.id];
  const agent = await json("/v1/agents", { body: {
    name: harness, model: MODEL, system: "You are a careful agent.", _oma: { harness },
    tools: [{ type: "agent_toolset_20260401" }], skills: [{ type: "custom", skill_id: skill.id, version: "latest" }],
  } });
  const environment = await json("/v1/environments", { body: { name: harness, config: { type: "cloud" } } });
  const session = await json("/v1/sessions", { body: {
    agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environment.id,
    resources: [
      { type: "memory_store", memory_store_id: rwStore.id, access: "read_write" },
      { type: "memory_store", memory_store_id: roStore.id, access: "read_only" },
    ],
  } });

  // Fixture FUSE at the provider runtime boundary (see header).
  const mounts: Mount[] = [];
  const disk = new Map<string, Uint8Array>();
  const writes: Array<{ path: string; outcome: string }> = [];
  const mountFor = (path: string) => mounts.find((m) => path === m.mountPath || path.startsWith(`${m.mountPath}/`));
  const bucketFor = (m: Mount) => (m.mountPath.startsWith("/mnt/memory/") ? env.MEMORY_BUCKET : env.FILES_BUCKET) as R2Bucket;
  const keyFor = (m: Mount, path: string) => `${(m.options.prefix ?? "").replace(/^\/+/u, "")}${path.slice(m.mountPath.length + 1)}`;
  const put = async (path: string, bytes: Uint8Array) => {
    const m = mountFor(path);
    if (m?.options.readOnly) { writes.push({ path, outcome: "EROFS" }); throw new Error(`EROFS: read-only file system, open '${path}'`); }
    if (m) { await bucketFor(m).put(keyFor(m, path), bytes); writes.push({ path, outcome: `r2:${keyFor(m, path)}` }); return; }
    disk.set(path, bytes); writes.push({ path, outcome: "disk" });
  };
  const get = async (path: string): Promise<Uint8Array | null> => {
    const m = mountFor(path);
    if (m) { const object = await bucketFor(m).get(keyFor(m, path)); return object ? new Uint8Array(await object.arrayBuffer()) : null; }
    return disk.get(path) ?? null;
  };
  let stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  const bindProvider = () => runInDurableObject(stub, async (instance: any) => {
    await instance._sandboxWarm;
    // Inert fixture bucket name (the wrangler.test MEMORY_BUCKET binding is
    // "test-memory"); production refuses Memory without it, which is correct.
    instance.env.MEMORY_BUCKET_NAME ??= "test-memory";
    instance.ensureSandboxCreated();
    const runtime = instance.portsSandbox.state.options.executor();
    if (runtime.env && runtime.env !== instance.env) runtime.env.MEMORY_BUCKET_NAME ??= "test-memory";
    const provision = runtime.provisionSandbox.bind(runtime);
    runtime.provisionSandbox = async (input: { mounts: Mount[] }) => { mounts.push(...input.mounts); return provision(input); };
    runtime.writeFileBytes = async (path: string, bytes: Uint8Array) => { await put(path, bytes); return "ok"; };
    runtime.writeFile = async (path: string, content: string) => { await put(path, new TextEncoder().encode(content)); return "ok"; };
    const originalExec = runtime.exec.bind(runtime);
    runtime.exec = async (command: string, ...args: unknown[]) => {
      const match = /^cd '([^']+)' && sh scripts\/make-report\.sh (\S+)$/u.exec(command);
      if (!match) return originalExec(command,...args);
      const script = await get(`${match[1]}/scripts/make-report.sh`), seed = await get(`${match[1]}/data/seed.txt`);
      if (!script || !seed) throw Error("Materialized Skill script/data missing at agent-discovered path");
      const response = await fetch(`http://127.0.0.1:${OAUTH_MCP_TEST_PORT+1}/${id}/resource-script`,{method:"POST",body:JSON.stringify({script:new TextDecoder().decode(script),seed:Buffer.from(seed).toString("base64"),correctContext:true})});
      if (!response.ok) throw Error(`Resource script bridge failed (${response.status})`);
      const result = await response.json() as {exitCode:number;stdout:string;stderr:string;bytes:string|null};
      console.log(JSON.stringify({op:"resource.cf.script_execution",command,exitCode:result.exitCode,bytes:result.bytes===null?0:Buffer.from(result.bytes,"base64").length}));
      if (result.exitCode===0 && result.bytes!==null) await put(match[2]!,Buffer.from(result.bytes,"base64"));
      return `exit=${result.exitCode}\n${result.stdout}${result.stderr}`;
    };
    runtime.readFile = async (path: string) => {
      const bytes = await get(path);
      if (bytes === null) throw new Error(`readFile(${path}) failed: ENOENT`);
      return new TextDecoder().decode(bytes);
    };
  });
  await bindProvider();
  cleanups.push(async () => {
    await runInDurableObject(stub, async (instance: any, state: any) => {
      await instance._recoveryPromise; await instance._recoveryRun; await instance._finalizePromise;
      await Promise.all(instance._maintenanceRuns.values()); await state.storage.deleteAlarm();
    });
  });

  await json(`/v1/sessions/${session.id}/events`, { body: { events: [{ type: "user.message", content: [{ type: "text", text: "use the report kit" }] }] } });
  const history = async () => (await json(`/v1/sessions/${session.id}/events?limit=1000&order=asc`)).data as any[];
  await expect.poll(async () => (await history()).some((e) => e.type === "session.status_idle"), { timeout: 20_000 }).toBe(true);
  const events = await history();
  const diagnostics = JSON.stringify({ decisions, mounts: mounts.map((m) => ({ path: m.mountPath, readOnly: m.options.readOnly === true })), writes });

  expect(decisions.filter((d) => d.startsWith("DISCOVERY_FAILED")), `model-visible guidance must let the agent find every resource ${diagnostics}`).toEqual([]);
  expect(events.filter((e) => e.type === "session.status_idle").map((e) => e.stop_reason?.type), diagnostics).toEqual(["end_turn"]);
  expect(events.some((e) => e.type === "session.error"), diagnostics).toBe(false);

  // Skill: what the agent read at the advertised path is the uploaded manifest,
  // i.e. the prompt points where SessionDO actually materialized it.
  expect(observed.find((o) => o.step === 1)!.results[0]!.text, diagnostics).toContain(SKILL_MD.split("\n")[7]!);
  // Advertised Memory paths are exactly the mounts SessionDO requested, with the declared modes.
  const rwPath = decisions.find((d) => d.startsWith("rw:"))!.slice(3);
  const roPath = decisions.find((d) => d.startsWith("ro:"))!.slice(3);
  expect(mounts.find((m) => m.mountPath === rwPath)?.options, diagnostics).toMatchObject({ prefix: expect.stringMatching(new RegExp(`^/\\.openma-managed-memory-workspaces/default/${session.id}/[^/]+/${rwStore.id}/data/$`)), readOnly: false });
  expect(mounts.find((m) => m.mountPath === roPath)?.options, diagnostics).toMatchObject({ prefix: expect.stringMatching(new RegExp(`^/\\.openma-managed-memory-snapshots/default/${roStore.id}/[a-f0-9]{64}/$`)), readOnly: true });
  // Read-only mutation: one error result for the original call id, observed, then continuation.
  const roUse = events.find((e) => e.type === "agent.tool_use" && JSON.stringify(e).includes(roPath));
  const roResults = events.filter((e) => e.type === "agent.tool_result" && e.tool_use_id === roUse?.id);
  expect(roResults, diagnostics).toHaveLength(1);
  expect(roResults[0].is_error).toBe(true);
  expect(observed.at(-1)!.results.at(-1), diagnostics).toMatchObject({ id: roUse.id, isError: true });
  expect(await authoritativeContent(roStore.id, READONLY_SEED_FILE)).toBe(READONLY_SEED);
  // Read-write Memory landed in the store's R2 prefix with exact bytes.
  expect(await authoritativeContent(rwStore.id, MEMORY_FACT_FILE)).toBe(MEMORY_FACT);
  console.log(JSON.stringify({ op: "resource.cf.script", calls: events.filter(e => e.type === "agent.tool_use" && e.name === "bash"), results: observed.find(o => o.step === 2)?.results }));
  expect(observed.find(o => o.step === 2)!.results[1]!.isError).toBe(false);
  expect(observed.find(o => o.step === 2)!.results[1]!.text).toContain("make-report wrote");
  // Outputs: production route returns the exact bytes produced by the script.
  const download = await request(`/v1/sessions/${session.id}/outputs/${REPORT_FILENAME}`);
  expect(download.status, diagnostics).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(new TextEncoder().encode(EXPECTED_REPORT));

  const settle = async () => {
    await expect.poll(async () => Number((await env.MAIN_DB.prepare("SELECT COUNT(*) AS n FROM managed_session_executions WHERE session_id=? AND state IN ('queued','running')").bind(session.id).first() as any).n), { timeout: 20_000 }).toBe(0);
    await runInDurableObject(stub, async (instance: any, state: any) => {
      await instance._finalizePromise; await instance._recoveryPromise; await instance._recoveryRun;
      await Promise.all(instance._maintenanceRuns.values()); await state.storage.deleteAlarm();
    });
  };
  const recall = async (name: "next-turn" | "restored", count: number) => {
    phase = name;
    await json(`/v1/sessions/${session.id}/events`, { body: { events: [{ type: "user.message", content: [{ type: "text", text: `recall Memory ${name}` }] }] } });
    await expect.poll(async () => (await history()).filter(e => e.type === "session.status_idle").length, { timeout: 20_000 }).toBe(count);
    await settle();
    const after = await history();
    console.log(JSON.stringify({ op: "resource.cf.recall", phase, mounts: mounts.map(m => ({ path: m.mountPath, prefix: m.options.prefix, readOnly: m.options.readOnly })), results: observed.at(-1)?.results, terminal: after.filter(e => e.type === "session.status_idle").map(e => e.stop_reason), authoritative: await authoritativeContent(rwStore.id, MEMORY_FACT_FILE) }));
    expect(after.filter(e => e.type === "session.status_idle").map(e => e.stop_reason?.type)).toEqual(Array(count).fill("end_turn"));
    expect(after.filter(e => e.type === "session.error")).toEqual([]);
    const replies = after.filter(e => e.type === "agent.tool_result" && e.tool_use_id === `cf_${name}_read`);
    expect(replies).toHaveLength(1);
    expect(replies[0].is_error).not.toBe(true);
    expect(observed.at(-1)!.results[0]!.text).toBe(MEMORY_FACT);
    expect(after.some(e => e.type === "agent.message" && JSON.stringify(e.content).includes(`CF_RECALL_OK:${name}`))).toBe(true);
    expect(await authoritativeContent(rwStore.id, MEMORY_FACT_FILE)).toBe(MEMORY_FACT);
    expect(await authoritativeContent(roStore.id, READONLY_SEED_FILE)).toBe(READONLY_SEED);
  };
  await settle();
  await recall("next-turn", 2);
  console.log(JSON.stringify({ op: "resource.cf.owner_abort", session_id: session.id, mounts: mounts.map(m => ({ path: m.mountPath, prefix: m.options.prefix, readOnly: m.options.readOnly })), diskFiles: disk.size }));
  await runInDurableObject(stub, async (instance: any) => { await instance.portsSandbox.state.options.executor().destroy(); });
  await expect(runInDurableObject(stub, (_instance: any, state: any) => state.abort("resource contract owner restart"))).rejects.toThrow();
  // Drop every simulated provider-local byte and mount receipt. Recovery must
  // rematerialize from canonical persistence, never from this fixture's cache.
  disk.clear(); mounts.splice(0);
  stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  await bindProvider();
  await recall("restored", 3);
  const restoredDownload = await request(`/v1/sessions/${session.id}/outputs/${REPORT_FILENAME}`);
  expect(restoredDownload.status).toBe(200);
  expect(new Uint8Array(await restoredDownload.arrayBuffer())).toEqual(new TextEncoder().encode(EXPECTED_REPORT));

}, 60_000);
