// Harbor-format trials on managed Sessions, advanced one step per tick:
//
//   pending ─start─▶ provisioning ─▶ agent ─▶ verifying ─▶ done
//
//   provisioning  Session created on the environment that selects the
//                 task's SANDBOX_IMAGES alias. agent mode sends
//                 instruction.md as the first user.message right away
//                 (provisioning is then instantaneous); oracle mode waits
//                 for the sandbox, then starts solution/solve.sh detached.
//   agent         agent mode: wait for the turn to settle; at the task's
//                 agent timeout interrupt it (Harbor still grades).
//                 oracle mode: poll solve.sh.
//   verifying     tests/ uploaded only now, test.sh runs detached in the
//                 same sandbox and is polled; reward.json / reward.txt read.
//
// Long steps never hold a request open: they run in the background inside
// the sandbox (state under /oma/eval, ADR 0016) and are polled each tick,
// which fits the Cloudflare cron budget and Node's scheduler alike.

import {
  fetchImageRuntimeConfig,
  killDetached,
  pollDetached,
  readHarborVerification,
  requireAgentWorkdir,
  runInTask,
  startHarborOracle,
  startHarborVerifier,
  UnsupportedHarborTaskError,
  type HarborTask,
  type HarborTrialSandbox,
  type TaskRuntime,
} from "@open-managed-agents/harbor-tasks";
import type { EvalBenchmarkStore } from "./benchmarks";
import { EvalRuntimeError, type EvalSessionRuntime } from "./runtime";
import type { EvalRunRecord, EvalTaskResult, EvalTrialResult } from "./types";

export interface HarborAdvanceDeps {
  runtime: EvalSessionRuntime;
  benchmarks: EvalBenchmarkStore;
  fetch?: typeof fetch;
  now: () => number;
}

/** Wait this long for an interrupted agent to stop before failing the trial. */
const INTERRUPT_GRACE_MS = 180_000;
/** Oracle sandboxes that never come up fail after this long. */
const PROVISION_TIMEOUT_MS = 15 * 60_000;
/** Consecutive transient errors tolerated within one phase. */
const MAX_ATTEMPTS = 5;
const IMAGE_CONFIG_ATTEMPTS = 3;

/** Trials of one run active at once when the run does not say (benchmark runs). */
export const DEFAULT_EVAL_CONCURRENCY = 4;
export const DEFAULT_HARBOR_CONCURRENCY = DEFAULT_EVAL_CONCURRENCY;

