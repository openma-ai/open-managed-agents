import { describe, expect, it } from "vitest";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { createInMemoryEvalRunService } from "@open-managed-agents/evals-store/test-fakes";
import { tickEvalRuns, type EvalRunnerContext } from "../src/tick";
import { extractResults, rowToRecord, type EvalRunRecord } from "../src/types";
import type { EvalSessionRuntime } from "../src/runtime";
import type { EvalBenchmarkStore } from "../src/benchmarks";

/** Sessions whose turns never settle: trials stay active until they time out. */
function stuckRuntime(settle: () => { settled: false } | { settled: true; stopReason: string | null } = () => ({ settled: false })) {
  let sessions = 0;
  const created: string[] = [];
  const runtime = {
    agentExists: async () => true,
    environmentExists: async () => true,
    trajectoryConfigs: async () => { throw new Error("no trajectory in this test"); },
    oracleAgentId: async () => "agent_oracle",
    environmentForImage: async (alias: string) => `env_${alias}`,
    createSession: async ({ metadata }: { metadata: Record<string, string> }) => { const id = `sess_${++sessions}`; created.push(`${metadata.oma_eval_task}#${metadata.oma_eval_trial}`); return id; },
    sendUserMessage: async (sessionId: string) => `msg_${sessionId}`,
    interrupt: async () => undefined,
    settledAfter: async () => settle(),
    listEvents: async () => [],
    status: async () => "running",
    exec: async () => ({ exit_code: 0, output: "" }),
    ensureSandbox: async () => true,
    releaseSandbox: async () => undefined,
    imageAlias: () => null,
  } as unknown as EvalSessionRuntime;
  return { runtime, created };
}

function messagesRun(concurrency: number | undefined): Omit<EvalRunRecord, "id" | "tenant_id" | "status" | "created_at"> {
  return {
    kind: "messages", agent_id: "agent_1", environment_id: "env_1",
    ...(concurrency !== undefined ? { benchmark_id: "evbm_1", concurrency } : {}),
    task_count: 2, completed_count: 0, failed_count: 0,
    tasks: ["a", "b"].map((id) => ({
      id, status: "pending" as const, trial_total: 2,
      spec: { id, messages: ["hi"], timeout_ms: 1_000 },
      trials: [0, 1].map((trial_index) => ({ trial_index, status: "pending" as const })),
    })),
  };
}

async function setup(concurrency: number | undefined, settle?: Parameters<typeof stuckRuntime>[0]) {
  const { service } = createInMemoryEvalRunService();
  const kv = new InMemoryKvStore();
  const fake = stuckRuntime(settle);
  let now = 1_000_000;
  const ctx: EvalRunnerContext = {
    forEachShard: async (fn) => [await fn({ evals: service, kv })],
    getServicesForTenant: async () => ({ evals: service, kv }),
    runtimeFor: () => fake.runtime,
    benchmarksFor: () => ({}) as EvalBenchmarkStore,
    now: () => now,
  };
  const record = messagesRun(concurrency);
  const row = await service.create({ tenantId: "t", agentId: "agent_1", environmentId: "env_1", results: extractResults({ ...record, id: "", tenant_id: "t", status: "pending", created_at: "" }) });
  const read = async () => rowToRecord((await service.get({ tenantId: "t", runId: row.id }))!);
  return { ctx, fake, read, advance: (ms: number) => { now += ms; } };
}

const states = (run: EvalRunRecord) => run.tasks.map((task) => task.trials.map((trial) => trial.status));

describe("messages run concurrency", () => {
  it("benchmark runs start at most `concurrency` trials, first trial of every case first", async () => {
    const { ctx, fake, read, advance } = await setup(2);
    await tickEvalRuns(ctx);
    expect(states(await read())).toEqual([["running", "pending"], ["running", "pending"]]);
    expect(fake.created).toEqual(["a#0", "b#0"]);

    await tickEvalRuns(ctx); // still full
    expect(fake.created).toHaveLength(2);

    advance(2_000); // both active trials time out, freeing their slots
    await tickEvalRuns(ctx);
    const run = await read();
    expect(states(run)).toEqual([["failed", "running"], ["failed", "running"]]);
    expect(fake.created).toEqual(["a#0", "b#0", "a#1", "b#1"]);
  });

  it("concurrency 1 runs one trial at a time", async () => {
    const { ctx, fake } = await setup(1);
    await tickEvalRuns(ctx);
    await tickEvalRuns(ctx);
    expect(fake.created).toEqual(["a#0"]);
  });

  it("inline runs (no concurrency) start every trial at once, as before", async () => {
    const { ctx, fake, read } = await setup(undefined);
    await tickEvalRuns(ctx);
    expect(states(await read())).toEqual([["running", "running"], ["running", "running"]]);
    expect(fake.created).toHaveLength(4);
  });
});

describe("messages trials whose Session gave up", () => {
  for (const stopReason of ["retries_exhausted", "terminated", "session_not_found"]) {
    it(`${stopReason} fails the trial instead of grading it`, async () => {
      const { ctx, read } = await setup(undefined, () => ({ settled: true, stopReason }));
      await tickEvalRuns(ctx); // create sessions
      await tickEvalRuns(ctx); // provisioning -> first message sent
      await tickEvalRuns(ctx); // settled with an error stop
      const run = await read();
      expect(states(run)).toEqual([["failed", "failed"], ["failed", "failed"]]);
      expect(run.tasks[0]!.trials[0]!.error).toMatch(/Session/);
      expect(run.tasks[0]!.trial_pass_count).toBe(0);
      expect(run.status).toBe("failed");
    });
  }
});
