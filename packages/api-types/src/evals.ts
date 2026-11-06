// Wire format for /v1/oma/evals: three layers.
//
//   Benchmark  a named set of cases, one kind per benchmark:
//                "harbor"   cases are Harbor-format tasks (imported from the
//                           builtin set, a Harbor registry, or an uploaded
//                           .tar/.tar.gz). Each case's image runs as the
//                           Session sandbox, instruction.md is the first user
//                           message, then tests/test.sh writes
//                           /logs/verifier/reward.{txt,json}. mode "oracle"
//                           runs solution/solve.sh instead of an agent.
//                "messages" cases are OMA's scripted conversations: user
//                           messages sent in order, then an eval-core
//                           RewardSpec grades the Session.
//   Case       one task of a benchmark, managed one by one (add, edit or
//              replace, delete). Cases are copied into a run when it is
//              created, except harbor files, which trials read from the
//              benchmark; cases cannot change while a run of the benchmark
//              is active (409).
//   Eval run   one execution of a benchmark (all or some cases) against an
//              agent, or inline messages tasks (the original API, kept).
//
// Runs execute on managed Sessions on every runtime (Node and Cloudflare).

// Endpoints (all JSON, header anthropic-beta: managed-agents-2026-04-01):
//   GET    /v1/oma/evals/benchmarks                  -> { data: EvalBenchmark[] }   (no cases)
//   GET    /v1/oma/evals/benchmarks/builtin          -> { data: BuiltinEvalBenchmark[] }
//   POST   /v1/oma/evals/benchmarks                  CreateEvalBenchmarkRequest -> 201 EvalBenchmark (with cases)
//   GET    /v1/oma/evals/benchmarks/:id              -> EvalBenchmark (with cases)
//   PATCH  /v1/oma/evals/benchmarks/:id              UpdateEvalBenchmarkRequest -> EvalBenchmark (with cases)
//   DELETE /v1/oma/evals/benchmarks/:id              -> { type: "eval_benchmark_deleted", id }   (409 while a run is active)
//   GET    /v1/oma/evals/benchmarks/:id/cases/:name  -> EvalCaseDetail
//   POST   /v1/oma/evals/benchmarks/:id/cases        AddEvalCasesRequest -> 201 EvalBenchmark (with cases)
//   PUT    /v1/oma/evals/benchmarks/:id/cases/:name  ReplaceEvalCaseRequest -> EvalCaseDetail
//   DELETE /v1/oma/evals/benchmarks/:id/cases/:name  -> { type: "eval_case_deleted", benchmark_id, name }
//   POST   /v1/oma/evals/runs                        CreateEvalRunRequest -> CreateEvalRunResponse
//   GET    /v1/oma/evals/runs?status=&agent_id=&benchmark_id=&limit= -> { data: EvalRun[] }
//   GET    /v1/oma/evals/runs/:id                    -> EvalRun
//   POST   /v1/oma/evals/runs/:id/cancel             -> EvalRun (status "cancelled"; sessions interrupted)
//   DELETE /v1/oma/evals/runs/:id                    -> { type: "eval_run_deleted", id }
// Errors: 4xx/5xx with { error: string }. Case writes and benchmark delete
// return 409 while a pending/running run uses the benchmark; adding a case
// whose name exists returns 409.

// ── Benchmarks ────────────────────────────────────────────────────────────

export type EvalBenchmarkKind = "harbor" | "messages";

/** Where harbor cases come from (benchmark import, or adding cases later). */
export type HarborCaseSource =
  /** A .tar or .tar.gz uploaded through the Files API. Task directories are
   *  found anywhere in the archive by their task.toml. */
  | { type: "upload"; file_id: string }
  /** A dataset from a Harbor registry (default: Harbor's public registry). */
  | { type: "registry"; name: string; version?: string; registry_url?: string }
  /** A dataset shipped with OMA; see GET /v1/oma/evals/benchmarks/builtin. */
  | { type: "builtin"; name: string };

/** A messages case as written by clients (create, add, replace). */
export interface MessagesCaseInput {
  /** [A-Za-z0-9][A-Za-z0-9._-]{0,127}; unique in the benchmark. Ignored on
   *  replace (the path names the case). */
  name: string;
  /** User messages sent in order, each after the previous turn ends. */
  messages: string[];
  /** eval-core RewardSpec; type must be verifiable | script | reward_model | composite (else 400). */
  reward?: unknown;
  setup_files?: { path: string; content: string }[];
  /** Bash run in the Session sandbox before the first message. */
  setup_script?: string;
  timeout_ms?: number;
}

export type CreateEvalBenchmarkRequest =
  /** Import a harbor benchmark. name defaults to the registry/builtin name or
   *  the upload file name. */
  | { kind?: "harbor"; name?: string; source: HarborCaseSource; case_names?: string[] }
  /** An empty harbor benchmark (add cases later), or a messages benchmark
   *  with optional initial cases. name is required. */
  | { kind: "harbor" | "messages"; name: string; source?: undefined; cases?: MessagesCaseInput[] };

export interface UpdateEvalBenchmarkRequest {
  name?: string;
}

export type AddEvalCasesRequest =
  /** messages benchmark: one case. */
  | MessagesCaseInput
  /** harbor benchmark: every task found in the source (or case_names of it). */
  | { source: HarborCaseSource; case_names?: string[] };

