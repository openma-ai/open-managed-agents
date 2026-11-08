// @ts-nocheck
// One Cloudflare turn's failure handling, driven through the public API.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const post = (path: string, body: any) =>
  exports.default.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: H, body: JSON.stringify(body) }));
const stubOf = (id: string) => env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
let runs = 0;

beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  registerHarness("crash-after-agent-event", () => ({
    async run(ctx) {
      runs += 1;
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "partial" }] });
      throw new Error("crash after agent event");
    },
  }));
});

async function createSession(harness: string) {
  const a = await post("/v1/oma/agents", { name: `turn-${Date.now()}`, model: "claude-sonnet-4-6", _oma: { harness } });
  const e = await post("/v1/oma/environments", { name: `env-${Date.now()}`, config: { type: "cloud" } });
  const s = await post("/v1/oma/sessions", { agent: ((await a.json()) as any).id, environment_id: ((await e.json()) as any).id });
  const id = ((await s.json()) as any).id as string;
  await runInDurableObject(stubOf(id), (instance: any) => instance._sandboxWarm);
  return id;
}
const events = (id: string): Promise<any[]> => runInDurableObject(stubOf(id), async (_i, state) =>
  new SqliteHistory(state.storage.sql, null).getEvents() as any[]);

describe("characterization: one Cloudflare turn", () => {
  it("re-runs a turn that failed after producing agent events", async () => {
    const id = await createSession("crash-after-agent-event");
    runs = 0;
    await post(`/v1/oma/sessions/${id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] });
    let seen: any[] = [];
    for (let t = 0; t < 12_000 && !seen.some((e) => e.type === "session.status_idle"); t += 200) {
      await new Promise((r) => setTimeout(r, 200));
      seen = await events(id);
    }
    expect(runs).toBe(3);
    expect(seen.filter((e) => e.type === "session.status_idle").map((e) => e.stop_reason.type)).toEqual(["retries_exhausted"]);
  }, 30_000);
});
