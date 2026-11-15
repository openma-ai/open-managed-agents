import { describe, expect, it, vi } from "vitest";
import { lifecycleFixture, lifecycleWorker } from "./session-lifecycle-parity-worker.helper";
type Fixture=Awaited<ReturnType<typeof lifecycleFixture>>;
async function history(f:Fixture){await f.message("durable-input");await f.claim(false);}
async function supervisor(f:Fixture,prompt:(text:string)=>AsyncGenerator<any>,executionToken?:string){return lifecycleWorker(f,{prompt},undefined,executionToken);}

describe("main lifecycle parity: real budget and rebuilt runtime", () => {
  // main runner d45d7dc:1186-1204 requires thread idle -> usage -> idle(budget_reached).
  // The provider is fake; gateway auth, durable meter, budget update and event
  // transport are real. Raising the cap never fabricates a resume command here.
  it.each(["pause", "resume"] as const)("real proxy 402 reaches Session lifecycle: %s", async branch => {
    const f = await lifecycleFixture({ type: "limit", max_list_cost: { amount: "1", currency: "USD" } }); let active: Awaited<ReturnType<typeof supervisor>> | undefined;
    let upstreamCalls = 0, prompts = 0; const statuses: number[] = [];
    vi.stubGlobal("fetch", async (raw: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(raw, init);
      if (new URL(req.url).hostname !== "provider.test") throw new Error("unexpected external request");
      upstreamCalls++; return Response.json({ usage: { input_tokens: 10000, output_tokens: 0 } });
    });
    try {
      await f.api("/v1/oma/model_cards", { model_id: "unpriced-test-model", model: "upstream", provider: "anthropic", base_url: "https://provider.test", api_key: "fake-local-provider-key",
        pricing: { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" } });
      upstreamCalls = 0;
      await history(f);
      const sandbox=await f.prepareSandbox();
      const token=await sandbox.workToken(); // actual issued physical holder, not an unbound test token
      const call = async () => {
        const response = await f.cp.fetch(new Request("https://parity.test/v1/oma/inference-proxy/" + f.session.id + "/anthropic/v1/messages", {
          method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ model: "unpriced-test-model", messages: [] }),
        }));
        statuses.push(response.status); await response.text(); return response.status;
      };
      active = await supervisor(f, async function* () {
        prompts++;
        yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "model turn" } };
        if (prompts === 1) { await call(); await call(); }
        else await call();
        // ACP completes normally after its model gateway refuses further spend.
        yield { type: "promptComplete", response: {} };
      }, token);
      await active.waitFor(() => statuses,[200,402]);
      expect(upstreamCalls).toBe(1);
      await expect.poll(async () => (await f.events()).some(e => e.type === "session.status_idle"), { timeout: 2000 }).toBe(true);
      if (branch === "pause") {
        expect((await f.events()).filter(e => e.type === "session.status_idle").at(-1).stop_reason).toEqual({ type: "budget_reached" });
        expect((await f.api("/v1/sessions/" + f.session.id)).status).toBe("idle");
      } else {
        await f.api("/v1/sessions/" + f.session.id, { budget: { type: "limit", max_list_cost: { amount: "3", currency: "USD" } } });
        await active.waitFor(() => prompts,2);
        // prompts counts the start of turn 2; its gateway status is recorded
        // only once that call returns. Wait for the evidence, not the start.
        await active.waitFor(() => statuses,[200, 402, 200]);
        expect(statuses).toEqual([200, 402, 200]);
        expect(upstreamCalls).toBe(2);
        expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
      }
    } finally { await active?.stop(); vi.unstubAllGlobals(); await f.dispose(); }
  });

  // CI 43026796904: the budget raise above landed between terminal commit and
  // work-publish, advancing the Session revision; publication was refused as
  // terminal_revision and the runner died with "work-publish rejected (409)".
  // Force that interleaving deterministically for any ordinary Session update.
  it.each(["metadata", "budget"] as const)("a Session %s update between terminal commit and publication still publishes the committed turn", async variant => {
    const realFetch = globalThis.fetch; let f: Fixture | undefined; let active: Awaited<ReturnType<typeof supervisor>> | undefined;
    let raced = 0; let updateStatus = 0;
    // Installed before the fixture so its native transport (the runner's) is observed.
    vi.stubGlobal("fetch", async (raw: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(raw, init);
      if (raced === 0 && f !== undefined && new URL(request.url).pathname.endsWith("/work-publish")) {
        raced++;
        const update = variant === "metadata" ? { metadata: { raced: "publication" } } : { budget: { type: "limit", max_list_cost: { amount: "5", currency: "USD" } } };
        const response = await realFetch(new Request(f.base + "/v1/sessions/" + f.session.id, { method: "POST", headers: { "x-api-key": "parity-admin", "content-type": "application/json" }, body: JSON.stringify(update) }));
        updateStatus = response.status; await response.text();
      }
      return realFetch(request);
    });
    try {
      f = await lifecycleFixture(variant === "budget" ? { type: "limit", max_list_cost: { amount: "1", currency: "USD" } } : undefined);
      await history(f);
      let effects = 0;
      active = await supervisor(f, async function* () { effects++; yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "committed effect" } }; yield { type: "promptComplete", response: {} }; });
      await active.waitFor(() => active!.responses.filter(r => r.action === "work-publish").map(r => [r.status, (r.body as { type?: string })?.type, (r.body as { reason?: string })?.reason ?? null]),
        [[409, "rejected", "terminal_revision"], [200, "published", null]], 5000);
      expect(raced).toBe(1); expect(updateStatus).toBe(200);
      // The runner survived publication and its terminal is the single canonical one.
      expect(await Promise.race([active.result.then(() => "exited"), new Promise(resolve => setTimeout(() => resolve("resident"), 300))])).toBe("resident");
      expect(effects).toBe(1);
      expect((await f.events()).filter(e => e.type === "session.status_idle").map(e => e.stop_reason)).toEqual([{ type: "end_turn" }]);
      expect((await f.events()).filter(e => e.type === "agent.message")).toHaveLength(1);
    } finally { await active?.stop(); vi.unstubAllGlobals(); await f?.dispose(); }
  });

  it("rebuilding supervisor and native runtime after canonical terminal never repeats the completed effect", async () => {
    const f = await lifecycleFixture(); let first: Awaited<ReturnType<typeof supervisor>> | undefined, second: Awaited<ReturnType<typeof supervisor>> | undefined;
    let effects = 0;
    try {
      await history(f);
      const prompt = async function* () { effects++; yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "durable effect" } }; yield { type: "promptComplete", response: {} }; };
      first = await supervisor(f, prompt);
      await first.waitFor(async () => (await f.events()).filter(e => e.type === "session.status_idle").length,1);
      await first.published();
      await first.stop(); first = undefined;
      // Fresh app/runtime/native-state instance; only the canonical SQL log remains.
      await f.reclaim();
      second = await supervisor(f, prompt);
      await second.residentAfterPublish();

      expect(effects).toBe(1);
      expect((await f.events()).filter(e => e.type === "agent.message")).toHaveLength(1);
      expect((await f.events()).filter(e => e.type === "session.status_idle")).toHaveLength(1);
    } finally { await first?.stop(); await second?.stop(); await f.dispose(); }
  });

  it("a durable failed turn with observable output is not blindly replayed after rebuilding the runtime", async () => {
    const f = await lifecycleFixture(); let first: Awaited<ReturnType<typeof supervisor>> | undefined, second: Awaited<ReturnType<typeof supervisor>> | undefined;
    let effects = 0;
    try {
      await history(f);
      const prompt = async function* () {
        effects++;
        yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "effect before connection loss" } };
        yield { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "flush effect" } };
        throw new Error("upstream outcome unknown after effect");
      };
      first = await supervisor(f, prompt);
      await first.waitFor(async () => (await f.events()).some(e => e.type === "session.error"),true);
      expect((await f.events()).filter(e => e.type === "agent.message")).toHaveLength(1);
      await first.published(false);
      await first.stop(); first = undefined;
      await f.reclaim();
      second = await supervisor(f, prompt);
      await second.residentAfterPublish();

      expect(effects).toBe(1);
      expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
      // The published receipt stays the canonical exhausted terminal; it is not replaced by a rerun.
      expect((await f.events()).filter(e => e.type === "session.status_idle").map(e => e.stop_reason)).toEqual([{ type: "retries_exhausted" }]);
      expect((await f.events()).filter(e => e.type === "agent.message")).toHaveLength(1);
    } finally { await first?.stop(); await second?.stop(); await f.dispose(); }
  });
});