export type ReplaceEvalCaseRequest =
  /** messages benchmark: the new case content. */
  | MessagesCaseInput
  /** harbor benchmark: an upload holding exactly one task directory; its
   *  files replace the case's files and the case keeps its name. */
  | { source: { type: "upload"; file_id: string } };

/** A harbor case as listed in a benchmark. */
export interface HarborEvalCase {
  kind: "harbor";
  name: string;
  /** [environment].docker_image from task.toml. */
  image: string;
  /** SANDBOX_IMAGES alias whose reference equals `image`; null when the
   *  operator catalog has none (the case cannot run until one is added). */
  image_alias: string | null;
  /** false when the task uses a Harbor feature OMA does not run yet. */
  supported: boolean;
  unsupported_reason?: string;
  agent_timeout_sec: number | null;
  verifier_timeout_sec: number;
  cpus: number | null;
  memory_mb: number | null;
  has_solution: boolean;
  /** First 2000 characters of instruction.md. */
  instruction_preview: string;
  updated_at: string;
}

/** A messages case as listed in a benchmark (its full content). */
export interface MessagesEvalCase extends Omit<MessagesCaseInput, "reward"> {
  kind: "messages";
  reward?: unknown;
  updated_at: string;
}

export type EvalCase = HarborEvalCase | MessagesEvalCase;

/** GET/PUT of one case: a harbor case adds its full instruction and the
 *  stored files (task.toml, instruction.md, tests/, solution/). */
export type EvalCaseDetail =
  | (HarborEvalCase & {
      instruction: string;
      files: Array<{ path: string; size: number; executable: boolean }>;
    })
  | MessagesEvalCase;

export interface EvalBenchmark {
  id: string;
  name: string;
  kind: EvalBenchmarkKind;
  /** Harbor source the benchmark was imported from; null when created empty. */
  source: HarborCaseSource | null;
  case_count: number;
  /** harbor: cases supported and with an image alias. messages: case_count. */
  runnable_count: number;
  created_at: string;
  updated_at: string;
  cases?: EvalCase[]; // present on GET /benchmarks/:id and write responses
}

export interface BuiltinEvalBenchmark {
  name: string;
  description: string;
  case_count: number;
}

// ── Runs ──────────────────────────────────────────────────────────────────

export type EvalRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type CreateEvalRunRequest =
  /** Run a benchmark (all runnable cases, or case_names). The run's kind is
   *  the benchmark's kind. */
  | {
      benchmark_id: string;
      /** harbor only: "agent" (default) needs agent_id; "oracle" runs
       * solution/solve.sh in a Session owned by a hidden platform agent and
       * rejects agent_id (400). messages benchmarks accept "agent" only. */
      mode?: "agent" | "oracle";
      agent_id?: string;
      /** messages benchmarks: required (the Session environment). harbor:
       *  rejected (400); each case's image picks its environment. */
      environment_id?: string;
      /** Subset of the benchmark; default every runnable case. */
      case_names?: string[];
      /** Trials per case, default 1, max 20. */
      trials?: number;
      /** Trials running at once, default 4, max 32. */
      concurrency?: number;
    }
  /** Inline messages tasks (the original API, unchanged). */
  | {
      kind?: "messages";
      agent_id: string;
      environment_id: string;
      tasks: Array<{
        id: string;
        messages: string[];
        setup_files?: { path: string; content: string }[];
        setup_script?: string;
        timeout_ms?: number;
        trials?: number;
        /** eval-core RewardSpec; type must be verifiable | script | reward_model | composite (else 400). */
        reward?: unknown;
      }>;
    };

export interface CreateEvalRunResponse {
  run_id: string;
  task_count: number;
}

export type EvalTrialPhase =
  | "provisioning" // session/sandbox being prepared
  | "agent"        // agent (or oracle solve.sh) is working
  | "verifying"    // tests/test.sh running
  | "done";

export interface EvalTrial {
  trial_index: number;
  status: EvalRunStatus;
  phase?: EvalTrialPhase;
  session_id?: string;
  started_at?: string;
  ended_at?: string;
  /** Final reward (Harbor: rewards.reward; messages: verifier final_reward). */
  reward?: number;
  /** Every key of reward.json (Harbor) or raw verifier rewards. */
  rewards?: Record<string, number>;
  /** The agent hit the task's agent timeout and was interrupted; still graded. */
  agent_timed_out?: boolean;
  test_exit_code?: number;
  /** Last 4000 bytes of /logs/verifier/test-stdout.txt. */
  verifier_output_tail?: string;
  error?: string;
  /** messages kind only. */
  trajectory_id?: string;
  current_message_index?: number;
}

export interface EvalRunTask {
  /** Case name (benchmark runs) or inline task id. */
  id: string;
  status: EvalRunStatus;
  trials: EvalTrial[];
  trial_total: number;
  trial_pass_count?: number;
  /** harbor: mean over every finished trial, errored trials counting 0 (Harbor's
   * convention). messages: mean over completed trials. */
  mean_reward?: number;
  error?: string;
  /** harbor kind: image alias used. */
  image_alias?: string;
}

export interface EvalRun {
  id: string;
  kind: "messages" | "harbor";
  agent_id: string | null;
  environment_id: string | null;
  /** Set when the run executes a benchmark. */
  benchmark_id?: string;
  mode?: "agent" | "oracle";
  status: EvalRunStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  /** Mean of per-task mean_reward over tasks with at least one graded trial. */
  score?: number;
  concurrency?: number;
  tasks: EvalRunTask[];
  error?: string;
}
