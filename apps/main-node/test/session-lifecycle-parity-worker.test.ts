import { describe, expect, it } from "vitest";
import { firstNativePrompt, lifecycleFixture, lifecycleWorker as worker } from "./session-lifecycle-parity-worker.helper";
import type {ParityPeerHooks} from "./session-lifecycle-parity-acp.fixture";
type Fixture = Awaited<ReturnType<typeof lifecycleFixture>>;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function queuedHistory(f:Fixture,text:string){await f.message(text);return (await f.events()).find(e=>e.type==="user.message");}
const runtime=(hooks:ParityPeerHooks)=>hooks;

// main d45d7dc node-managed-session-runtime.ts:454-490 retries startup three
// times; node-managed-session-runner.ts:983-990 never retries after agent output.
// Candidate source is explicit opt-in; installed remains the default.
describe("main lifecycle parity: real Work runner + Node HTTP", () => {
  it("retries a side-effect-free ACP startup failure three times before durable exhausted idle", async () => {
    const f = await lifecycleFixture(); let active: ReturnType<typeof worker> | undefined;
    let starts = 0;
    try {
      await queuedHistory(f, "startup failure"); await f.claim(false);
      active = worker(f, runtime({ start: async () => { starts++; throw new Error("transient ACP spawn failure"); }, async *prompt() { throw new Error("unreachable prompt"); } }));
      // Permit main's 2s+4s retry schedule, without manufacturing a retry hook.
      await active.waitFor(() => starts, 3, 8500);
      await expect.poll(async () => (await f.events()).filter(e => e.type === "session.status_idle").at(-1)?.stop_reason, { timeout: 1500 })
        .toEqual({ type: "retries_exhausted" });
      // Fixed main d45d7dc contracts/session-events.ts defines retry_status as
      // {type}, not a string. Keep the exact retry count and order assertion.
      expect((await f.events()).filter(e => e.type === "session.error").map(e => e.error.retry_status)).toEqual([
        { type: "retrying" }, { type: "retrying" }, { type: "exhausted" },
      ]);
    } finally { await active?.stop(); await f.dispose(); }
  });

  it.each(["deduplicate", "terminal"] as const)("running failure plus identical HTTP retry: %s", async check => {
    const f = await lifecycleFixture(); let active: ReturnType<typeof worker> | undefined;
    let effects = 0; const failed = deferred();
    try {
      const path = "/v1/sessions/" + f.session.id + "/events";
      const send = () => f.cp.fetch(new Request("https://parity.test" + path, { method: "POST",
        headers: { "x-api-key": "parity-admin", "content-type": "application/json", "Idempotency-Key": "unknown-effect" },
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "effect-once" }] }] }),
      }));
      const receipt = await send(); expect(receipt.status).toBe(200); const original = await receipt.json();
      await f.claim(false);
      active = worker(f, runtime({ async *prompt() {
        effects++;
        yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "effect committed" } };
        yield { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "flush answer before fault" } };
        failed.resolve(); throw new Error("connection lost after observable effect");
      } }));
      await active.reached(failed.promise);
      await expect.poll(async () => (await f.events()).some(e => e.type === "agent.message"), { timeout: 1500 }).toBe(true);
      const retry = await send(); expect(retry.status).toBe(200);
      const retried = await retry.json() as any;
      expect(retried.data.map((e: any) => e.id)).toEqual((original as any).data.map((e: any) => e.id));
      expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
      expect(effects).toBe(1);
      if (check === "deduplicate") return;
      const settled = await active.result;
      expect(settled).toHaveProperty("error");
      expect(active.responses.filter(response => response.action === "work-failed")).toMatchObject([{status:200}]);
      await expect.poll(async () => (await f.events()).filter(e => e.type === "session.status_idle").at(-1)?.stop_reason, { timeout: 1500 })
        .toEqual({ type: "retries_exhausted" });
      expect(effects).toBe(1);
    } finally { await active?.stop(); await f.dispose(); }
  });

  it("archive during inflight startup rejects the old owner's late terminal and does not execute its prompt", async () => {
    const f = await lifecycleFixture(); let active: ReturnType<typeof worker> | undefined;
    const started = deferred(), release = deferred(), cancellationObserved = deferred(); let prompts = 0;
    try {
      await queuedHistory(f, "archive while starting"); await f.claim(false);
      active = worker(f, runtime({ start: async () => { started.resolve(); await release.promise; }, async *prompt() { prompts++; yield { type: "promptComplete", response: {} }; } }), async response => {
        const body = await response.json() as any;
        if (!response.ok || body.state === "stopping" || body.state === "stopped") cancellationObserved.resolve();
      });
      await active.reached(started.promise);
      await f.api("/v1/sessions/" + f.session.id + "/archive", {});
      const archived = await f.api("/v1/sessions/" + f.session.id);
      expect(archived.archived_at).toEqual(expect.any(String));
      const late = await f.cp.fetch(new Request("https://parity.test/v1/oma/sessions/" + f.session.id + "/runtime-events", {
        method: "POST", headers: { authorization: "Bearer " + f.token(), "content-type": "application/json" },
        body: JSON.stringify({ events: [{ id: "late-idle", type: "session.status_idle", processed_at: new Date().toISOString(), stop_reason: { type: "end_turn" } }] }),
      }));
      expect(late.status).toBeGreaterThanOrEqual(400);
      // Deterministic race: lease cancellation has reached the old worker before spawn returns.
      await active.reached(cancellationObserved.promise);
      await new Promise<void>(resolve => setTimeout(resolve, 0)); // let the heartbeat apply its abort
      release.resolve(); await active.result;
      expect(await f.api("/v1/sessions/" + f.session.id)).toEqual(archived);
      expect((await f.events()).some(e => e.id === "late-idle")).toBe(false);
      expect(prompts).toBe(0);
    } finally { release.resolve(); await active?.stop(); await f.dispose(); }
  });

  it("active interrupt fences the old owner; followup gets a fresh executable consumer without replaying the old input", async () => {
    const f = await lifecycleFixture(); let first: ReturnType<typeof worker> | undefined, second: ReturnType<typeof worker> | undefined;
    const entered = deferred(), release = deferred(), cancellationObserved = deferred(); const prompts: string[] = [];
    try {
      await queuedHistory(f, "old-input"); const old = await f.claim(false);
      first = worker(f, runtime({ async *prompt(text) {
        prompts.push(String(text)); entered.resolve();
        yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "running" } };
        await release.promise; yield { type: "promptComplete", response: {} };
      }, cancel: release.resolve }), async response => {
        const body = await response.json() as any;
        if (!response.ok || body.state === "stopping" || body.state === "stopped") cancellationObserved.resolve();
      });
      await first.reached(entered.promise);
      await expect.poll(async () => (await f.api("/v1/sessions/" + f.session.id)).status, { timeout: 1500 }).toBe("running");
      await f.api("/v1/sessions/" + f.session.id + "/events", { events: [{ type: "user.interrupt" }] });
      await f.message("after-interrupt");
      const replacement = await f.claim(false); expect(replacement.id).not.toBe(old.id);
      await first.reached(cancellationObserved.promise);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      release.resolve(); await first.result;
      second = worker(f, runtime({ async *prompt(text) { prompts.push(String(text)); yield { type: "promptComplete", response: {} }; } }));
      await second.waitFor(() => prompts,[firstNativePrompt("old-input"), firstNativePrompt("after-interrupt")]);
      expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(2);
    } finally { release.resolve(); await first?.stop(); await second?.stop(); await f.dispose(); }
  });
});
