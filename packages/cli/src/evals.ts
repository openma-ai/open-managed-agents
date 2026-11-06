import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type {
  AddEvalCasesRequest,
  BuiltinEvalBenchmark,
  CreateEvalBenchmarkRequest,
  CreateEvalRunRequest,
  CreateEvalRunResponse,
  EvalBenchmark,
  EvalCase,
  EvalCaseDetail,
  EvalRun,
  EvalRunStatus,
  EvalRunTask,
  HarborCaseSource,
  HarborEvalCase,
  MessagesCaseInput,
  ReplaceEvalCaseRequest,
} from "@open-managed-agents/api-types";

// `oma evals …` — eval benchmarks, their cases, and eval runs (/v1/oma/evals).
// Transport is injected (like mcp-connect.ts) so commands are unit-testable.

export interface EvalsIO {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  /** Upload bytes through POST /v1/files (multipart) and return the file id. */
  upload(filename: string, bytes: Uint8Array, contentType: string): Promise<{ id: string }>;
  print(text: string): void;
  error(text: string): void;
  sleep(ms: number): Promise<void>;
  json: boolean;
  /** Poll interval for --wait. Default 5000 ms. */
  pollIntervalMs?: number;
}

export class EvalsUsageError extends Error {}

export interface EvalsCommandSpec {
  match: string[];
  needsArg?: boolean;
  usage: string;
  desc: string;
  http: string;
}

const HARBOR_SOURCE_FLAGS = "--builtin <name> | --registry <name>[@version] [--registry-url <url>]";

export const EVALS_COMMANDS: EvalsCommandSpec[] = [
  { match: ["evals", "benchmarks", "list"], usage: "oma evals benchmarks list", desc: "List eval benchmarks",
    http: "GET    /v1/oma/evals/benchmarks                    List benchmarks (no cases)" },
  { match: ["evals", "benchmarks", "builtin"], usage: "oma evals benchmarks builtin", desc: "List Harbor datasets shipped with OMA",
    http: "GET    /v1/oma/evals/benchmarks/builtin            List builtin benchmarks" },
  { match: ["evals", "benchmarks", "show"], needsArg: true, usage: "oma evals benchmarks show <id>", desc: "Show a benchmark and its cases",
    http: "GET    /v1/oma/evals/benchmarks/:id                Get benchmark (with cases)" },
  { match: ["evals", "benchmarks", "create"], usage: "oma evals benchmarks create --name <n> --kind messages|harbor",
    desc: "Create an empty benchmark (add cases with oma evals cases add)",
    http: "POST   /v1/oma/evals/benchmarks                    Create benchmark {kind, name} or {source, name?, case_names?}" },
  { match: ["evals", "benchmarks", "import"],
    usage: `oma evals benchmarks import ${HARBOR_SOURCE_FLAGS} [--case <name> ...] [--name <n>]`,
    desc: "Import a builtin or Harbor registry dataset as a harbor benchmark",
    http: "POST   /v1/oma/evals/benchmarks                    {name?, source:{type:builtin|registry,...}, case_names?}" },
  { match: ["evals", "benchmarks", "upload"], needsArg: true, usage: "oma evals benchmarks upload <dir|archive.tar[.gz]> [--name <n>]",
    desc: "Upload Harbor task dir(s) or a .tar/.tar.gz as a harbor benchmark",
    http: "POST   /v1/files + POST /v1/oma/evals/benchmarks   Upload archive, then create {source:{type:upload,file_id}}" },
  { match: ["evals", "benchmarks", "rename"], needsArg: true, usage: "oma evals benchmarks rename <id> <name>", desc: "Rename a benchmark",
    http: "PATCH  /v1/oma/evals/benchmarks/:id                Update benchmark {name}" },
  { match: ["evals", "benchmarks", "delete"], needsArg: true, usage: "oma evals benchmarks delete <id>", desc: "Delete a benchmark",
    http: "DELETE /v1/oma/evals/benchmarks/:id                Delete benchmark (409 while a run is active)" },
  { match: ["evals", "cases", "show"], needsArg: true, usage: "oma evals cases show <benchmark> <case>", desc: "Show one case in full",
    http: "GET    /v1/oma/evals/benchmarks/:id/cases/:name    Get case" },
  { match: ["evals", "cases", "add"], needsArg: true,
    usage: `oma evals cases add <benchmark> (--file case.json | --from <dir|archive> | ${HARBOR_SOURCE_FLAGS}) [--case <name> ...]`,
    desc: "Add a messages case (--file) or harbor cases (--from, --builtin, --registry)",
    http: "POST   /v1/oma/evals/benchmarks/:id/cases          Add case(s): MessagesCaseInput | {source, case_names?}" },
  { match: ["evals", "cases", "replace"], needsArg: true, usage: "oma evals cases replace <benchmark> <case> (--file case.json | --from <dir|archive>)",
    desc: "Replace a messages case (--file) or a harbor case's files (--from, one task)",
    http: "PUT    /v1/oma/evals/benchmarks/:id/cases/:name    Replace case: MessagesCaseInput | {source:{type:upload,file_id}}" },
  { match: ["evals", "cases", "delete"], needsArg: true, usage: "oma evals cases delete <benchmark> <case>", desc: "Delete a case",
    http: "DELETE /v1/oma/evals/benchmarks/:id/cases/:name    Delete case" },
  { match: ["evals", "run"],
    usage: "oma evals run (--benchmark <id> [--mode agent|oracle] [--agent <id>] [--environment <id>] [--case <name> ...] [--trials N] [--concurrency N]"
      + " | --file tasks.json --agent <id> --environment <id>) [--wait]",
    desc: "Start an eval run (messages benchmarks need --environment; --wait polls until done, non-zero exit if it fails)",
    http: "POST   /v1/oma/evals/runs                          Create run {benchmark_id, mode?, agent_id?, environment_id?, case_names?, trials?, concurrency?} | {agent_id, environment_id, tasks}" },
  { match: ["evals", "runs", "list"], usage: "oma evals runs list [--status <s>] [--benchmark <id>] [--agent <id>] [--limit N]", desc: "List eval runs",
    http: "GET    /v1/oma/evals/runs?status=&agent_id=&benchmark_id=&limit=  List runs" },
  { match: ["evals", "runs", "show"], needsArg: true, usage: "oma evals runs show <id> [--json]", desc: "Show per-case results and overall score",
    http: "GET    /v1/oma/evals/runs/:id                      Get run results" },
  { match: ["evals", "runs", "cancel"], needsArg: true, usage: "oma evals runs cancel <id>", desc: "Cancel a run (interrupts its sessions)",
    http: "POST   /v1/oma/evals/runs/:id/cancel               Cancel run" },
  { match: ["evals", "runs", "delete"], needsArg: true, usage: "oma evals runs delete <id>", desc: "Delete a run",
    http: "DELETE /v1/oma/evals/runs/:id                      Delete run" },
];

