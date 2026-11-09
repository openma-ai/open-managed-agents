import { expect, it } from "vitest";
import { SessionEventsApplicationService } from "@open-managed-agents/managed-agents-application";
import { createInMemoryEvalRunService } from "@open-managed-agents/evals-store/test-fakes";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { createManagedEvalRuntime } from "../src/runtime";
import { tickEvalRuns, type EvalRunnerContext } from "../src/tick";

function fixture() {
  const session: any = { id: "s", status: "idle", archivedAt: null, agent: { id: "a" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", resources: [], outcomeEvaluations: [], usage: {} };
  const facts: any[] = []; let revision = 1, sequence = 0, dispatches = 0;
  const runtime = () => createManagedEvalRuntime({ sessionEvents: new SessionEventsApplicationService({
    workspaceId: "w", clock: { now: () => new Date("2026-01-01T00:00:01Z") },
    ids: { nextEventId: () => "e" + (++sequence), nextOutcomeId: () => "o" + (++sequence) },
    sessions: { find: async () => session }, execution: { find: async () => ({ session: structuredClone(session), environment: {}, revision }) },
    stream: { subscribe: () => (async function* () {})() },
    store: {
      list: async (input: any) => facts.filter(e => !input.eventIds || input.eventIds.includes(e.id)).slice(0, input.limit),
      append: async (input: any) => {
        if (input.expectedRevision !== revision) return { type: "revision_conflict", actualRevision: revision };
        revision++; facts.push(...structuredClone(input.events)); Object.assign(session, input.nextSession);
        return { type: "appended", events: input.events, session: input.nextSession };
      },
    }, dispatch: { sessionEventsAccepted: async () => { dispatches++; } },
  } as any) } as any);
  return { runtime, facts, dispatches: () => dispatches };
}

it("independent eval runtimes atomically admit one message and replay its event id after restart", async () => {
  const f = fixture();
  const send = (key: string, text = "same text") => f.runtime().sendUserMessage("s", text, key);
  const ids = await Promise.all([send("run:task:trial:1"), send("run:task:trial:1")]);
  expect(new Set(ids).size).toBe(1); expect(f.facts).toHaveLength(1); expect(f.dispatches()).toBe(1);
  expect(await send("run:task:trial:1")).toBe(ids[0]);
  await send("run:task:trial:2"); expect(f.facts).toHaveLength(2);
  await expect(send("run:task:trial:1", "changed")).rejects.toThrow("idempotency_conflict");
});

it.each(["provisioning", "agent"])("two production ticks dispatch one %s message, then restart replay remains a no-op", async phase => {
  const f = fixture(), { service } = createInMemoryEvalRunService(), kv = new InMemoryKvStore();
  const messageIndex = phase === "provisioning" ? 0 : 1;
  const row = await service.create({ tenantId: "w", agentId: "a", environmentId: "env", results: {
    kind: "messages", agent_id: "a", environment_id: "env", task_count: 1, completed_count: 0, failed_count: 0,
    tasks: [{ id: "case", status: "running", spec: { id: "case", messages: ["identical", "identical"] },
      trials: [{ trial_index: 0, status: "running", phase, session_id: "s", current_message_index: 0, ...(phase === "agent" ? { message_event_id: "prior" } : {}) }] }],
  } });
  await service.update({ tenantId: "w", runId: row.id, status: "running" });
  const source = (await service.get({ tenantId: "w", runId: row.id }))!;
  const owner = (): EvalRunnerContext => ({
    // Both scheduler owners obtained the same pre-dispatch run snapshot.
    forEachShard: async fn => [await fn({ evals: { ...service, listActive: async () => [structuredClone(source)] } as any, kv })],
    getServicesForTenant: async () => ({ evals: service, kv }),
    runtimeFor: () => ({ ...f.runtime(), settledAfter: async () => ({ settled: true, stopReason: "end_turn" }) }),
    benchmarksFor: () => ({}) as any,
  });
  await Promise.all([tickEvalRuns(owner()), tickEvalRuns(owner())]);
  await tickEvalRuns(owner());
  expect(f.facts).toHaveLength(1); expect(f.dispatches()).toBe(1);
  const saved = await service.get({ tenantId: "w", runId: row.id });
  const trial = (saved!.results as any).tasks[0].trials[0];
  expect(trial.message_event_id).toBe(f.facts[0].id);
  expect(trial.current_message_index).toBe(messageIndex);
});