/** HarborTrialSandbox over the Session sandbox (exec only; uploads use base64 chunks). */
export function sessionSandbox(runtime: EvalSessionRuntime, sessionId: string): HarborTrialSandbox {
  return {
    exec: async (command, timeout) => (await runtime.exec(sessionId, command, timeout ?? 60_000)).output,
    writeFile: async () => { throw new Error("writeFile is not available on a Session sandbox"); },
  };
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function failTrial(trial: EvalTrialResult, error: string, now: number, tail?: string) {
  trial.status = "failed";
  trial.phase = "done";
  trial.error = error;
  trial.ended_at = iso(now);
  if (tail) trial.verifier_output_tail = tail;
}

export async function advanceHarborRun(run: EvalRunRecord, deps: HarborAdvanceDeps): Promise<boolean> {
  if (!run.benchmark_id) throw new Error("harbor run has no benchmark_id");
  const tasks = new Map<string, Promise<HarborTask>>();
  // By content digest: the run reads the revision it was created with.
  const load = (task: EvalTaskResult) => {
    let pending = tasks.get(task.id);
    if (pending === undefined) { pending = deps.benchmarks.loadTask(run.benchmark_id!, task.id, task.digest); tasks.set(task.id, pending); }
    return pending;
  };
  let progressed = false;

  for (const task of run.tasks) {
    for (const trial of task.trials) {
      if (trial.status !== "running") continue;
      try {
        if (await advanceTrial(run, task, trial, await load(task), deps)) progressed = true;
      } catch (error) {
        progressed = true;
        noteFailure(trial, error, deps.now());
      }
    }
  }

  const limit = run.concurrency ?? DEFAULT_HARBOR_CONCURRENCY;
  let active = run.tasks.reduce((sum, task) => sum + task.trials.filter((trial) => trial.status === "running").length, 0);
  // Fill free slots trial-index-major: every task's first trial before any second.
  const maxTrials = Math.max(0, ...run.tasks.map((task) => task.trials.length));
  for (let index = 0; index < maxTrials && active < limit; index++) {
    for (const task of run.tasks) {
      if (active >= limit) break;
      const trial = task.trials[index];
      if (trial === undefined || trial.status !== "pending") continue;
      let harborTask: HarborTask;
      try { harborTask = await load(task); }
      catch (error) { failTrial(trial, message(error), deps.now()); progressed = true; continue; }
      const outcome = await startTrial(run, task, trial, harborTask, deps);
      if (outcome !== "unchanged") progressed = true;
      if ((trial.status as EvalTrialResult["status"]) === "running") active++;
      if (outcome === "deferred") break; // e.g. rate limited: try again next tick
    }
  }

  for (const task of run.tasks) summariseHarborTask(task);
  return progressed;
}

/** Transient errors are retried a few times within a phase before failing. */
function noteFailure(trial: EvalTrialResult, error: unknown, now: number) {
  if (error instanceof UnsupportedHarborTaskError) { failTrial(trial, error.message, now); return; }
  trial.attempts = (trial.attempts ?? 0) + 1;
  trial.error = message(error);
  if (trial.attempts >= MAX_ATTEMPTS) failTrial(trial, `${message(error)} (after ${trial.attempts} attempts)`, now);
}

async function resolveTaskRuntime(task: EvalTaskResult, harborTask: HarborTask, deps: HarborAdvanceDeps): Promise<"ready" | "retry" | string> {
  if (task.runtime) return "ready";
  try {
    const config = await fetchImageRuntimeConfig(harborTask.image, deps.fetch ? { fetch: deps.fetch } : {});
    task.runtime = { workdir: config.workingDir, env: config.env };
    return "ready";
  } catch (error) {
    task.runtime_attempts = (task.runtime_attempts ?? 0) + 1;
    if (task.runtime_attempts < IMAGE_CONFIG_ATTEMPTS) return "retry";
    return `Could not read the image config of ${harborTask.image}: ${message(error)}`;
  }
}

async function startTrial(
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  harborTask: HarborTask,
  deps: HarborAdvanceDeps,
): Promise<"started" | "failed" | "deferred" | "unchanged"> {
  const now = deps.now();
  const alias = deps.runtime.imageAlias(harborTask.image);
  if (alias === null) {
    failTrial(trial, `Image ${harborTask.image} is not in this deployment's SANDBOX_IMAGES catalog`, now);
    return "failed";
  }
  task.image_alias = alias;
  const resolved = await resolveTaskRuntime(task, harborTask, deps);
  if (resolved === "retry") return "deferred";
  if (resolved !== "ready") { failTrial(trial, resolved, now); return "failed"; }
  try {
    if (run.mode !== "oracle") requireAgentWorkdir(harborTask, task.runtime!.workdir);
    run.environments ??= {};
    const environmentId = run.environments[alias] ?? await deps.runtime.environmentForImage(alias);
    run.environments[alias] = environmentId;
    const agentId = run.mode === "oracle" ? await deps.runtime.oracleAgentId() : run.agent_id;
    if (!agentId) throw new Error("agent_id is required for agent mode");
    const sessionId = await deps.runtime.createSession({
      agentId,
      environmentId,
      title: `eval ${run.id} · ${task.id} #${trial.trial_index}`,
      metadata: { oma_eval_run: run.id, oma_eval_task: task.id, oma_eval_trial: String(trial.trial_index) },
    });
    trial.session_id = sessionId;
    trial.status = "running";
    trial.started_at = iso(now);
    trial.phase = "provisioning";
    delete trial.error;
    trial.attempts = 0;
    if (run.mode !== "oracle") {
      trial.message_event_id = await deps.runtime.sendUserMessage(sessionId, harborTask.instruction);
      trial.phase = "agent";
      trial.agent_started_at = iso(deps.now());
    }
    return "started";
  } catch (error) {
    if (error instanceof EvalRuntimeError && error.retryable && trial.session_id === undefined) {
      trial.error = message(error);
      return "deferred";
    }
    if (trial.status === "running") { noteFailure(trial, error, deps.now()); return "started"; }
    failTrial(trial, message(error), deps.now());
    return "failed";
  }
}

async function startVerifier(trial: EvalTrialResult, harborTask: HarborTask, sandbox: HarborTrialSandbox, runtime: TaskRuntime, now: number) {
  await startHarborVerifier(harborTask, sandbox, runtime);
  trial.phase = "verifying";
  trial.verify_started_at = iso(now);
  trial.attempts = 0;
  delete trial.error;
}

async function advanceTrial(
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  harborTask: HarborTask,
  deps: HarborAdvanceDeps,
): Promise<boolean> {
  const sessionId = trial.session_id;
  if (!sessionId) { failTrial(trial, "running trial has no session", deps.now()); return true; }
  const now = deps.now();
  const sandbox = sessionSandbox(deps.runtime, sessionId);
  const runtime: TaskRuntime = { workdir: task.runtime?.workdir ?? null, env: task.runtime?.env ?? {} };
  const agentDeadline = (started: string | undefined) =>
    harborTask.agentTimeoutSec === null || started === undefined ? null : Date.parse(started) + harborTask.agentTimeoutSec * 1000;

  if (trial.phase === "provisioning") {
    // oracle mode only: no turn starts the sandbox, so ask for it.
    if (!(await deps.runtime.ensureSandbox(sessionId))) {
      if (trial.started_at && now - Date.parse(trial.started_at) > PROVISION_TIMEOUT_MS) {
        failTrial(trial, `sandbox did not start within ${PROVISION_TIMEOUT_MS / 60_000} minutes`, now);
        return true;
      }
      return false;
    }
    await startHarborOracle(harborTask, sandbox, runtime);
    trial.phase = "agent";
    trial.agent_started_at = iso(deps.now());
    trial.attempts = 0;
    return true;
  }

  if (trial.phase === "agent" && run.mode === "oracle") {
    const state = await pollDetached(sandbox, "oracle");
    if (!state.done) {
      const deadline = agentDeadline(trial.agent_started_at);
      if (deadline === null || now <= deadline) return false;
      await killDetached(sandbox, "oracle");
      trial.agent_timed_out = true;
    }
    await startVerifier(trial, harborTask, sandbox, runtime, deps.now());
    return true;
  }

  if (trial.phase === "agent") {
    if (!trial.message_event_id) { failTrial(trial, "agent trial has no message id", now); return true; }
    const settled = await deps.runtime.settledAfter(sessionId, trial.message_event_id);
    if (!settled.settled) {
      if (trial.interrupted_at) {
        if (now - Date.parse(trial.interrupted_at) > INTERRUPT_GRACE_MS) {
          failTrial(trial, `agent did not stop within ${INTERRUPT_GRACE_MS / 1000}s after the timeout interrupt`, now);
          return true;
        }
        return false;
      }
      const deadline = agentDeadline(trial.agent_started_at);
      if (deadline === null || now <= deadline) return false;
      // Harbor stops the agent at its timeout and still runs the verifier.
      await deps.runtime.interrupt(sessionId);
      trial.agent_timed_out = true;
      trial.interrupted_at = iso(now);
      return true;
    }
    trial.stop_reason = settled.stopReason;
    if (settled.stopReason === "session_not_found" || settled.stopReason === "terminated") {
      failTrial(trial, `Session ${settled.stopReason === "terminated" ? "terminated" : "disappeared"} before grading`, now);
      return true;
    }
    // ADR 0016: the agent's commands ran in the workspace root, which must be
    // the image WORKDIR, or the score is not comparable with Harbor's.
    const expected = requireAgentWorkdir(harborTask, runtime.workdir);
    const probe = (await runInTask(sandbox, `printf '__OMA_PWD__%s__OMA_PWD__' "$(pwd)"`, { workdir: null })).output;
    const observed = /__OMA_PWD__(.*?)__OMA_PWD__/su.exec(probe)?.[1] ?? probe;
    if (observed !== expected) {
      failTrial(trial, `agent workspace root is ${observed}, image WORKDIR is ${expected}`, now);
      return true;
    }
    await startVerifier(trial, harborTask, sandbox, runtime, deps.now());
    return true;
  }

  if (trial.phase === "verifying") {
    const state = await pollDetached(sandbox, "verifier");
    if (!state.done) {
      const started = trial.verify_started_at ? Date.parse(trial.verify_started_at) : now;
      if (now - started <= harborTask.verifierTimeoutSec * 1000 + 30_000) return false;
      await killDetached(sandbox, "verifier");
      failTrial(trial, `verifier timed out after ${harborTask.verifierTimeoutSec}s`, now);
      await deps.runtime.releaseSandbox(sessionId).catch(() => undefined);
      return true;
    }
    try {
      const verification = await readHarborVerification(sandbox, runtime, state.exitCode);
      trial.rewards = verification.rewards;
      trial.reward = verification.rewards.reward ?? (Object.keys(verification.rewards).length === 1 ? Object.values(verification.rewards)[0] : undefined);
      trial.test_exit_code = verification.testExitCode;
      trial.verifier_output_tail = verification.testOutputTail;
      if (trial.reward === undefined) {
        failTrial(trial, `reward.json has no "reward" key (keys: ${Object.keys(verification.rewards).join(", ")})`, deps.now());
      } else {
        trial.status = "completed";
        trial.phase = "done";
        trial.ended_at = iso(deps.now());
        delete trial.error;
      }
    } catch (error) {
      trial.test_exit_code = state.exitCode;
      failTrial(trial, message(error), deps.now(), (error as { testOutputTail?: string }).testOutputTail);
    }
    await deps.runtime.releaseSandbox(sessionId).catch(() => undefined);
    return true;
  }

  failTrial(trial, `unknown trial phase ${String(trial.phase)}`, now);
  return true;
}

/**
 * Harbor's mean metric: every finished trial counts, an errored trial as 0.
 * A task is completed once all its trials finished and at least one was
 * graded; failed when none could be graded.
 */
export function summariseHarborTask(task: EvalTaskResult) {
  const finished = task.trials.filter((trial) => trial.status === "completed" || trial.status === "failed" || trial.status === "cancelled");
  const graded = task.trials.filter((trial) => trial.status === "completed");
  task.trial_total = task.trials.length;
  task.trial_pass_count = graded.filter((trial) => (trial.reward ?? 0) >= 1).length;
  if (finished.length > 0) {
    task.mean_reward = finished.reduce((sum, trial) => sum + (trial.status === "completed" ? trial.reward ?? 0 : 0), 0) / finished.length;
  }
  if (finished.length < task.trials.length) {
    task.status = task.trials.some((trial) => trial.status !== "pending") ? "running" : "pending";
    return;
  }
  if (graded.length > 0) { task.status = "completed"; delete task.error; }
  else { task.status = "failed"; task.error = task.trials.find((trial) => trial.error)?.error; }
}