const RUN_STATUSES: EvalRunStatus[] = ["pending", "running", "completed", "failed", "cancelled"];
const TERMINAL: EvalRunStatus[] = ["completed", "failed", "cancelled"];
const ARCHIVE_RE = /\.(tar|tar\.gz|tgz)$/i;

// ─── Strict flag parsing ───

interface FlagSpec { single?: string[]; multi?: string[]; bool?: string[] }
interface ParsedFlags {
  single: Record<string, string>;
  multi: Record<string, string[]>;
  bool: Set<string>;
  positionals: string[];
}

export function parseFlags(args: string[], spec: FlagSpec, maxPositionals: number): ParsedFlags {
  const out: ParsedFlags = { single: {}, multi: {}, bool: new Set(), positionals: [] };
  const single = new Set(spec.single ?? []);
  const multi = new Set(spec.multi ?? []);
  const bool = new Set(spec.bool ?? []);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      if (out.positionals.length >= maxPositionals) throw new EvalsUsageError(`Unexpected argument: ${arg}`);
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (bool.has(name)) {
      if (eq !== -1) throw new EvalsUsageError(`${name} does not take a value`);
      out.bool.add(name);
      continue;
    }
    if (!single.has(name) && !multi.has(name)) throw new EvalsUsageError(`Unknown option: ${name}`);
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new EvalsUsageError(`${name} requires a value`);
      i++;
    }
    if (value === "") throw new EvalsUsageError(`${name} requires a non-empty value`);
    if (multi.has(name)) (out.multi[name] ??= []).push(value);
    else {
      if (name in out.single) throw new EvalsUsageError(`${name} given more than once`);
      out.single[name] = value;
    }
  }
  return out;
}

