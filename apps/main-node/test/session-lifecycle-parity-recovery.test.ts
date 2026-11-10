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
        expect(statuses).toEqual([200, 402, 200]);
        expect(upstreamCalls).toBe(2);
        expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
      }
    } finally { await active?.stop(); vi.unstubAllGlobals(); await f.dispose(); }
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
      const recovered=await second.result;
      expect(second.responses.some(r=>r.action==="work-publish"&&r.status===200)).toBe(true);
      expect(recovered).toEqual({ok:true});

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
      const recovered=await second.result;
      expect(second.responses.some(r=>r.action==="work-publish"&&r.status===200)).toBe(true);
      expect(recovered).toMatchObject({error:expect.objectContaining({message:expect.stringContaining("retries_exhausted")})});

      expect(effects).toBe(1);
      expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
    } finally { await first?.stop(); await second?.stop(); await f.dispose(); }
  });
});
