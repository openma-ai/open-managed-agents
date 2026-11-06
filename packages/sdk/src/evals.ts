import Anthropic, { toFile } from "@anthropic-ai/sdk";

// OpenMA evals (/v1/oma/evals): benchmarks → cases, and eval runs.
//
// The wire types below are restated from the private
// @open-managed-agents/api-types package (packages/api-types/src/evals.ts)
// with identical names and fields; @openma/sdk must not depend on it.
//
// Endpoints (all JSON, header anthropic-beta: managed-agents-2026-04-01):
//   GET    /v1/oma/evals/benchmarks                  -> { data: EvalBenchmark[] }   (no cases)
//   GET    /v1/oma/evals/benchmarks/builtin          -> { data: BuiltinEvalBenchmark[] }
//   POST   /v1/oma/evals/benchmarks                  CreateEvalBenchmarkRequest -> EvalBenchmark (with cases)
//   GET    /v1/oma/evals/benchmarks/:id              -> EvalBenchmark (with cases)
//   PATCH  /v1/oma/evals/benchmarks/:id              UpdateEvalBenchmarkRequest -> EvalBenchmark
//   DELETE /v1/oma/evals/benchmarks/:id              -> { type: "eval_benchmark_deleted", id }
//   GET    /v1/oma/evals/benchmarks/:id/cases/:name  -> EvalCaseDetail
//   POST   /v1/oma/evals/benchmarks/:id/cases        AddEvalCasesRequest -> EvalBenchmark (with cases)
//   PUT    /v1/oma/evals/benchmarks/:id/cases/:name  ReplaceEvalCaseRequest -> EvalCaseDetail
//   DELETE /v1/oma/evals/benchmarks/:id/cases/:name  -> { type: "eval_case_deleted", benchmark_id, name }
//   POST   /v1/oma/evals/runs                        CreateEvalRunRequest -> CreateEvalRunResponse
//   GET    /v1/oma/evals/runs?status=&agent_id=&benchmark_id=&limit= -> { data: EvalRun[] }
//   GET    /v1/oma/evals/runs/:id                    -> EvalRun
//   POST   /v1/oma/evals/runs/:id/cancel             -> EvalRun
//   DELETE /v1/oma/evals/runs/:id                    -> { type: "eval_run_deleted", id }

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
       * solution/solve.sh and rejects agent_id (400). messages benchmarks
       * accept "agent" only. */
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
  /** harbor: mean over every finished trial, errored trials counting 0.
   *  messages: mean over completed trials. */
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

// ── SDK request/response helpers ─────────────────────────────────────────

export interface EvalBenchmarkListResponse {
  data: EvalBenchmark[];
}

export interface BuiltinEvalBenchmarkListResponse {
  data: BuiltinEvalBenchmark[];
}

export interface EvalBenchmarkDeleted {
  type: "eval_benchmark_deleted";
  id: string;
}

export interface EvalCaseDeleted {
  type: "eval_case_deleted";
  benchmark_id: string;
  name: string;
}

export interface EvalRunListParams {
  status?: EvalRunStatus;
  agent_id?: string;
  benchmark_id?: string;
  limit?: number;
}

export interface EvalRunListResponse {
  data: EvalRun[];
}

export interface EvalRunDeleted {
  type: "eval_run_deleted";
  id: string;
}

/** A .tar/.tar.gz archive to send through the Files API. */
export interface EvalArchiveUpload {
  /** A .tar or .tar.gz archive containing Harbor task directories. */
  file: Blob | Uint8Array;
  /** File name sent to the Files API; must end in .tar, .tar.gz or .tgz. */
  filename: string;
}

export interface UploadEvalBenchmarkParams extends EvalArchiveUpload {
  /** Benchmark name; the server defaults to the upload file name. */
  name?: string;
  /** Import only these tasks from the archive. */
  case_names?: string[];
}

export interface UploadEvalCasesParams extends EvalArchiveUpload {
  /** Add only these tasks from the archive. */
  case_names?: string[];
}

/** The archive must hold exactly one Harbor task directory. */
export type UploadReplaceEvalCaseParams = EvalArchiveUpload;

export interface WaitForEvalRunOptions {
  /** Delay between polls. Default 5000 ms. */
  intervalMs?: number;
  /** Give up after this long (throws). Default: no timeout. */
  timeoutMs?: number;
  /** Called with every polled run, including the terminal one. */
  onProgress?: (run: EvalRun) => void;
  /** Aborts the wait (rejects with the signal's reason). */
  signal?: AbortSignal;
  requestOptions?: Anthropic.RequestOptions;
}

