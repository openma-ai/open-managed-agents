// Run state persisted opaquely in EvalRunRow.results (no schema change), and
// its projection to the public EvalRun wire shape
// (@open-managed-agents/api-types evals.ts).

import type { RewardSpec } from "@open-managed-agents/shared";
import type { EvalRunRow, EvalRunStatus } from "@open-managed-agents/evals-store";
import type { EvalRun, EvalRunTask, EvalTrial, EvalTrialPhase } from "@open-managed-agents/api-types";

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  /** Bash run in the Session sandbox before the first message. */
  setup_script?: string;
  messages: string[];
  timeout_ms?: number;
  trials?: number;
  reward?: RewardSpec;
}

export type { EvalRunStatus };

export interface EvalTrialResult {
  trial_index: number;
  status: EvalRunStatus;
  phase?: EvalTrialPhase;
  session_id?: string;
  started_at?: string;
  ended_at?: string;
  reward?: number;
  rewards?: Record<string, number>;
  agent_timed_out?: boolean;
  test_exit_code?: number;
  verifier_output_tail?: string;
  error?: string;
  trajectory_id?: string;
  current_message_index?: number;
  finalize_retry_count?: number;
  // ── internal (not part of the wire shape) ──
  /** user.message whose turn we wait for. */
  message_event_id?: string;
  agent_started_at?: string;
  interrupted_at?: string;
  verify_started_at?: string;
  stop_reason?: string | null;
  /** Consecutive transient failures in the current phase. */
  attempts?: number;
}

/** Harbor runs commands in the image's WORKDIR with its ENV. */
export interface HarborTaskRuntimeConfig {
  workdir: string | null;
  env: Record<string, string>;
}

export interface EvalTaskResult {
  id: string;
  /** messages kind only. */
  spec?: EvalTaskSpec;
  status: EvalRunStatus;
  trials: EvalTrialResult[];
  trial_pass_count?: number;
  trial_total?: number;
  mean_reward?: number;
  error?: string;
  image_alias?: string;
  runtime?: HarborTaskRuntimeConfig;
  runtime_attempts?: number;
}

export interface EvalRunRecord {
  id: string;
  tenant_id: string;
  kind: "messages" | "harbor";
  agent_id: string | null;
  environment_id: string | null;
  /** Set when the run executes a benchmark. */
  benchmark_id?: string;
  mode?: "agent" | "oracle";
  concurrency?: number;
  status: EvalRunStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  score?: number;
  tasks: EvalTaskResult[];
  /** harbor: environment id per SANDBOX_IMAGES alias, created on demand. */
  environments?: Record<string, string>;
  error?: string;
}

type StoredResults = Omit<EvalRunRecord, "id" | "tenant_id" | "status" | "created_at" | "started_at" | "ended_at" | "error">;

/** Runs created before the benchmark rename stored `dataset_id`. */
type LegacyStoredResults = Partial<StoredResults> & { dataset_id?: string };

/** EvalRunRow (storage) -> EvalRunRecord (runner + routes). */
export function rowToRecord(row: EvalRunRow): EvalRunRecord {
  const partial = (row.results ?? {}) as LegacyStoredResults;
  const benchmarkId = partial.benchmark_id ?? partial.dataset_id;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: partial.kind ?? "messages",
    // Harbor runs store "" in the NOT NULL columns; the real values live here.
    agent_id: partial.agent_id !== undefined ? partial.agent_id : (row.agent_id || null),
    environment_id: partial.environment_id !== undefined ? partial.environment_id : (row.environment_id || null),
    ...(benchmarkId !== undefined ? { benchmark_id: benchmarkId } : {}),
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    ...(partial.concurrency !== undefined ? { concurrency: partial.concurrency } : {}),
    ...(partial.environments !== undefined ? { environments: partial.environments } : {}),
    ...(partial.score !== undefined ? { score: partial.score } : {}),
    status: row.status as EvalRunStatus,
    created_at: row.started_at,
    started_at: row.started_at,
    ended_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks: partial.tasks ?? [],
  };
}

export function extractResults(run: EvalRunRecord): StoredResults {
  return {
    kind: run.kind,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    ...(run.benchmark_id !== undefined ? { benchmark_id: run.benchmark_id } : {}),
    ...(run.mode !== undefined ? { mode: run.mode } : {}),
    ...(run.concurrency !== undefined ? { concurrency: run.concurrency } : {}),
    ...(run.environments !== undefined ? { environments: run.environments } : {}),
    ...(run.score !== undefined ? { score: run.score } : {}),
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    tasks: run.tasks,
  };
}

function trialToApi(trial: EvalTrialResult): EvalTrial {
  const out: EvalTrial = { trial_index: trial.trial_index, status: trial.status };
  const keys = [
    "phase", "session_id", "started_at", "ended_at", "reward", "rewards", "agent_timed_out",
    "test_exit_code", "verifier_output_tail", "error", "trajectory_id", "current_message_index",
  ] as const;
  for (const key of keys) {
    if (trial[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = trial[key];
  }
  return out;
}

export function recordToApi(run: EvalRunRecord): EvalRun & { tenant_id: string } {
  return {
    id: run.id,
    tenant_id: run.tenant_id,
    kind: run.kind,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    ...(run.benchmark_id !== undefined ? { benchmark_id: run.benchmark_id } : {}),
    ...(run.mode !== undefined ? { mode: run.mode } : {}),
    status: run.status,
    created_at: run.created_at,
    ...(run.started_at !== undefined ? { started_at: run.started_at } : {}),
    ...(run.ended_at !== undefined ? { ended_at: run.ended_at } : {}),
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    ...(run.score !== undefined ? { score: run.score } : {}),
    ...(run.concurrency !== undefined ? { concurrency: run.concurrency } : {}),
    tasks: run.tasks.map((task): EvalRunTask & { spec?: EvalTaskSpec } => ({
      id: task.id,
      status: task.status,
      trials: task.trials.map(trialToApi),
      trial_total: task.trial_total ?? task.trials.length,
      ...(task.trial_pass_count !== undefined ? { trial_pass_count: task.trial_pass_count } : {}),
      ...(task.mean_reward !== undefined ? { mean_reward: task.mean_reward } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      ...(task.image_alias !== undefined ? { image_alias: task.image_alias } : {}),
      ...(task.spec !== undefined ? { spec: task.spec } : {}),
    })),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

export function kvKey(tenantId: string, ...parts: string[]): string {
  return `t:${tenantId}:${parts.join(":")}`;
}

export function isTerminal(status: EvalRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
