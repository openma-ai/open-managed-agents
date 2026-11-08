// Eval runner — advances pending/running EvalRuns toward completion, once
// per scheduler tick on both runtimes (Cloudflare cron, Node scheduler).
//
// Every trial is a managed Session driven through EvalSessionRuntime:
//   - kind "harbor"   — see ./harbor.ts.
//   - kind "messages" — the original OMA task spec: optional setup files and
//     script in the Session sandbox, then each scripted user message in turn;
//     once the last turn settles the trajectory is built and the eval-core
//     verifier for spec.reward scores it. Runs created from a messages
//     benchmark carry `concurrency` and start a new trial only while fewer
//     than that many trials of the run are active; inline runs (no
//     concurrency) start every trial at once, as they always did.

import {
  buildTrajectory,
  verifierForSpec,
  NoRunVerifier,
  logWarn,
  type StoredEvent,
  type Trajectory,
  type RewardResult,
  type VerifierContext,
  type SessionRecord,
} from "@open-managed-agents/shared";
import { encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { EvalRunService } from "@open-managed-agents/evals-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import type { EvalBenchmarkStore } from "./benchmarks";
import { advanceHarborRun } from "./harbor";
import { EvalRuntimeError, type EvalSessionRuntime } from "./runtime";
import {
  type EvalRunRecord,
  type EvalTaskResult,
  type EvalTrialResult,
  rowToRecord,
  extractResults,
  isTerminal,
  kvKey,
} from "./types";

/** What the runner needs per shard / tenant. */
export interface EvalRunnerServices {
  evals: EvalRunService;
  /** Trajectory storage for messages-kind trials. */
  kv: KvStore;
}

export interface EvalRunnerContext {
  /** CF: fan out over shards; Node: a single shard. */
  forEachShard: <T>(fn: (services: EvalRunnerServices) => Promise<T>) => Promise<T[]>;
  getServicesForTenant: (tenantId: string) => Promise<EvalRunnerServices>;
  runtimeFor: (tenantId: string) => EvalSessionRuntime | Promise<EvalSessionRuntime>;
  benchmarksFor: (tenantId: string) => EvalBenchmarkStore | Promise<EvalBenchmarkStore>;
  /** Image registry reads (Harbor WORKDIR/ENV); defaults to global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

async function loadRun(ctx: EvalRunnerContext, tenantId: string, runId: string): Promise<EvalRunRecord | null> {
  const services = await ctx.getServicesForTenant(tenantId);
  const row = await services.evals.get({ tenantId, runId });
  return row ? rowToRecord(row) : null;
}

async function saveRun(ctx: EvalRunnerContext, run: EvalRunRecord): Promise<void> {
  const services = await ctx.getServicesForTenant(run.tenant_id);
  // A run cancelled while this tick worked on it stays cancelled.
  const current = await services.evals.get({ tenantId: run.tenant_id, runId: run.id });
  if (current === null || current.status === "cancelled") return;
  if (isTerminal(run.status)) {
    await services.evals.markCompleted({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status as "completed" | "failed" | "cancelled",
      results: extractResults(run),
      ...(run.score !== undefined ? { score: run.score } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    });
  } else {
    await services.evals.update({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      score: run.score ?? null,
      error: run.error ?? null,
    });
  }
}

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------- messages kind ----------

async function execOrThrow(runtime: EvalSessionRuntime, sessionId: string, command: string, timeoutMs: number, label: string) {
  const result = await runtime.exec(sessionId, command, timeoutMs);
  if (result.exit_code !== 0) throw new Error(`${label} exit=${result.exit_code}: ${result.output.slice(0, 4000)}`);
}

async function writeSetupFiles(runtime: EvalSessionRuntime, sessionId: string, files: ReadonlyArray<{ path: string; content: string }>) {
  for (const f of files) {
    if (!f.path.startsWith("/")) throw new Error(`setup_files path must be absolute, got "${f.path}"`);
    const sentinel = `OMA_SETUP_EOF_${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
    if (f.content.includes(sentinel)) throw new Error(`setup_files heredoc sentinel collision for ${f.path} (re-run)`);
    const dir = f.path.lastIndexOf("/") > 0 ? f.path.slice(0, f.path.lastIndexOf("/")) : "/";
    const command = [`mkdir -p ${shellQuote(dir)}`, `cat > ${shellQuote(f.path)} <<'${sentinel}'`, f.content, sentinel].join("\n");
    await execOrThrow(runtime, sessionId, command, 30_000, `setup_files write for ${f.path}`);
  }
}

function verifierContext(runtime: EvalSessionRuntime, sessionId: string): VerifierContext {
  return {
    sessionId,
    runExec: async (cmd, opts) => {
      try { return await runtime.exec(sessionId, cmd, opts?.timeoutMs ?? 600_000); }
      catch (err) { return { exit_code: -1, output: errorText(err) }; }
    },
  };
}

async function runVerifier(runtime: EvalSessionRuntime, run: EvalRunRecord, task: EvalTaskResult, sessionId: string, trajectory: Trajectory): Promise<RewardResult> {
  const computedAt = new Date().toISOString();
  const reward = task.spec?.reward;
  if (!reward) {
    return { raw_rewards: { outcome: 1 }, final_reward: 1, verifier_id: "eval-runner.trial-status.v1", computed_at: computedAt };
  }
  let verifier;
  try {
    verifier = verifierForSpec(reward, verifierContext(runtime, sessionId));
  } catch (err) {
    logWarn({ op: "eval.verifier.spec_invalid", run_id: run.id, task_id: task.id, err: errorText(err) }, "verifier spec rejected; recording 0 reward");
    return { raw_rewards: { spec_invalid: 0 }, final_reward: 0, verifier_id: "verifier-spec-invalid.v1", computed_at: computedAt };
  }
  let score;
  try {
    score = await verifier.check(trajectory);
  } catch (err) {
    logWarn({ op: "eval.verifier.check_threw", run_id: run.id, task_id: task.id, verifier_id: verifier.id, err: errorText(err) }, "verifier check threw; recording 0 reward");
    return { raw_rewards: { verifier_error: 0 }, final_reward: 0, verifier_id: verifier.id, computed_at: computedAt };
  }
  const criteria = (score.metadata as { criteria?: Record<string, number> } | undefined)?.criteria;
  const rawRewards = criteria && Object.keys(criteria).length > 0 ? criteria : { value: score.value };
  const persisted: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawRewards)) if (typeof v === "number" && Number.isFinite(v)) persisted[k] = v;
  return { raw_rewards: persisted, final_reward: score.value, verifier_id: verifier.id, computed_at: computedAt };
}

async function noRunReward(reason: string): Promise<RewardResult> {
  const verifier = new NoRunVerifier(reason);
  const score = await verifier.check({} as Trajectory);
  return { raw_rewards: { failure: 0 }, final_reward: score.value, verifier_id: verifier.id, computed_at: new Date().toISOString() };
}

async function buildSessionTrajectory(runtime: EvalSessionRuntime, run: EvalRunRecord, task: EvalTaskResult, trial: EvalTrialResult, sessionId: string): Promise<Trajectory> {
  const configs = await runtime.trajectoryConfigs(run.agent_id ?? "", run.environment_id ?? "");
  const session = {
    id: sessionId,
    agent_id: run.agent_id ?? "",
    environment_id: run.environment_id ?? "",
    title: `eval ${run.id} · ${task.id}`,
    status: "idle",
    created_at: trial.started_at ?? run.created_at,
    agent_snapshot: configs.agent,
    environment_snapshot: configs.environment,
  } as unknown as SessionRecord;
  const trajectory = await buildTrajectory(session, {
    fetchAllEvents: async (): Promise<StoredEvent[]> => {
      const events = await runtime.listEvents(sessionId);
      return events.map((event, index) => ({
        seq: index + 1,
        type: event.type,
        data: JSON.stringify(encodeRuntimeHistoryEvent(event as never)),
        ts: typeof event.processedAt === "string" ? event.processedAt : (trial.started_at ?? run.created_at),
      }));
    },
    fetchFullStatus: async () => ({ status: (await runtime.status(sessionId)) ?? "terminated" }),
  });
  trajectory.task_id = task.id;
  trajectory.group_id = run.id;
  return trajectory;
}

async function storeTrajectory(ctx: EvalRunnerContext, run: EvalRunRecord, trajectory: Trajectory) {
  const services = await ctx.getServicesForTenant(run.tenant_id);
  await services.kv.put(kvKey(run.tenant_id, "trajectory", trajectory.trajectory_id), JSON.stringify(trajectory));
}

async function persistFailureTrajectory(ctx: EvalRunnerContext, runtime: EvalSessionRuntime, run: EvalRunRecord, task: EvalTaskResult, trial: EvalTrialResult, outcome: Trajectory["outcome"]) {
  if (!trial.session_id) return;
  try {
    const trajectory = await buildSessionTrajectory(runtime, run, task, trial, trial.session_id);
    trajectory.outcome = outcome;
    trajectory.reward = await noRunReward(trial.error ?? "failure");
    await storeTrajectory(ctx, run, trajectory);
    trial.trajectory_id = trajectory.trajectory_id;
    trial.reward = trajectory.reward.final_reward;
  } catch (err) {
    logWarn({ op: "eval.failure_trajectory.skip", run_id: run.id, task_id: task.id, session_id: trial.session_id, err: errorText(err) }, "could not build failure-trial trajectory");
  }
}

async function failMessagesTrial(ctx: EvalRunnerContext, runtime: EvalSessionRuntime, run: EvalRunRecord, task: EvalTaskResult, trial: EvalTrialResult, error: string, outcome: Trajectory["outcome"], now: number) {
  trial.status = "failed";
  trial.phase = "done";
  trial.error = error;
  trial.ended_at = new Date(now).toISOString();
  await persistFailureTrajectory(ctx, runtime, run, task, trial, outcome);
}

async function advanceMessagesTrial(ctx: EvalRunnerContext, runtime: EvalSessionRuntime, run: EvalRunRecord, task: EvalTaskResult, trial: EvalTrialResult, now: number): Promise<boolean> {
  const spec = task.spec;
  if (!spec) { trial.status = "failed"; trial.error = "task has no spec"; return true; }

  if (trial.status === "pending") {
    try {
      if (!run.agent_id || !run.environment_id) throw new Error("messages runs need agent_id and environment_id");
      trial.session_id = await runtime.createSession({
        agentId: run.agent_id,
        environmentId: run.environment_id,
        title: `eval ${run.id} · ${task.id} #${trial.trial_index}`,
        metadata: { oma_eval_run: run.id, oma_eval_task: task.id, oma_eval_trial: String(trial.trial_index) },
      });
      trial.status = "running";
      trial.phase = "provisioning";
      trial.started_at = new Date(now).toISOString();
      trial.current_message_index = 0;
    } catch (err) {
      if (err instanceof EvalRuntimeError && err.retryable) { trial.error = err.message; return false; }
      trial.status = "failed";
      trial.error = errorText(err);
      trial.ended_at = new Date(now).toISOString();
      return true;
    }
  }
  const sessionId = trial.session_id;
  if (!sessionId) { trial.status = "failed"; trial.error = "running trial missing session_id"; return true; }

  const timeoutMs = spec.timeout_ms ?? 3_600_000;
  if (trial.started_at && now - Date.parse(trial.started_at) > timeoutMs) {
    if (trial.phase === "agent") await runtime.interrupt(sessionId).catch(() => undefined);
    await failMessagesTrial(ctx, runtime, run, task, trial,
      `trial timeout: ${Math.round((now - Date.parse(trial.started_at)) / 1000)}s exceeded budget ${Math.round(timeoutMs / 1000)}s (m_idx=${trial.current_message_index ?? 0})`, "timeout", now);
    return true;
  }

  if (trial.phase === "provisioning") {
    try {
      const needsSandbox = (spec.setup_files?.length ?? 0) > 0 || (spec.setup_script?.trim().length ?? 0) > 0;
      if (needsSandbox) {
        if (!(await runtime.ensureSandbox(sessionId))) return false;
        if (spec.setup_files?.length) await writeSetupFiles(runtime, sessionId, spec.setup_files);
        if (spec.setup_script?.trim()) await execOrThrow(runtime, sessionId, spec.setup_script, 30 * 60 * 1000, "setup_script");
      }
      trial.message_event_id = await runtime.sendUserMessage(sessionId, spec.messages[0]!);
      trial.phase = "agent";
      return true;
    } catch (err) {
      await failMessagesTrial(ctx, runtime, run, task, trial, errorText(err), "failure", now);
      return true;
    }
  }

  if (!trial.message_event_id) { trial.status = "failed"; trial.error = "trial has no pending message"; return true; }
  const settled = await runtime.settledAfter(sessionId, trial.message_event_id);
  if (!settled.settled) return false;
  // The turn ended without the agent finishing it (sandbox/model retries ran
  // out, the Session was terminated or deleted): that is an errored trial, not
  // an answer to grade.
  if (settled.stopReason === "retries_exhausted" || settled.stopReason === "terminated" || settled.stopReason === "session_not_found") {
    const why = settled.stopReason === "retries_exhausted" ? "Session gave up after retries (see its session.error events)"
      : settled.stopReason === "terminated" ? "Session terminated before the case finished" : "Session disappeared before the case finished";
    await failMessagesTrial(ctx, runtime, run, task, trial, `${why} (m_idx=${trial.current_message_index ?? 0})`, "failure", now);
    return true;
  }

  const nextIndex = (trial.current_message_index ?? 0) + 1;
  if (nextIndex < spec.messages.length) {
    try {
      trial.message_event_id = await runtime.sendUserMessage(sessionId, spec.messages[nextIndex]!);
      trial.current_message_index = nextIndex;
    } catch (err) {
      await failMessagesTrial(ctx, runtime, run, task, trial, errorText(err), "failure", now);
    }
    return true;
  }

  try {
    const trajectory = await buildSessionTrajectory(runtime, run, task, trial, sessionId);
    trajectory.reward = await runVerifier(runtime, run, task, sessionId, trajectory);
    await storeTrajectory(ctx, run, trajectory);
    trial.trajectory_id = trajectory.trajectory_id;
    trial.status = "completed";
    trial.phase = "done";
    trial.ended_at = new Date(now).toISOString();
    trial.reward = trajectory.reward.final_reward;
    if (trajectory.reward.raw_rewards) trial.rewards = trajectory.reward.raw_rewards;
  } catch (err) {
    // Bounded retry: event reads can fail transiently under contention.
    trial.finalize_retry_count = (trial.finalize_retry_count ?? 0) + 1;
    if (trial.finalize_retry_count >= 3) {
      trial.status = "failed";
      trial.error = `events_unavailable_during_finalize (${trial.finalize_retry_count} attempts): ${errorText(err).slice(0, 200)}`;
      trial.ended_at = new Date(now).toISOString();
    }
  }
  return true;
}

function summariseMessagesTask(task: EvalTaskResult) {
  const completed = task.trials.filter((t) => t.status === "completed").length;
  const failed = task.trials.filter((t) => t.status === "failed" || t.status === "cancelled").length;
  // Same rule as harbor: a trial passes when its reward is at least 1.
  task.trial_pass_count = task.trials.filter((t) => t.status === "completed" && (t.reward ?? 0) >= 1).length;
  task.trial_total = task.trials.length;
  const rewards = task.trials.filter((t) => t.status === "completed" && typeof t.reward === "number").map((t) => t.reward!);
  if (rewards.length > 0) task.mean_reward = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  if (completed + failed === task.trials.length) {
    if (completed === task.trials.length) task.status = "completed";
    else { task.status = "failed"; task.error = task.trials.find((t) => t.error)?.error; }
  } else {
    task.status = task.trials.some((t) => t.status !== "pending") ? "running" : "pending";
  }
}

/**
 * Messages run with a concurrency limit: advance active trials, then start
 * pending ones trial-index-major (every case's first trial before any
 * second) while fewer than `limit` trials are active.
 */
async function advanceLimitedMessagesRun(ctx: EvalRunnerContext, runtime: EvalSessionRuntime, run: EvalRunRecord, limit: number, now: () => number): Promise<boolean> {
  let progressed = false;
  for (const task of run.tasks) {
    for (const trial of task.trials) {
      if (trial.status !== "running") continue;
      if (await advanceMessagesTrial(ctx, runtime, run, task, trial, now())) progressed = true;
    }
  }
  let active = run.tasks.reduce((sum, task) => sum + task.trials.filter((trial) => trial.status === "running").length, 0);
  const maxTrials = Math.max(0, ...run.tasks.map((task) => task.trials.length));
  for (let index = 0; index < maxTrials && active < limit; index++) {
    for (const task of run.tasks) {
      if (active >= limit) break;
      const trial = task.trials[index];
      if (trial === undefined || trial.status !== "pending") continue;
      if (await advanceMessagesTrial(ctx, runtime, run, task, trial, now())) progressed = true;
      if ((trial.status as EvalTrialResult["status"]) === "running") active++;
    }
  }
  for (const task of run.tasks) if (!isTerminal(task.status)) summariseMessagesTask(task);
  return progressed;
}

// ---------- run ----------

async function advanceRun(ctx: EvalRunnerContext, run: EvalRunRecord): Promise<void> {
  if (isTerminal(run.status)) return;
  const now = ctx.now ?? Date.now;
  let progressed = false;
  if (run.status === "pending") {
    run.status = "running";
    run.started_at = new Date(now()).toISOString();
    progressed = true;
  }
  const runtime = await ctx.runtimeFor(run.tenant_id);

  if (run.kind === "harbor") {
    const benchmarks = await ctx.benchmarksFor(run.tenant_id);
    if (await advanceHarborRun(run, { runtime, benchmarks, now, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) })) progressed = true;
  } else if (run.concurrency === undefined) {
    for (const task of run.tasks) {
      if (isTerminal(task.status)) continue;
      for (const trial of task.trials) {
        if (trial.status !== "pending" && trial.status !== "running") continue;
        if (await advanceMessagesTrial(ctx, runtime, run, task, trial, now())) progressed = true;
      }
      summariseMessagesTask(task);
    }
  } else if (await advanceLimitedMessagesRun(ctx, runtime, run, run.concurrency, now)) {
    progressed = true;
  }

  run.completed_count = run.tasks.filter((t) => t.status === "completed").length;
  run.failed_count = run.tasks.filter((t) => t.status === "failed").length;
  const scored = run.tasks.filter((t) => typeof t.mean_reward === "number");
  if (scored.length > 0) run.score = scored.reduce((sum, t) => sum + t.mean_reward!, 0) / scored.length;
  if (run.completed_count + run.failed_count === run.task_count) {
    run.status = run.failed_count > 0 && run.completed_count === 0 ? "failed" : "completed";
    run.ended_at = new Date(now()).toISOString();
    await saveRun(ctx, run);
    return;
  }
  if (progressed) await saveRun(ctx, run);
}

/**
 * Advance every active run on every shard. Called once per scheduler tick on
 * both runtimes. One run's failure never stops the others.
 */
export async function tickEvalRuns(ctx: EvalRunnerContext): Promise<{ advanced: number; total: number }> {
  let advanced = 0;
  let total = 0;
  const perShard = await ctx.forEachShard((services) => services.evals.listActive());
  for (const activeRows of perShard) {
    total += activeRows.length;
    for (const row of activeRows) {
      const run = rowToRecord(row);
      try {
        await advanceRun(ctx, run);
        advanced++;
      } catch (err) {
        run.status = "failed";
        run.error = errorText(err);
        run.ended_at = new Date().toISOString();
        await saveRun(ctx, run).catch(() => undefined);
      }
    }
  }
  return { advanced, total };
}

/** Interrupt and release every in-flight trial of a run (cancel). */
export async function stopRunTrials(runtime: EvalSessionRuntime, run: EvalRunRecord, now = Date.now()): Promise<void> {
  for (const task of run.tasks) {
    for (const trial of task.trials) {
      if (trial.status !== "pending" && trial.status !== "running") continue;
      if (trial.session_id) {
        await runtime.interrupt(trial.session_id).catch(() => undefined);
        await runtime.releaseSandbox(trial.session_id).catch(() => undefined);
      }
      trial.status = "cancelled";
      trial.phase = "done";
      trial.ended_at = new Date(now).toISOString();
    }
    if (!isTerminal(task.status)) task.status = "cancelled";
  }
}

export { loadRun, saveRun };