export const EVAL_RUN_TERMINAL_STATUSES: readonly EvalRunStatus[] = ["completed", "failed", "cancelled"];

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const ARCHIVE_NAME = /\.(tar|tar\.gz|tgz)$/i;

/** Add the Managed Agents beta header unless the caller already set one. */
function withBeta(options?: Anthropic.RequestOptions): Anthropic.RequestOptions {
  const headers = options?.headers;
  if (headers == null) return { ...options, headers: { "anthropic-beta": MANAGED_AGENTS_BETA } };
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    if (!merged.has("anthropic-beta")) merged.set("anthropic-beta", MANAGED_AGENTS_BETA);
    return { ...options, headers: merged };
  }
  if (Array.isArray(headers)) {
    const has = headers.some((h) => String(h[0]).toLowerCase() === "anthropic-beta");
    return { ...options, headers: has ? headers : [["anthropic-beta", MANAGED_AGENTS_BETA], ...headers] };
  }
  const record = headers as Record<string, unknown>;
  const has = Object.keys(record).some((k) => k.toLowerCase() === "anthropic-beta");
  return { ...options, headers: has ? headers : { "anthropic-beta": MANAGED_AGENTS_BETA, ...record } } as Anthropic.RequestOptions;
}

function enc(id: string): string {
  if (typeof id !== "string" || id.length === 0) throw new TypeError("id must be a non-empty string");
  return encodeURIComponent(id);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Upload an archive through the Files API and return its file id. */
async function uploadArchive(client: Anthropic, params: EvalArchiveUpload, options?: Anthropic.RequestOptions): Promise<string> {
  if (!params.filename || !ARCHIVE_NAME.test(params.filename)) {
    throw new TypeError("filename must end in .tar, .tar.gz or .tgz");
  }
  const file = await toFile(params.file, params.filename, {
    type: /\.tar$/i.test(params.filename) ? "application/x-tar" : "application/gzip",
  });
  const uploaded = await client.beta.files.upload(
    // The Files API checks its own beta flag in addition to ours.
    { file, betas: [MANAGED_AGENTS_BETA, "files-api-2025-04-14"] },
    options,
  );
  return uploaded.id;
}

/** Cases of one benchmark: /v1/oma/evals/benchmarks/:id/cases. */
export class EvalCasesResource {
  constructor(private readonly client: Anthropic) {}

  private path(benchmarkId: string, name?: string): string {
    const base = `/v1/oma/evals/benchmarks/${enc(benchmarkId)}/cases`;
    return name === undefined ? base : `${base}/${enc(name)}`;
  }

  retrieve(benchmarkId: string, name: string, options?: Anthropic.RequestOptions) {
    return this.client.get<EvalCaseDetail>(this.path(benchmarkId, name), withBeta(options));
  }

  /** messages benchmark: one case. harbor benchmark: every task of a source (or case_names of it). */
  add(benchmarkId: string, params: AddEvalCasesRequest, options?: Anthropic.RequestOptions) {
    return this.client.post<EvalBenchmark>(this.path(benchmarkId), { body: params, ...withBeta(options) });
  }

  replace(benchmarkId: string, name: string, params: ReplaceEvalCaseRequest, options?: Anthropic.RequestOptions) {
    return this.client.put<EvalCaseDetail>(this.path(benchmarkId, name), { body: params, ...withBeta(options) });
  }

  delete(benchmarkId: string, name: string, options?: Anthropic.RequestOptions) {
    return this.client.delete<EvalCaseDeleted>(this.path(benchmarkId, name), withBeta(options));
  }

  /** harbor: upload a .tar/.tar.gz through the Files API, then add its tasks as cases. */
  async upload(benchmarkId: string, params: UploadEvalCasesParams, options?: Anthropic.RequestOptions): Promise<EvalBenchmark> {
    enc(benchmarkId);
    const fileId = await uploadArchive(this.client, params, options);
    return this.add(benchmarkId, {
      source: { type: "upload", file_id: fileId },
      ...(params.case_names?.length ? { case_names: params.case_names } : {}),
    }, options);
  }

  /** harbor: upload an archive holding one task directory and replace the case's files with it. */
  async replaceUpload(benchmarkId: string, name: string, params: UploadReplaceEvalCaseParams, options?: Anthropic.RequestOptions): Promise<EvalCaseDetail> {
    enc(benchmarkId);
    enc(name);
    const fileId = await uploadArchive(this.client, params, options);
    return this.replace(benchmarkId, name, { source: { type: "upload", file_id: fileId } }, options);
  }
}

export class EvalBenchmarksResource {
  readonly cases: EvalCasesResource;

  constructor(private readonly client: Anthropic) {
    this.cases = new EvalCasesResource(client);
  }

  list(options?: Anthropic.RequestOptions) {
    return this.client.get<EvalBenchmarkListResponse>("/v1/oma/evals/benchmarks", withBeta(options));
  }

  listBuiltin(options?: Anthropic.RequestOptions) {
    return this.client.get<BuiltinEvalBenchmarkListResponse>("/v1/oma/evals/benchmarks/builtin", withBeta(options));
  }

  /** Import a harbor benchmark from a source, or create an empty harbor / messages benchmark. */
  create(params: CreateEvalBenchmarkRequest, options?: Anthropic.RequestOptions) {
    return this.client.post<EvalBenchmark>("/v1/oma/evals/benchmarks", { body: params, ...withBeta(options) });
  }

  retrieve(id: string, options?: Anthropic.RequestOptions) {
    return this.client.get<EvalBenchmark>(`/v1/oma/evals/benchmarks/${enc(id)}`, withBeta(options));
  }

  update(id: string, params: UpdateEvalBenchmarkRequest, options?: Anthropic.RequestOptions) {
    return this.client.patch<EvalBenchmark>(`/v1/oma/evals/benchmarks/${enc(id)}`, { body: params, ...withBeta(options) });
  }

  delete(id: string, options?: Anthropic.RequestOptions) {
    return this.client.delete<EvalBenchmarkDeleted>(`/v1/oma/evals/benchmarks/${enc(id)}`, withBeta(options));
  }

  /** Upload a .tar/.tar.gz through the Files API, then import it as a harbor benchmark. */
  async upload(params: UploadEvalBenchmarkParams, options?: Anthropic.RequestOptions): Promise<EvalBenchmark> {
    const fileId = await uploadArchive(this.client, params, options);
    return this.create({
      ...(params.name ? { name: params.name } : {}),
      source: { type: "upload", file_id: fileId },
      ...(params.case_names?.length ? { case_names: params.case_names } : {}),
    }, options);
  }
}

export class EvalRunsResource {
  constructor(private readonly client: Anthropic) {}

  create(params: CreateEvalRunRequest, options?: Anthropic.RequestOptions) {
    return this.client.post<CreateEvalRunResponse>("/v1/oma/evals/runs", { body: params, ...withBeta(options) });
  }

  list(params: EvalRunListParams = {}, options?: Anthropic.RequestOptions) {
    return this.client.get<EvalRunListResponse>("/v1/oma/evals/runs", { query: params, ...withBeta(options) });
  }

  retrieve(id: string, options?: Anthropic.RequestOptions) {
    return this.client.get<EvalRun>(`/v1/oma/evals/runs/${enc(id)}`, withBeta(options));
  }

  cancel(id: string, options?: Anthropic.RequestOptions) {
    return this.client.post<EvalRun>(`/v1/oma/evals/runs/${enc(id)}/cancel`, withBeta(options));
  }

  delete(id: string, options?: Anthropic.RequestOptions) {
    return this.client.delete<EvalRunDeleted>(`/v1/oma/evals/runs/${enc(id)}`, withBeta(options));
  }

  /** Poll until the run is completed, failed or cancelled; resolves with the terminal run. */
  async waitForRun(id: string, opts: WaitForEvalRunOptions = {}): Promise<EvalRun> {
    const intervalMs = opts.intervalMs ?? 5000;
    if (!(intervalMs >= 0)) throw new RangeError("intervalMs must be >= 0");
    if (opts.timeoutMs !== undefined && !(opts.timeoutMs > 0)) throw new RangeError("timeoutMs must be > 0");
    const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      const signal = opts.signal ?? opts.requestOptions?.signal ?? undefined;
      const run = await this.retrieve(id, { ...opts.requestOptions, ...(signal ? { signal } : {}) });
      opts.onProgress?.(run);
      if (EVAL_RUN_TERMINAL_STATUSES.includes(run.status)) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out after ${opts.timeoutMs} ms waiting for eval run ${id} (status: ${run.status})`);
      }
      await sleep(Math.min(intervalMs, remaining), opts.signal);
    }
  }
}

export class EvalsResource {
  readonly benchmarks: EvalBenchmarksResource;
  readonly runs: EvalRunsResource;

  constructor(client: Anthropic) {
    this.benchmarks = new EvalBenchmarksResource(client);
    this.runs = new EvalRunsResource(client);
  }
}
