// @ts-nocheck
// OMA evals on managed Sessions (CF worker): HTTP contract + tick state machine.
// Harbor runs need real task containers and are covered by
// packages/evals-runner/test/harbor.test.ts plus the Node end-to-end runs; here
// the scripted "messages" kind drives real managed Sessions through SessionDO
// with the eval-test harness.
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";
import { registerTestHarnesses } from "../harnesses";
import { ensureModelCards } from "./_model-cards";
import { tickEvalRuns } from "../../apps/main/src/eval-runner";
import { buildCfServices } from "@open-managed-agents/services";

registerTestHarnesses();
beforeAll(() => ensureModelCards(["claude-sonnet-4-6"]));

const HEADERS = {
  "x-api-key": "test-key",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
const post = (path: string, body: unknown) => api(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
// The CF error envelope wraps route errors as { error: { type, message } }.
const errorText = async (res: Response) => { const { error } = await res.json() as any; return typeof error === "string" ? error : error?.message; };
const get = async (path: string) => (await api(path, { headers: HEADERS })).json() as Promise<any>;

async function setupAgentAndEnv(environmentConfig: Record<string, unknown> = { type: "cloud", networking: { type: "unrestricted" } }) {
  const agentRes = await post("/v1/agents", {
    name: `Eval Agent ${crypto.randomUUID()}`,
    model: "claude-sonnet-4-6",
    system: "you are helpful",
    _oma: { harness: "eval-test" },
  });
  expect(agentRes.status).toBe(201);
  const envRes = await post("/v1/environments", { name: `eval-env-${crypto.randomUUID()}`, config: environmentConfig });
  expect(envRes.status).toBe(201);
  return { agent: await agentRes.json(), environment: await envRes.json() };
}

async function createRun(body: Record<string, unknown>) {
  const res = await post("/v1/oma/evals/runs", body);
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

async function driveToTerminal(runId: string, ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await tickEvalRuns(env);
    await new Promise((r) => setTimeout(r, 300));
    const body = await get(`/v1/oma/evals/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(body.status)) return body;
  }
  return get(`/v1/oma/evals/runs/${runId}`);
}

describe("POST /v1/oma/evals/runs (messages)", () => {
  it("requires auth", async () => {
    const res = await api("/v1/oma/evals/runs", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects missing agent_id", async () => {
    const res = await post("/v1/oma/evals/runs", { environment_id: "env-x", tasks: [] });
    expect(res.status).toBe(400);
  });

  it("rejects empty tasks array", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const res = await post("/v1/oma/evals/runs", { agent_id: agent.id, environment_id: environment.id, tasks: [] });
    expect(res.status).toBe(400);
  });

  it("rejects task missing messages", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const res = await post("/v1/oma/evals/runs", { agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "t1" }] });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown managed agent (#356)", async () => {
    const { environment } = await setupAgentAndEnv();
    const res = await post("/v1/oma/evals/runs", { agent_id: "agent_ghost", environment_id: environment.id, tasks: [{ id: "t1", messages: ["hi"] }] });
    expect(res.status).toBe(404);
    expect(await errorText(res)).toMatch(/Agent not found/);
  });

  it("rejects an unknown environment", async () => {
    const { agent } = await setupAgentAndEnv();
    const res = await post("/v1/oma/evals/runs", { agent_id: agent.id, environment_id: "env_ghost", tasks: [{ id: "t1", messages: ["hi"] }] });
    expect(res.status).toBe(404);
  });

  it("rejects a self-hosted environment on Cloudflare", async () => {
    const { agent, environment } = await setupAgentAndEnv({ type: "self_hosted" });
    const res = await post("/v1/oma/evals/runs", { agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "t1", messages: ["hi"] }] });
    expect(res.status).toBe(400);
    expect(await errorText(res)).toMatch(/self_hosted/);
  });

  it("creates a pending run and returns run_id", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const body = await createRun({
      agent_id: agent.id,
      environment_id: environment.id,
      tasks: [{ id: "t1", messages: ["hello"] }, { id: "t2", messages: ["world"] }],
    });
    expect(body.run_id).toMatch(/^evrun-/);
    expect(body.task_count).toBe(2);

    const run = await get(`/v1/oma/evals/runs/${body.run_id}`);
    expect(run.status).toBe("pending");
    expect(run.kind).toBe("messages");
    expect(run.task_count).toBe(2);
    expect(run.tasks).toHaveLength(2);
    expect(run.tasks[0].status).toBe("pending");
    expect(run.tasks[0].trials).toHaveLength(1);
    expect(run.tasks[0].trial_total).toBe(1);
    expect(run.tasks[0].trials[0].status).toBe("pending");
    expect(run.completed_count).toBe(0);
  });
});

describe("GET /v1/oma/evals/runs", () => {
  it("lists runs for tenant in reverse chronological order", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const run1 = await createRun({ agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "t", messages: ["m1"] }] });
    await new Promise((r) => setTimeout(r, 10));
    const run2 = await createRun({ agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "t", messages: ["m2"] }] });

    const list = await get("/v1/oma/evals/runs");
    expect(list.data.length).toBeGreaterThanOrEqual(2);
    const ids = list.data.map((r: any) => r.id);
    expect(ids.indexOf(run2.run_id)).toBeLessThan(ids.indexOf(run1.run_id));
  });
});

describe("cancel and delete", () => {
  it("cancels a pending run, then deletes it", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const { run_id } = await createRun({ agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "c", messages: ["hi"], trials: 2 }] });
    const cancelRes = await post(`/v1/oma/evals/runs/${run_id}/cancel`, {});
    expect(cancelRes.status).toBe(200);
    const cancelled = await get(`/v1/oma/evals/runs/${run_id}`);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.tasks[0].trials.every((t: any) => t.status === "cancelled")).toBe(true);

    // A later tick leaves a cancelled run alone.
    await tickEvalRuns(env);
    expect((await get(`/v1/oma/evals/runs/${run_id}`)).status).toBe("cancelled");

    const deleteRes = await api(`/v1/oma/evals/runs/${run_id}`, { method: "DELETE", headers: HEADERS });
    expect(deleteRes.status).toBeLessThan(300);
    expect((await api(`/v1/oma/evals/runs/${run_id}`, { headers: HEADERS })).status).toBe(404);
  });
});

const patch = (path: string, body: unknown) => api(path, { method: "PATCH", headers: HEADERS, body: JSON.stringify(body) });
const put = (path: string, body: unknown) => api(path, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
const del = (path: string) => api(path, { method: "DELETE", headers: HEADERS });
const CASE = {
  name: "hello",
  messages: ["say hi"],
  reward: { type: "verifiable", scorer: "agentMessageContains", opts: { target: "hi" } },
};

describe("benchmarks and cases", () => {
  it("lists the built-in Harbor benchmarks", async () => {
    const body = await get("/v1/oma/evals/benchmarks/builtin");
    expect(body.data.map((d: any) => d.name)).toContain("terminal-bench-sample@2.0");
  });

  it("manages a messages benchmark and its cases", async () => {
    const created = await post("/v1/oma/evals/benchmarks", { kind: "messages", name: "cf-smoke", cases: [CASE] });
    expect(created.status).toBe(201);
    const bench = await created.json() as any;
    expect(bench).toMatchObject({ kind: "messages", name: "cf-smoke", case_count: 1, runnable_count: 1 });

    const base = `/v1/oma/evals/benchmarks/${bench.id}`;
    expect((await patch(base, { name: "cf-smoke-2" })).status).toBe(200);
    expect((await get(base)).name).toBe("cf-smoke-2");

    const dup = await post(`${base}/cases`, CASE);
    expect(dup.status).toBe(409);
    expect((await post(`${base}/cases`, { ...CASE, name: "second", messages: ["a", "b"] })).status).toBe(201);

    const replaced = await put(`${base}/cases/second`, { ...CASE, name: "ignored", messages: ["only"] });
    expect(replaced.status).toBe(200);
    const one = await get(`${base}/cases/second`);
    expect(one).toMatchObject({ kind: "messages", name: "second", messages: ["only"] });

    expect((await del(`${base}/cases/second`)).status).toBe(200);
    expect((await api(`${base}/cases/second`, { headers: HEADERS })).status).toBe(404);
    expect((await get(base)).case_count).toBe(1);

    const listed = await get("/v1/oma/evals/benchmarks");
    expect(listed.data.some((b: any) => b.id === bench.id && b.cases === undefined)).toBe(true);

    expect((await del(base)).status).toBe(200);
    expect((await api(base, { headers: HEADERS })).status).toBe(404);
  });

  it("rejects an invalid reward type on a case", async () => {
    const res = await post("/v1/oma/evals/benchmarks", { kind: "messages", name: "bad", cases: [{ ...CASE, reward: { type: "nope" } }] });
    expect(res.status).toBe(400);
  });

  it("validates harbor benchmark runs", async () => {
    expect((await post("/v1/oma/evals/runs", { benchmark_id: "evds_missing", mode: "oracle" })).status).toBe(404);
    const created = await post("/v1/oma/evals/benchmarks", { kind: "harbor", name: "empty-harbor" });
    expect(created.status).toBe(201);
    const bench = await created.json() as any;
    expect(bench).toMatchObject({ kind: "harbor", case_count: 0, source: null });
    expect((await post("/v1/oma/evals/runs", { benchmark_id: bench.id, mode: "oracle", agent_id: "agent_x" })).status).toBe(400);
    expect((await post("/v1/oma/evals/runs", { benchmark_id: bench.id, mode: "oracle", environment_id: "env_x" })).status).toBe(400);
  });
});

describe("messages benchmark runs on managed Sessions", () => {
  it("snapshots cases, blocks case writes while active, and completes", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const bench = await (await post("/v1/oma/evals/benchmarks", { kind: "messages", name: `run-${crypto.randomUUID()}`, cases: [CASE] })).json() as any;
    const base = `/v1/oma/evals/benchmarks/${bench.id}`;

    expect((await post("/v1/oma/evals/runs", { benchmark_id: bench.id, agent_id: agent.id })).status).toBe(400); // no environment
    expect((await post("/v1/oma/evals/runs", { benchmark_id: bench.id, mode: "oracle", environment_id: environment.id })).status).toBe(400);

    const { run_id, task_count } = await createRun({ benchmark_id: bench.id, agent_id: agent.id, environment_id: environment.id, concurrency: 1 });
    expect(task_count).toBe(1);
    const pending = await get(`/v1/oma/evals/runs/${run_id}`);
    expect(pending).toMatchObject({ kind: "messages", benchmark_id: bench.id, status: "pending" });
    expect(pending.tasks[0].id).toBe("hello");

    expect((await put(`${base}/cases/hello`, { ...CASE, messages: ["changed"] })).status).toBe(409);
    expect((await del(base)).status).toBe(409);

    const listed = await get(`/v1/oma/evals/runs?benchmark_id=${bench.id}`);
    expect(listed.data.map((r: any) => r.id)).toEqual([run_id]);

    const done = await driveToTerminal(run_id);
    expect(done.status).toBe("completed");
    expect(done.tasks[0].trials[0].session_id).toBeTruthy();

    // Writes are allowed again once the run is over.
    expect((await put(`${base}/cases/hello`, { ...CASE, messages: ["changed"] })).status).toBe(200);
  });
});

describe("tickEvalRuns advances messages runs on managed Sessions", () => {
  it("advances pending → running → completed for a single-message task", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const { run_id } = await createRun({ agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "single", messages: ["hello world"] }] });
    expect((await get(`/v1/oma/evals/runs/${run_id}`)).status).toBe("pending");

    await tickEvalRuns(env);
    const running = await get(`/v1/oma/evals/runs/${run_id}`);
    expect(running.status).toBe("running");
    expect(running.tasks[0].trials[0].session_id).toMatch(/^session_/);

    const final = await driveToTerminal(run_id);
    expect(final.status).toBe("completed");
    expect(final.tasks[0].status).toBe("completed");
    expect(final.tasks[0].trials[0].trajectory_id).toEqual(expect.any(String));
    expect(final.tasks[0].trial_pass_count).toBe(1);
    expect(final.completed_count).toBe(1);
    expect(final.failed_count).toBe(0);
    expect(final.ended_at).toBeDefined();
  });

  it("multi-message task sends each message in turn", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const { run_id } = await createRun({ agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "multi", messages: ["msg-A", "msg-B", "msg-C"] }] });
    const final = await driveToTerminal(run_id, 14);
    expect(final.status).toBe("completed");

    const sessionId = final.tasks[0].trials[0].session_id;
    const events = await get(`/v1/sessions/${sessionId}/events?limit=1000`);
    const userTexts = events.data
      .filter((e: any) => e.type === "user.message")
      .map((e: any) => e.content?.[0]?.text);
    expect(userTexts).toEqual(["msg-A", "msg-B", "msg-C"]);
  });

  it("trials > 1: one Session and one trajectory per trial; run leaves the active index", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const { run_id } = await createRun({ agent_id: agent.id, environment_id: environment.id, tasks: [{ id: "trial-task", messages: ["hello"], trials: 3 }] });
    const services = buildCfServices(env, env.AUTH_DB);
    expect((await services.evals.listActive()).some((r: any) => r.id === run_id)).toBe(true);

    const final = await driveToTerminal(run_id);
    expect(final.status).toBe("completed");
    expect(final.tasks[0].trials).toHaveLength(3);
    expect(final.tasks[0].trial_pass_count).toBe(3);
    const sessionIds = final.tasks[0].trials.map((t: any) => t.session_id);
    const trajectoryIds = final.tasks[0].trials.map((t: any) => t.trajectory_id);
    expect(new Set(sessionIds).size).toBe(3);
    expect(new Set(trajectoryIds).size).toBe(3);
    expect((await services.evals.listActive()).some((r: any) => r.id === run_id)).toBe(false);
  });
});
