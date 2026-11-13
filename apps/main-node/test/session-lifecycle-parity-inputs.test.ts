import { describe, expect, it } from "vitest";
import { lifecycleFixture as fixture, lifecycleWorker } from "./session-lifecycle-parity-worker.helper";
async function startSupervisor(f:Awaited<ReturnType<typeof fixture>>,hooks:{prompt(text:string):Promise<void>;steer?(text:string):Promise<void>}) {
 const worker=lifecycleWorker(f,{async *prompt(text){await hooks.prompt(text);yield {type:"promptComplete",response:{}};},steer:hooks.steer});
 return {run:{stop:async(_reason:string)=>worker.stop()},completion:worker.result,worker};
}

describe("main lifecycle parity through production Node HTTP + ACP supervisor", () => {
  // main application.ts:270-303: budget interrupt is the only filtered receipt.
  // RA accepts/persists interrupt, while mixed interrupt+message rejects atomically.
  it("retains an idle requires_action interrupt receipt without closing pending tools", async () => {
    const f = await fixture();
    try {
      await f.claim();
      const stamp = new Date().toISOString();
      await f.publish([
        { id: "pending-call", type: "agent.custom_tool_use", name: "approval", input: {}, processed_at: stamp },
        { id: "parked", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["pending-call"] }, processed_at: stamp },
      ]);
      const receipt = await f.api("/v1/sessions/" + f.session.id + "/events", { events: [{ type: "user.interrupt" }] });
      expect(receipt.data).toMatchObject([{ type: "user.interrupt", id: expect.any(String) }]);
      const persisted = await f.events();
      expect(persisted.filter(e => e.type === "user.interrupt")).toHaveLength(1);
      expect(persisted.filter(e => ["agent.tool_result", "agent.mcp_tool_result", "user.custom_tool_result"].includes(e.type))).toEqual([]);
      expect(persisted.filter(e => e.type === "session.status_idle")).toMatchObject([
        { stop_reason: { type: "requires_action", event_ids: ["pending-call"] } },
      ]);
      expect((await f.api("/v1/sessions/" + f.session.id)).status).toBe("idle");
    } finally { await f.dispose(); }
  });

  it.each([false, true])("rejects RA message (mixed interrupt=%s) without any append or Work mutation", async mixed => {
    const f = await fixture();
    try {
      await f.claim();
      const stamp = new Date().toISOString();
      await f.publish([
        { id: "pending-call", type: "agent.custom_tool_use", name: "approval", input: {}, processed_at: stamp },
        { id: "parked", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["pending-call"] }, processed_at: stamp },
      ]);
      const before = await f.events();
      const workBefore = await f.api("/v1/environments/" + f.scope.environmentId + "/work/" + f.scope.workId);
      const response = await f.cp.fetch(new Request("https://parity.test/v1/sessions/" + f.session.id + "/events", {
        method: "POST", headers: { "x-api-key": "parity-admin", "content-type": "application/json" },
        body: JSON.stringify({ events: [...(mixed ? [{ type: "user.interrupt" }] : []), { type: "user.message", content: [{ type: "text", text: "cannot bypass approval" }] }] }),
      }));
      expect(response.status).toBe(400);
      expect(await f.events()).toEqual(before);
      expect(await f.api("/v1/environments/" + f.scope.environmentId + "/work/" + f.scope.workId)).toEqual(workBefore);
    } finally { await f.dispose(); }
  });

  it("does not rerun a canonical completed turn when a fresh supervisor reopens the same Work", async () => {
    const f = await fixture(); let running: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    let original: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    const prompts: string[] = [];
    try {
      await f.message("completed-before-crash");
      await f.claim(false);
      original=await startSupervisor(f,{prompt:async()=>{}});
      await original.worker.waitFor(async()=>(await f.events()).filter(e=>e.type==="session.status_idle").length,1);
      await original.worker.published();
      await original.run.stop("crash");await f.reclaim();
      running=await startSupervisor(f,{prompt:async text=>{prompts.push(text);}});
      await running.worker.residentAfterPublish();
      expect(prompts).toEqual([]);
      expect((await f.events()).filter(e => e.type === "session.status_idle")).toHaveLength(1);
    } finally { await original?.run.stop("test complete"); await running?.run.stop("test complete"); await running?.completion; await f.dispose(); }
  });
  it("consumes a real nullable first message before delivering it to ACP", async () => {
    const f = await fixture(); let running: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    const prompts: string[] = []; const atDelivery: unknown[] = [];
    try {
      await f.message("first-real-input");
      expect((await f.events()).find(e => e.type === "user.message").processed_at).toBeNull();
      await f.claim(false);
      running = await startSupervisor(f, { prompt: async text => {
        prompts.push(text); atDelivery.push((await f.events()).find(e => e.type === "user.message").processed_at);
      } });
      // The prompt callback reads canonical SQL asynchronously. Wait for that
      // evidence, not the earlier prompts.push, before asserting consumption.
      await running.worker.waitFor(() => atDelivery.length,1);
      expect(prompts).toEqual(["first-real-input"]);
      expect(atDelivery).toEqual([expect.any(String)]);
      expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
    } finally { await running?.run.stop("test complete"); await running?.completion; await f.dispose(); }
  });

  it("delivers nullable mid-turn input as steer in the existing turn, not a second prompt", async () => {
    const f = await fixture(); let running: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const prompts: string[] = []; const steers: string[] = []; const atSteer: unknown[] = [];
    try {
      await f.message("already-consumed-first-turn");
      const first = (await f.events()).find(e => e.type === "user.message");
      await f.claim(false);
      running = await startSupervisor(f, { prompt: async text => { prompts.push(text); await gate; },
        steer: async text => { steers.push(text); atSteer.push((await f.events()).find(e => e.type === "user.message" && e.id !== first.id).processed_at); } });
      await running.worker.waitFor(() => prompts.length,1);
      await f.message("live-correction");
      await running.worker.waitFor(() => steers,["live-correction"]);
      expect(prompts).toEqual(["already-consumed-first-turn"]);
      expect(atSteer).toEqual([expect.any(String)]);
    } finally { release(); await running?.run.stop("test complete"); await running?.completion; await f.dispose(); }
  });
});