function intFlag(raw: string | undefined, name: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new EvalsUsageError(`${name} must be an integer between ${min} and ${max}`);
  const n = Number(raw);
  if (n < min || n > max) throw new EvalsUsageError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function parseHarborSource(f: ParsedFlags): HarborCaseSource | undefined {
  const builtin = f.single["--builtin"];
  const registry = f.single["--registry"];
  const registryUrl = f.single["--registry-url"];
  if (builtin && registry) throw new EvalsUsageError("Pass only one of --builtin <name> or --registry <name>[@version]");
  if (registryUrl !== undefined && !registry) throw new EvalsUsageError("--registry-url is only valid with --registry");
  if (builtin) return { type: "builtin", name: builtin };
  if (!registry) return undefined;
  const at = registry.lastIndexOf("@");
  const name = at > 0 ? registry.slice(0, at) : registry;
  const version = at > 0 ? registry.slice(at + 1) : undefined;
  if (at > 0 && !version) throw new EvalsUsageError(`Invalid --registry value: ${registry} (expected <name>[@version])`);
  if (registryUrl !== undefined) {
    try { new URL(registryUrl); } catch { throw new EvalsUsageError(`Invalid --registry-url: ${registryUrl}`); }
  }
  return { type: "registry", name, ...(version ? { version } : {}), ...(registryUrl ? { registry_url: registryUrl } : {}) };
}

const SOURCE_SINGLE = ["--builtin", "--registry", "--registry-url"];

export function parseImportArgs(args: string[]): CreateEvalBenchmarkRequest {
  const f = parseFlags(args, { single: [...SOURCE_SINGLE, "--name"], multi: ["--case"] }, 0);
  const source = parseHarborSource(f);
  if (!source) throw new EvalsUsageError("Pass exactly one of --builtin <name> or --registry <name>[@version]");
  const cases = f.multi["--case"];
  return {
    ...(f.single["--name"] ? { name: f.single["--name"] } : {}),
    source,
    ...(cases?.length ? { case_names: cases } : {}),
  };
}

export function parseCreateArgs(args: string[]): CreateEvalBenchmarkRequest {
  const f = parseFlags(args, { single: ["--name", "--kind"] }, 0);
  const name = f.single["--name"];
  if (!name) throw new EvalsUsageError("--name <n> is required. Usage: oma evals benchmarks create --name <n> --kind messages|harbor");
  const kind = f.single["--kind"];
  if (kind !== "messages" && kind !== "harbor") {
    throw new EvalsUsageError(kind === undefined ? "--kind messages|harbor is required" : `--kind must be "messages" or "harbor" (got "${kind}")`);
  }
  return { kind, name };
}

export type ParsedRunArgs = { request: CreateEvalRunRequest; wait: boolean; file?: undefined } | { file: string; agent: string; environment: string; wait: boolean };

export function parseRunArgs(args: string[]): ParsedRunArgs {
  const f = parseFlags(args, {
    single: ["--benchmark", "--file", "--agent", "--environment", "--mode", "--trials", "--concurrency"],
    multi: ["--case"],
    bool: ["--wait"],
  }, 0);
  const benchmark = f.single["--benchmark"];
  const file = f.single["--file"];
  const agent = f.single["--agent"];
  const environment = f.single["--environment"];
  const wait = f.bool.has("--wait");
  if (benchmark && file) throw new EvalsUsageError("Pass either --benchmark <id> or --file tasks.json, not both");
  if (file) {
    const extra = ["--mode", "--trials", "--concurrency"].filter((n) => n in f.single);
    if (f.multi["--case"]) extra.push("--case");
    if (extra.length) throw new EvalsUsageError(`${extra.join(", ")} cannot be used with --file (set them per task in the file)`);
    if (!agent || !environment) throw new EvalsUsageError("--file runs need --agent <id> and --environment <id>");
    return { file, agent, environment, wait };
  }
  if (!benchmark) throw new EvalsUsageError("--benchmark <id> (or --file tasks.json) is required");
  const mode = f.single["--mode"];
  if (mode !== undefined && mode !== "agent" && mode !== "oracle") throw new EvalsUsageError(`--mode must be "agent" or "oracle" (got "${mode}")`);
  if (mode === "oracle") {
    if (agent) throw new EvalsUsageError("--agent cannot be used with --mode oracle (oracle runs solution/solve.sh)");
    if (environment) throw new EvalsUsageError("--environment cannot be used with --mode oracle (harbor cases pick their environment from their image)");
  } else if (!agent) {
    throw new EvalsUsageError("--agent <id> is required (or pass --mode oracle for a harbor benchmark)");
  }
  const trials = intFlag(f.single["--trials"], "--trials", 1, 20);
  const concurrency = intFlag(f.single["--concurrency"], "--concurrency", 1, 32);
  const cases = f.multi["--case"];
  return {
    request: {
      benchmark_id: benchmark,
      ...(mode ? { mode } : {}),
      ...(agent ? { agent_id: agent } : {}),
      ...(environment ? { environment_id: environment } : {}),
      ...(cases?.length ? { case_names: cases } : {}),
      ...(trials !== undefined ? { trials } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    },
    wait,
  };
}

export function parseRunsListArgs(args: string[]): string {
  const f = parseFlags(args, { single: ["--status", "--benchmark", "--agent", "--limit"] }, 0);
  const status = f.single["--status"];
  if (status !== undefined && !RUN_STATUSES.includes(status as EvalRunStatus)) {
    throw new EvalsUsageError(`--status must be one of ${RUN_STATUSES.join(", ")}`);
  }
  const limit = intFlag(f.single["--limit"], "--limit", 1, 1000);
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (f.single["--agent"]) q.set("agent_id", f.single["--agent"]);
  if (f.single["--benchmark"]) q.set("benchmark_id", f.single["--benchmark"]);
  if (limit !== undefined) q.set("limit", String(limit));
  const qs = q.toString();
  return `/v1/oma/evals/runs${qs ? `?${qs}` : ""}`;
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { throw new EvalsUsageError(`Cannot read file: ${path}`); }
  try { return JSON.parse(text); } catch (e) { throw new EvalsUsageError(`Invalid JSON in ${path}: ${(e as Error).message}`); }
}

/** Read a MessagesCaseInput from a JSON file (shape checked lightly; the server validates fully). */
export async function readCaseFile(path: string): Promise<MessagesCaseInput> {
  const v = await readJsonFile(path) as Partial<MessagesCaseInput> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new EvalsUsageError(`${path} must contain a JSON object (a messages case)`);
  if (!Array.isArray(v.messages) || !v.messages.every((m) => typeof m === "string")) {
    throw new EvalsUsageError(`${path}: "messages" must be an array of strings`);
  }
  return v as MessagesCaseInput;
}

type InlineTasks = Extract<CreateEvalRunRequest, { tasks: unknown }>["tasks"];

/** Read inline run tasks: a JSON array of tasks, or an object with a "tasks" array. */
export async function readTasksFile(path: string): Promise<InlineTasks> {
  const v = await readJsonFile(path) as unknown;
  const tasks = Array.isArray(v) ? v : (v && typeof v === "object" ? (v as { tasks?: unknown }).tasks : undefined);
  if (!Array.isArray(tasks) || tasks.length === 0) throw new EvalsUsageError(`${path} must contain a non-empty JSON array of tasks (or {"tasks": [...]})`);
  return tasks as InlineTasks;
}

// ─── Formatting ───

export function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((row) => row.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

const fmtReward = (n: number | undefined) => (typeof n === "number" ? n.toFixed(3) : "—");
const fmtDate = (s: string | undefined) => (s ? new Date(s).toLocaleString() : "—");

function sourceLabel(b: EvalBenchmark): string {
  const s = b.source;
  if (!s) return "—";
  if (s.type === "upload") return `upload:${s.file_id}`;
  if (s.type === "builtin") return `builtin:${s.name}`;
  return `registry:${s.name}${s.version ? `@${s.version}` : ""}`;
}

const harborRunnable = (c: HarborEvalCase) => c.supported && !!c.image_alias;

function harborNote(c: HarborEvalCase): string {
  return !c.supported ? `unsupported: ${c.unsupported_reason ?? "unknown reason"}`
    : !c.image_alias ? `no image alias for ${c.image}` : "";
}

function rewardLabel(reward: unknown): string {
  if (reward && typeof reward === "object" && typeof (reward as { type?: unknown }).type === "string") return (reward as { type: string }).type;
  return reward === undefined ? "—" : "custom";
}

function taskPassed(t: EvalRunTask): string {
  return `${t.trial_pass_count ?? "—"}/${t.trial_total}`;
}

function taskStatus(t: EvalRunTask): string {
  if (t.status !== "running") return t.status;
  const phases = [...new Set(t.trials.filter((tr) => tr.status === "running" && tr.phase).map((tr) => tr.phase!))];
  return phases.length ? `running (${phases.join(",")})` : "running";
}

function casesTable(kind: EvalBenchmark["kind"], cases: EvalCase[]): string {
  if (kind === "harbor") {
    const harbor = cases.filter((c): c is HarborEvalCase => c.kind === "harbor");
    return table([
      ["CASE", "RUNNABLE", "IMAGE ALIAS", "SOLUTION", "AGENT TIMEOUT", "NOTE"],
      ...harbor.map((c) => [
        c.name,
        harborRunnable(c) ? "yes" : "no",
        c.image_alias ?? "—",
        c.has_solution ? "yes" : "no",
        c.agent_timeout_sec != null ? `${c.agent_timeout_sec}s` : "—",
        harborNote(c),
      ]),
    ]);
  }
  return table([
    ["CASE", "MESSAGES", "REWARD", "TIMEOUT", "FIRST MESSAGE"],
    ...cases.filter((c) => c.kind === "messages").map((c) => [
      c.name,
      String(c.messages.length),
      rewardLabel(c.reward),
      c.timeout_ms != null ? `${c.timeout_ms}ms` : "—",
      oneLine(c.messages[0] ?? "", 60),
    ]),
  ]);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatBenchmark(b: EvalBenchmark): string {
  const lines = [
    `Name:     ${b.name}`,
    `ID:       ${b.id}`,
    `Kind:     ${b.kind}`,
    `Source:   ${sourceLabel(b)}`,
    `Cases:    ${b.case_count} (${b.runnable_count} runnable)`,
    `Created:  ${fmtDate(b.created_at)}`,
    `Updated:  ${fmtDate(b.updated_at)}`,
  ];
  if (b.cases?.length) lines.push("", casesTable(b.kind, b.cases));
  return lines.join("\n");
}

export function formatCase(c: EvalCaseDetail): string {
  if (c.kind === "harbor") {
    const lines = [
      `Case:     ${c.name}`,
      `Kind:     harbor`,
      `Image:    ${c.image}${c.image_alias ? ` (alias ${c.image_alias})` : ""}`,
      `Runnable: ${harborRunnable(c) ? "yes" : `no (${harborNote(c)})`}`,
      `Solution: ${c.has_solution ? "yes" : "no"}`,
      `Timeouts: agent ${c.agent_timeout_sec != null ? `${c.agent_timeout_sec}s` : "—"}, verifier ${c.verifier_timeout_sec}s`,
      `Updated:  ${fmtDate(c.updated_at)}`,
    ];
    if (c.files?.length) {
      lines.push("", table([["FILE", "SIZE", "EXEC"], ...c.files.map((f) => [f.path, String(f.size), f.executable ? "yes" : ""])]));
    }
    lines.push("", "Instruction:", c.instruction ?? c.instruction_preview);
    return lines.join("\n");
  }
  const lines = [
    `Case:     ${c.name}`,
    `Kind:     messages`,
    `Timeout:  ${c.timeout_ms != null ? `${c.timeout_ms}ms` : "—"}`,
    `Updated:  ${fmtDate(c.updated_at)}`,
    "",
    "Messages:",
    ...c.messages.map((m, i) => `  ${i + 1}. ${m}`),
  ];
  if (c.setup_files?.length) lines.push("", "Setup files:", ...c.setup_files.map((f) => `  ${f.path} (${f.content.length} chars)`));
  if (c.setup_script) lines.push("", "Setup script:", c.setup_script);
  lines.push("", `Reward:   ${c.reward === undefined ? "—" : JSON.stringify(c.reward)}`);
  return lines.join("\n");
}

export function formatRun(run: EvalRun, benchmark?: Pick<EvalBenchmark, "id" | "name">): string {
  const lines = [
    `Run:       ${run.id}`,
    `Status:    ${run.status}`,
    `Kind:      ${run.kind}${run.mode ? ` (${run.mode})` : ""}`,
  ];
  if (run.benchmark_id) lines.push(`Benchmark: ${benchmark ? `${benchmark.name} (${run.benchmark_id})` : run.benchmark_id}`);
  if (run.agent_id) lines.push(`Agent:     ${run.agent_id}`);
  if (run.environment_id) lines.push(`Env:       ${run.environment_id}`);
  lines.push(`Cases:     ${run.completed_count} completed, ${run.failed_count} failed, ${run.task_count} total`);
  lines.push(`Created:   ${fmtDate(run.created_at)}`);
  if (run.ended_at) lines.push(`Ended:     ${fmtDate(run.ended_at)}`);
  if (run.error) lines.push(`Error:     ${run.error}`);
  if (run.tasks.length) {
    lines.push("", table([
      ["CASE", "STATUS", "PASSED", "MEAN REWARD", "SESSIONS"],
      ...run.tasks.map((t) => [
        t.id,
        taskStatus(t),
        taskPassed(t),
        fmtReward(t.mean_reward),
        t.trials.map((tr) => tr.session_id).filter(Boolean).join(",") || "—",
      ]),
    ]));
    const errors = run.tasks.flatMap((t) => [
      ...(t.error ? [`  ${t.id}: ${t.error}`] : []),
      ...t.trials.filter((tr) => tr.error).map((tr) => `  ${t.id}#${tr.trial_index}: ${tr.error}`),
    ]);
    if (errors.length) lines.push("", "Errors:", ...errors);
  }
  lines.push("", `Score:     ${fmtReward(run.score)}`);
  return lines.join("\n");
}

function progressLine(t: EvalRunTask): string {
  return `  ${t.id}  ${taskStatus(t)}  passed ${taskPassed(t)}  reward ${fmtReward(t.mean_reward)}`;
}

// ─── Tar (ustar + PAX for long names) ───

const enc = new TextEncoder();

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function writeStr(buf: Uint8Array, off: number, len: number, s: string) {
  const b = enc.encode(s);
  if (b.length > len) throw new Error(`tar field overflow: ${s}`);
  buf.set(b, off);
}

function tarHeader(e: { name: string; mode: number; size: number; mtime: number; type: string; linkname?: string }): Uint8Array {
  const h = new Uint8Array(512);
  writeStr(h, 0, 100, e.name);
  writeStr(h, 100, 8, octal(e.mode & 0o7777, 8));
  writeStr(h, 108, 8, octal(0, 8));
  writeStr(h, 116, 8, octal(0, 8));
  writeStr(h, 124, 12, octal(e.size, 12));
  writeStr(h, 136, 12, octal(Math.floor(e.mtime), 12));
  h.fill(0x20, 148, 156);
  writeStr(h, 156, 1, e.type);
  if (e.linkname) writeStr(h, 157, 100, e.linkname);
  writeStr(h, 257, 6, "ustar\0");
  writeStr(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  writeStr(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

function pad512(n: number): Uint8Array {
  return new Uint8Array((512 - (n % 512)) % 512);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = enc.encode(body).length;
  let total = len + String(len).length;
  if (String(total).length !== String(len).length) total = len + String(total).length;
  return `${total}${body}`;
}

function tarEntry(chunks: Uint8Array[], e: { name: string; mode: number; mtime: number; type: string; linkname?: string; data?: Uint8Array }) {
  const size = e.data?.length ?? 0;
  const long = enc.encode(e.name).length > 100;
  const longLink = !!e.linkname && enc.encode(e.linkname).length > 100;
  if (long || longLink) {
    const pax = enc.encode((long ? paxRecord("path", e.name) : "") + (longLink ? paxRecord("linkpath", e.linkname!) : ""));
    chunks.push(tarHeader({ name: "PaxHeader", mode: 0o644, size: pax.length, mtime: e.mtime, type: "x" }), pax, pad512(pax.length));
  }
  const short = (s: string) => {
    const b = enc.encode(s);
    return b.length > 100 ? new TextDecoder().decode(b.slice(0, 100)).replace(/\uFFFD+$/, "") : s;
  };
  chunks.push(tarHeader({ name: short(e.name), mode: e.mode, size, mtime: e.mtime, type: e.type, linkname: e.linkname ? short(e.linkname) : undefined }));
  if (e.data) chunks.push(e.data, pad512(size));
}

/** Pack a directory (as `<basename>/…`) into a gzip'd tar, preserving modes.
 *  Requires at least one task.toml so a wrong path fails before uploading. */
export async function createTarGz(dir: string): Promise<{ bytes: Uint8Array; taskCount: number; fileCount: number }> {
  const root = resolve(dir);
  const top = basename(root);
  const chunks: Uint8Array[] = [];
  let taskCount = 0;
  let fileCount = 0;
  const walk = async (abs: string, rel: string) => {
    const st = await lstat(abs);
    const mtime = st.mtimeMs / 1000;
    if (st.isDirectory()) {
      tarEntry(chunks, { name: `${rel}/`, mode: st.mode, mtime, type: "5" });
      const names = (await readdir(abs)).sort();
      for (const n of names) await walk(join(abs, n), `${rel}/${n}`);
    } else if (st.isFile()) {
      if (basename(abs) === "task.toml") taskCount++;
      fileCount++;
      tarEntry(chunks, { name: rel, mode: st.mode, mtime, type: "0", data: new Uint8Array(await readFile(abs)) });
    } else if (st.isSymbolicLink()) {
      fileCount++;
      tarEntry(chunks, { name: rel, mode: st.mode, mtime, type: "2", linkname: await readlink(abs) });
    } else {
      throw new Error(`Unsupported file type (not a file, directory or symlink): ${abs}`);
    }
  };
  await walk(root, top);
  if (taskCount === 0) {
    throw new EvalsUsageError(`No task.toml found under ${dir}. Expected a Harbor task directory or a directory of task directories.`);
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { tar.set(c, off); off += c.length; }
  return { bytes: new Uint8Array(gzipSync(tar)), taskCount, fileCount };
}

// ─── Commands ───

async function waitForRun(io: EvalsIO, runId: string): Promise<EvalRun> {
  const seen = new Map<string, string>();
  let lastStatus = "";
  for (;;) {
    const run = await io.request<EvalRun>(`/v1/oma/evals/runs/${encodeURIComponent(runId)}`);
    if (!io.json) {
      const head = `${run.status} — ${run.completed_count}/${run.task_count} completed, ${run.failed_count} failed`;
      if (head !== lastStatus) { io.print(`[${new Date().toLocaleTimeString()}] ${head}`); lastStatus = head; }
      for (const t of run.tasks) {
        const line = progressLine(t);
        if (seen.get(t.id) !== line) { io.print(line); seen.set(t.id, line); }
      }
    }
    if (TERMINAL.includes(run.status)) return run;
    await io.sleep(io.pollIntervalMs ?? 5000);
  }
}

function printJson(io: EvalsIO, v: unknown) {
  io.print(JSON.stringify(v, null, 2));
}

function requirePositionals(f: ParsedFlags, names: string[], usage: string): string[] {
  const missing = names.filter((_, i) => !f.positionals[i]);
  if (missing.length) throw new EvalsUsageError(`Missing ${missing.map((n) => `<${n}>`).join(" ")}. Usage: ${usage}`);
  return f.positionals.slice(0, names.length);
}

/** Pack a directory (or read a .tar/.tar.gz) and upload it through the Files API. */
async function uploadPath(io: EvalsIO, path: string, opts: { exactlyOneTask?: boolean } = {}): Promise<{ fileId: string; filename: string }> {
  let st;
  try { st = await stat(path); } catch { throw new EvalsUsageError(`No such file or directory: ${path}`); }
  let bytes: Uint8Array;
  let filename: string;
  if (st.isDirectory()) {
    const packed = await createTarGz(path);
    if (opts.exactlyOneTask && packed.taskCount !== 1) {
      throw new EvalsUsageError(`${path} has ${packed.taskCount} task.toml files; replacing a case needs exactly one task directory`);
    }
    bytes = packed.bytes;
    filename = `${basename(resolve(path))}.tar.gz`;
    if (!io.json) io.print(`Packed ${packed.fileCount} files (${packed.taskCount} task.toml) into ${filename} (${bytes.length} bytes)`);
  } else if (st.isFile() && ARCHIVE_RE.test(path)) {
    bytes = new Uint8Array(await readFile(path));
    filename = basename(path);
  } else {
    throw new EvalsUsageError(`Unsupported path: ${path}. Pass a directory or a .tar, .tar.gz or .tgz archive.`);
  }
  const file = await io.upload(filename, bytes, /\.tar$/i.test(filename) ? "application/x-tar" : "application/gzip");
  return { fileId: file.id, filename };
}

const benchPath = (id: string) => `/v1/oma/evals/benchmarks/${encodeURIComponent(id)}`;
const casePath = (id: string, name: string) => `${benchPath(id)}/cases/${encodeURIComponent(name)}`;

async function dispatch(io: EvalsIO, args: string[]): Promise<number> {
  const [, group, verb, ...rest] = args;
  const id = (s: string) => encodeURIComponent(s);
  const key = group === "run" ? "run" : `${group ?? ""} ${verb ?? ""}`;
  const tail = group === "run" ? args.slice(2) : rest;
  switch (key) {
    case "benchmarks list": {
      parseFlags(tail, {}, 0);
      const res = await io.request<{ data: EvalBenchmark[] }>("/v1/oma/evals/benchmarks");
      if (io.json) { printJson(io, res); return 0; }
      if (!res.data.length) { io.print("No eval benchmarks. Import one with: oma evals benchmarks import --builtin <name>"); return 0; }
      io.print(table([["NAME", "ID", "KIND", "SOURCE", "CASES", "RUNNABLE", "CREATED"],
        ...res.data.map((b) => [b.name, b.id, b.kind, sourceLabel(b), String(b.case_count), String(b.runnable_count), fmtDate(b.created_at)])]));
      return 0;
    }
    case "benchmarks builtin": {
      parseFlags(tail, {}, 0);
      const res = await io.request<{ data: BuiltinEvalBenchmark[] }>("/v1/oma/evals/benchmarks/builtin");
      if (io.json) { printJson(io, res); return 0; }
      if (!res.data.length) { io.print("No builtin eval benchmarks on this server."); return 0; }
      io.print(table([["NAME", "CASES", "DESCRIPTION"], ...res.data.map((b) => [b.name, String(b.case_count), b.description])]));
      return 0;
    }
    case "benchmarks show": {
      const [bId] = requirePositionals(parseFlags(tail, {}, 1), ["id"], "oma evals benchmarks show <id>");
      const b = await io.request<EvalBenchmark>(benchPath(bId));
      io.print(io.json ? JSON.stringify(b, null, 2) : formatBenchmark(b));
      return 0;
    }
    case "benchmarks create": {
      const body = parseCreateArgs(tail);
      const b = await io.request<EvalBenchmark>("/v1/oma/evals/benchmarks", { method: "POST", body: JSON.stringify(body) });
      if (io.json) { printJson(io, b); return 0; }
      io.print(`Benchmark created: ${b.name} (${b.id}) — ${b.kind}\n  Add cases with: oma evals cases add ${b.id} ${b.kind === "messages" ? "--file case.json" : "--from <dir|archive>"}`);
      return 0;
    }
    case "benchmarks import": {
      const body = parseImportArgs(tail);
      const b = await io.request<EvalBenchmark>("/v1/oma/evals/benchmarks", { method: "POST", body: JSON.stringify(body) });
      reportBenchmark(io, b, "imported");
      return 0;
    }
    case "benchmarks upload": {
      const f = parseFlags(tail, { single: ["--name"] }, 1);
      const [path] = requirePositionals(f, ["path"], "oma evals benchmarks upload <dir|archive.tar[.gz]> [--name <n>]");
      const { fileId } = await uploadPath(io, path);
      const body: CreateEvalBenchmarkRequest = { ...(f.single["--name"] ? { name: f.single["--name"] } : {}), source: { type: "upload", file_id: fileId } };
      const b = await io.request<EvalBenchmark>("/v1/oma/evals/benchmarks", { method: "POST", body: JSON.stringify(body) });
      reportBenchmark(io, b, "uploaded");
      return 0;
    }
    case "benchmarks rename": {
      const [bId, name] = requirePositionals(parseFlags(tail, {}, 2), ["id", "name"], "oma evals benchmarks rename <id> <name>");
      const b = await io.request<EvalBenchmark>(benchPath(bId), { method: "PATCH", body: JSON.stringify({ name }) });
      io.print(io.json ? JSON.stringify(b, null, 2) : `Benchmark renamed: ${b.name} (${b.id})`);
      return 0;
    }
    case "benchmarks delete": {
      const [bId] = requirePositionals(parseFlags(tail, {}, 1), ["id"], "oma evals benchmarks delete <id>");
      const r = await io.request<{ id: string }>(benchPath(bId), { method: "DELETE" });
      io.print(io.json ? JSON.stringify(r, null, 2) : `Benchmark deleted: ${r.id ?? bId}`);
      return 0;
    }
    case "cases show": {
      const [bId, name] = requirePositionals(parseFlags(tail, {}, 2), ["benchmark", "case"], "oma evals cases show <benchmark> <case>");
      const c = await io.request<EvalCaseDetail>(casePath(bId, name));
      io.print(io.json ? JSON.stringify(c, null, 2) : formatCase(c));
      return 0;
    }
    case "cases add": {
      const usage = EVALS_COMMANDS.find((c) => c.match[1] === "cases" && c.match[2] === "add")!.usage;
      const f = parseFlags(tail, { single: ["--file", "--from", ...SOURCE_SINGLE], multi: ["--case"] }, 1);
      const [bId] = requirePositionals(f, ["benchmark"], usage);
      const source = parseHarborSource(f);
      const file = f.single["--file"];
      const from = f.single["--from"];
      const given = [file && "--file", from && "--from", source && (source.type === "builtin" ? "--builtin" : "--registry")].filter(Boolean);
      if (given.length !== 1) throw new EvalsUsageError(`Pass exactly one of --file, --from, --builtin or --registry. Usage: ${usage}`);
      const caseNames = f.multi["--case"];
      if (file && caseNames) throw new EvalsUsageError("--case only applies to harbor sources (--from, --builtin, --registry)");
      let body: AddEvalCasesRequest;
      if (file) body = await readCaseFile(file);
      else {
        const src: HarborCaseSource = from ? { type: "upload", file_id: (await uploadPath(io, from)).fileId } : source!;
        body = { source: src, ...(caseNames?.length ? { case_names: caseNames } : {}) };
      }
      const b = await io.request<EvalBenchmark>(`${benchPath(bId)}/cases`, { method: "POST", body: JSON.stringify(body) });
      reportBenchmark(io, b, "updated");
      return 0;
    }
    case "cases replace": {
      const usage = "oma evals cases replace <benchmark> <case> (--file case.json | --from <dir|archive>)";
      const f = parseFlags(tail, { single: ["--file", "--from"] }, 2);
      const [bId, name] = requirePositionals(f, ["benchmark", "case"], usage);
      const file = f.single["--file"];
      const from = f.single["--from"];
      if (!!file === !!from) throw new EvalsUsageError(`Pass exactly one of --file or --from. Usage: ${usage}`);
      const body: ReplaceEvalCaseRequest = file
        ? await readCaseFile(file)
        : { source: { type: "upload", file_id: (await uploadPath(io, from!, { exactlyOneTask: true })).fileId } };
      const c = await io.request<EvalCaseDetail>(casePath(bId, name), { method: "PUT", body: JSON.stringify(body) });
      io.print(io.json ? JSON.stringify(c, null, 2) : `Case replaced: ${c.name} in ${bId}`);
      return 0;
    }
    case "cases delete": {
      const [bId, name] = requirePositionals(parseFlags(tail, {}, 2), ["benchmark", "case"], "oma evals cases delete <benchmark> <case>");
      const r = await io.request<{ name?: string }>(casePath(bId, name), { method: "DELETE" });
      io.print(io.json ? JSON.stringify(r, null, 2) : `Case deleted: ${r.name ?? name} from ${bId}`);
      return 0;
    }
    case "run": {
      const parsed = parseRunArgs(tail);
      const request: CreateEvalRunRequest = parsed.file !== undefined
        ? { agent_id: parsed.agent, environment_id: parsed.environment, tasks: await readTasksFile(parsed.file) }
        : parsed.request;
      const created = await io.request<CreateEvalRunResponse>("/v1/oma/evals/runs", { method: "POST", body: JSON.stringify(request) });
      if (!parsed.wait) {
        io.print(io.json ? JSON.stringify(created, null, 2) : `Eval run created: ${created.run_id} (${created.task_count} cases)\n  Follow with: oma evals runs show ${created.run_id}`);
        return 0;
      }
      if (!io.json) io.print(`Eval run created: ${created.run_id} (${created.task_count} cases). Waiting…`);
      const run = await waitForRun(io, created.run_id);
      io.print(io.json ? JSON.stringify(run, null, 2) : `\n${formatRun(run)}`);
      if (run.status !== "completed") {
        io.error(`Eval run ${run.id} ${run.status}${run.error ? `: ${run.error}` : ""}`);
        return 1;
      }
      return 0;
    }
    case "runs list": {
      const path = parseRunsListArgs(tail);
      const res = await io.request<{ data: EvalRun[] }>(path);
      if (io.json) { printJson(io, res); return 0; }
      if (!res.data.length) { io.print("No eval runs. Start one with: oma evals run --benchmark <id> --agent <id>"); return 0; }
      io.print(table([["ID", "STATUS", "KIND", "BENCHMARK", "AGENT", "CASES", "DONE", "FAILED", "SCORE", "CREATED"],
        ...res.data.map((r) => [r.id, r.status, r.mode ? `${r.kind}/${r.mode}` : r.kind, r.benchmark_id ?? "—", r.agent_id ?? "—",
          String(r.task_count), String(r.completed_count), String(r.failed_count), fmtReward(r.score), fmtDate(r.created_at)])]));
      return 0;
    }
    case "runs show": {
      const [runId] = requirePositionals(parseFlags(tail, {}, 1), ["id"], "oma evals runs show <id> [--json]");
      const run = await io.request<EvalRun>(`/v1/oma/evals/runs/${id(runId)}`);
      if (io.json) { printJson(io, run); return 0; }
      let benchmark: EvalBenchmark | undefined;
      if (run.benchmark_id) {
        // Best effort: the benchmark may have been deleted since the run.
        try { benchmark = await io.request<EvalBenchmark>(benchPath(run.benchmark_id)); } catch { benchmark = undefined; }
      }
      io.print(formatRun(run, benchmark));
      return 0;
    }
    case "runs cancel": {
      const [runId] = requirePositionals(parseFlags(tail, {}, 1), ["id"], "oma evals runs cancel <id>");
      const run = await io.request<EvalRun>(`/v1/oma/evals/runs/${id(runId)}/cancel`, { method: "POST" });
      io.print(io.json ? JSON.stringify(run, null, 2) : `Eval run ${run.id}: ${run.status}`);
      return 0;
    }
    case "runs delete": {
      const [runId] = requirePositionals(parseFlags(tail, {}, 1), ["id"], "oma evals runs delete <id>");
      const r = await io.request<{ id: string }>(`/v1/oma/evals/runs/${id(runId)}`, { method: "DELETE" });
      io.print(io.json ? JSON.stringify(r, null, 2) : `Eval run deleted: ${r.id ?? runId}`);
      return 0;
    }
    default:
      throw new EvalsUsageError(`Unknown command: oma ${args.join(" ")}\n\n${EVALS_COMMANDS.map((c) => `  ${c.usage}`).join("\n")}`);
  }
}

function reportBenchmark(io: EvalsIO, b: EvalBenchmark, verb: string) {
  if (io.json) { printJson(io, b); return; }
  io.print(`Benchmark ${verb}: ${b.name} (${b.id}) — ${b.case_count} cases, ${b.runnable_count} runnable`);
  if (b.runnable_count < b.case_count) {
    const blocked = (b.cases ?? []).filter((c): c is HarborEvalCase => c.kind === "harbor" && !harborRunnable(c));
    io.error(`Warning: ${b.case_count - b.runnable_count} case(s) cannot run yet${blocked.length ? ":" : "."}`);
    for (const c of blocked) {
      io.error(`  ${c.name}: ${!c.supported ? `unsupported (${c.unsupported_reason ?? "unknown reason"})` : `no image alias for ${c.image}`}`);
    }
  }
}

/** Run `oma evals …` (args include the leading "evals"). Returns the exit code. */
export async function runEvalsCommand(io: EvalsIO, args: string[]): Promise<number> {
  try {
    return await dispatch(io, args);
  } catch (err) {
    if (err instanceof EvalsUsageError) { io.error(`Error: ${err.message}`); return 1; }
    throw err;
  }
}
