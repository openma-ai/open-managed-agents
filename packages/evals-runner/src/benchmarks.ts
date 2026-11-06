// Eval benchmarks and their cases, stored per tenant in the KvStore both
// runtimes already have (CF: CONFIG_KV, Node: SqlKvStore), so no new table or
// migration is needed. Keys keep the original "evaldataset" prefix so
// benchmarks imported before the rename stay readable:
//
//   t:{tenant}:evaldataset:{id}             -> StoredEvalBenchmark (metadata + cases)
//   t:{tenant}:evaldataset:{id}:task:{name} -> StoredTaskFiles (harbor case files)
//
// A record without `kind` (written before messages benchmarks existed) is a
// harbor benchmark whose cases are under `tasks`.
//
// Only the files OMA uses are kept per harbor case: task.toml, instruction.md,
// tests/, solution/ and environment/docker-compose.* (kept so the task can be
// refused as multi-container). environment/ build context is not stored:
// tasks must run from their prebuilt docker_image.

import {
  bundlesFromEntries,
  fromBase64,
  maybeGunzipStream,
  parseHarborTask,
  readTarArchive,
  readTarStream,
  toBase64,
  UnsupportedHarborTaskError,
  type HarborTask,
  type HarborTaskBundle,
  type HarborTaskFile,
  type TarEntry,
} from "@open-managed-agents/harbor-tasks";
import { listAll, type KvStore } from "@open-managed-agents/kv-store";
import type {
  BuiltinEvalBenchmark,
  EvalBenchmark,
  EvalBenchmarkKind,
  EvalCase,
  EvalCaseDetail,
  HarborCaseSource,
  HarborEvalCase,
  MessagesEvalCase,
} from "@open-managed-agents/api-types";
import type { RewardSpec } from "@open-managed-agents/shared";
import { kvKey, type EvalTaskSpec } from "./types";

export const CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface StoredHarborCase {
  kind: "harbor";
  name: string;
  image: string;
  supported: boolean;
  unsupported_reason?: string;
  agent_timeout_sec: number | null;
  verifier_timeout_sec: number;
  cpus: number | null;
  memory_mb: number | null;
  has_solution: boolean;
  instruction_preview: string;
  updated_at: string;
}

export interface StoredMessagesCase {
  kind: "messages";
  name: string;
  messages: string[];
  reward?: RewardSpec;
  setup_files?: { path: string; content: string }[];
  setup_script?: string;
  timeout_ms?: number;
  updated_at: string;
}

export type StoredEvalCase = StoredHarborCase | StoredMessagesCase;

export interface StoredEvalBenchmark {
  id: string;
  name: string;
  kind: EvalBenchmarkKind;
  source: HarborCaseSource | null;
  created_at: string;
  updated_at: string;
  cases: StoredEvalCase[];
}

interface StoredTaskFiles {
  files: Array<{ path: string; b64: string; executable: boolean }>;
}

/** Maps a task's docker_image to the operator SANDBOX_IMAGES alias whose
 *  reference is exactly that image, or null. */
export type ImageAliasResolver = (image: string) => string | null;

export class EvalBenchmarkError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) {
    super(message);
    this.name = "EvalBenchmarkError";
  }
}

/** Old records: no kind (harbor), cases under `tasks`, no updated_at. */
function normalise(raw: Record<string, unknown>): StoredEvalBenchmark {
  const createdAt = String(raw.created_at ?? "");
  const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : createdAt;
  const kind: EvalBenchmarkKind = raw.kind === "messages" ? "messages" : "harbor";
  const cases = (Array.isArray(raw.cases) ? raw.cases : Array.isArray(raw.tasks) ? raw.tasks : []) as Array<Record<string, unknown>>;
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    kind,
    source: (raw.source ?? null) as HarborCaseSource | null,
    created_at: createdAt,
    updated_at: updatedAt,
    cases: cases.map((entry) => ({
      ...entry,
      kind,
      updated_at: typeof entry.updated_at === "string" ? entry.updated_at : updatedAt,
    }) as StoredEvalCase),
  };
}

function stamp(): string { return new Date().toISOString(); }

// ── Storage ────────────────────────────────────────────────────────────────

export class EvalBenchmarkStore {
  constructor(private readonly kv: KvStore, private readonly tenantId: string) {}

  private metaKey(id: string) { return kvKey(this.tenantId, "evaldataset", id); }
  private taskKey(id: string, name: string) { return kvKey(this.tenantId, "evaldataset", id, "task", name); }

  private async putFiles(id: string, bundle: HarborTaskBundle, name = bundle.name) {
    const stored: StoredTaskFiles = {
      files: bundle.files.map((file) => ({ path: file.path, b64: toBase64(file.bytes), executable: file.executable })),
    };
    await this.kv.put(this.taskKey(id, name), JSON.stringify(stored));
  }

  private async save(benchmark: StoredEvalBenchmark) {
    await this.kv.put(this.metaKey(benchmark.id), JSON.stringify(benchmark));
  }

  async create(input: {
    name: string;
    kind: EvalBenchmarkKind;
    source?: HarborCaseSource | null;
    bundles?: HarborTaskBundle[];
    cases?: StoredMessagesCase[];
  }): Promise<StoredEvalBenchmark> {
    const id = `evbm_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const now = stamp();
    const bundles = input.kind === "harbor" ? input.bundles ?? [] : [];
    const benchmark: StoredEvalBenchmark = {
      id,
      name: input.name,
      kind: input.kind,
      source: input.source ?? null,
      created_at: now,
      updated_at: now,
      cases: input.kind === "harbor"
        ? bundles.map((bundle) => summariseBundle(bundle, now))
        : (input.cases ?? []).map((entry) => ({ ...entry, updated_at: now })),
    };
    // Case files first, metadata last: a benchmark is visible only once complete.
    for (const bundle of bundles) await this.putFiles(id, bundle);
    await this.save(benchmark);
    return benchmark;
  }

  async get(id: string): Promise<StoredEvalBenchmark | null> {
    const raw = await this.kv.get(this.metaKey(id));
    return raw === null ? null : normalise(JSON.parse(raw) as Record<string, unknown>);
  }

  async list(): Promise<StoredEvalBenchmark[]> {
    const prefix = kvKey(this.tenantId, "evaldataset", "");
    const keys = await listAll(this.kv, prefix);
    const metaKeys = keys.map((key) => key.name).filter((name) => !name.slice(prefix.length).includes(":"));
    const rows = await Promise.all(metaKeys.map(async (key) => {
      const raw = await this.kv.get(key);
      return raw === null ? null : normalise(JSON.parse(raw) as Record<string, unknown>);
    }));
    return rows
      .filter((row): row is StoredEvalBenchmark => row !== null)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  async rename(id: string, name: string): Promise<StoredEvalBenchmark | null> {
    const benchmark = await this.get(id);
    if (benchmark === null) return null;
    benchmark.name = name;
    benchmark.updated_at = stamp();
    await this.save(benchmark);
    return benchmark;
  }

  async delete(id: string): Promise<boolean> {
    const benchmark = await this.get(id);
    if (benchmark === null) return false;
    await this.kv.delete(this.metaKey(id));
    if (benchmark.kind === "harbor") {
      for (const entry of benchmark.cases) await this.kv.delete(this.taskKey(id, entry.name));
    }
    return true;
  }

  private async require(id: string, kind?: EvalBenchmarkKind): Promise<StoredEvalBenchmark> {
    const benchmark = await this.get(id);
    if (benchmark === null) throw new EvalBenchmarkError("Benchmark not found", 404);
    if (kind !== undefined && benchmark.kind !== kind) throw new EvalBenchmarkError(`Benchmark ${id} is a ${benchmark.kind} benchmark`);
    return benchmark;
  }

  private static conflict(benchmark: StoredEvalBenchmark, names: readonly string[]) {
    const existing = new Set(benchmark.cases.map((entry) => entry.name));
    const taken = names.filter((name) => existing.has(name));
    if (taken.length > 0) throw new EvalBenchmarkError(`Case(s) already in the benchmark: ${taken.join(", ")}`, 409);
  }

  /** Add harbor cases; 409 when a name is taken (nothing is written then). */
  async addHarborCases(id: string, bundles: HarborTaskBundle[]): Promise<StoredEvalBenchmark> {
    const benchmark = await this.require(id, "harbor");
    EvalBenchmarkStore.conflict(benchmark, bundles.map((bundle) => bundle.name));
    const now = stamp();
    for (const bundle of bundles) await this.putFiles(id, bundle);
    benchmark.cases.push(...bundles.map((bundle) => summariseBundle(bundle, now)));
    benchmark.updated_at = now;
    await this.save(benchmark);
    return benchmark;
  }

  async addMessagesCase(id: string, entry: Omit<StoredMessagesCase, "updated_at">): Promise<StoredEvalBenchmark> {
    const benchmark = await this.require(id, "messages");
    EvalBenchmarkStore.conflict(benchmark, [entry.name]);
    const now = stamp();
    benchmark.cases.push({ ...entry, updated_at: now });
    benchmark.updated_at = now;
    await this.save(benchmark);
    return benchmark;
  }

  private indexOf(benchmark: StoredEvalBenchmark, name: string): number {
    const index = benchmark.cases.findIndex((entry) => entry.name === name);
    if (index < 0) throw new EvalBenchmarkError(`Case ${name} not found`, 404);
    return index;
  }

  async replaceMessagesCase(id: string, name: string, entry: Omit<StoredMessagesCase, "updated_at" | "name">): Promise<StoredMessagesCase> {
    const benchmark = await this.require(id, "messages");
    const index = this.indexOf(benchmark, name);
    const now = stamp();
    const replaced: StoredMessagesCase = { ...entry, kind: "messages", name, updated_at: now };
    benchmark.cases[index] = replaced;
    benchmark.updated_at = now;
    await this.save(benchmark);
    return replaced;
  }

  /** Replace a harbor case's files with one task directory; the case keeps `name`. */
  async replaceHarborCase(id: string, name: string, bundle: HarborTaskBundle): Promise<StoredHarborCase> {
    const benchmark = await this.require(id, "harbor");
    const index = this.indexOf(benchmark, name);
    const now = stamp();
    const renamed = { ...bundle, name };
    await this.putFiles(id, renamed, name);
    const replaced = summariseBundle(renamed, now);
    benchmark.cases[index] = replaced;
    benchmark.updated_at = now;
    await this.save(benchmark);
    return replaced;
  }

  async deleteCase(id: string, name: string): Promise<void> {
    const benchmark = await this.require(id);
    const index = this.indexOf(benchmark, name);
    benchmark.cases.splice(index, 1);
    benchmark.updated_at = stamp();
    await this.save(benchmark);
    if (benchmark.kind === "harbor") await this.kv.delete(this.taskKey(id, name));
  }

  async taskFiles(id: string, name: string): Promise<HarborTaskFile[] | null> {
    const raw = await this.kv.get(this.taskKey(id, name));
    if (raw === null) return null;
    const stored = JSON.parse(raw) as StoredTaskFiles;
    return stored.files.map((file) => ({ path: file.path, bytes: fromBase64(file.b64), executable: file.executable }));
  }

  async loadTask(id: string, name: string): Promise<HarborTask> {
    const files = await this.taskFiles(id, name);
    if (files === null) throw new EvalBenchmarkError(`Case ${name} of benchmark ${id} not found`, 404);
    return parseHarborTask(name, files);
  }
}

// ── Messages case input ────────────────────────────────────────────────────

/** RewardSpec types eval-core's verifierForSpec implements. */
export const REWARD_TYPES: ReadonlySet<string> = new Set(["verifiable", "script", "reward_model", "composite"]);

/** Validate a client-written messages case (create / add / replace). With
 *  `name` given (replace) the body's name is ignored. */
export function parseMessagesCase(input: unknown, name?: string): Omit<StoredMessagesCase, "updated_at"> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new EvalBenchmarkError("case must be a JSON object");
  const body = input as Record<string, unknown>;
  const caseName = name ?? body.name;
  if (typeof caseName !== "string" || !CASE_NAME.test(caseName)) {
    throw new EvalBenchmarkError(`case name must match ${CASE_NAME.source}, got ${JSON.stringify(caseName)}`);
  }
  const label = `case ${caseName}`;
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.some((message) => typeof message !== "string")) {
    throw new EvalBenchmarkError(`${label} requires a non-empty messages array of strings`);
  }
  const out: Omit<StoredMessagesCase, "updated_at"> = { kind: "messages", name: caseName, messages: body.messages as string[] };
  if (body.reward !== undefined) {
    const type = body.reward !== null && typeof body.reward === "object" ? (body.reward as { type?: unknown }).type : undefined;
    if (typeof type !== "string" || !REWARD_TYPES.has(type)) {
      throw new EvalBenchmarkError(`${label} reward.type must be one of ${[...REWARD_TYPES].join(", ")}`);
    }
    out.reward = body.reward as RewardSpec;
  }
  if (body.setup_files !== undefined) {
    const files = body.setup_files;
    if (!Array.isArray(files) || files.some((file) => file === null || typeof file !== "object"
      || typeof (file as { path?: unknown }).path !== "string" || typeof (file as { content?: unknown }).content !== "string")) {
      throw new EvalBenchmarkError(`${label} setup_files must be an array of { path, content } strings`);
    }
    const bad = (files as Array<{ path: string }>).find((file) => !file.path.startsWith("/"));
    if (bad) throw new EvalBenchmarkError(`${label} setup_files path must be absolute, got ${JSON.stringify(bad.path)}`);
    out.setup_files = (files as Array<{ path: string; content: string }>).map(({ path, content }) => ({ path, content }));
  }
  if (body.setup_script !== undefined) {
    if (typeof body.setup_script !== "string") throw new EvalBenchmarkError(`${label} setup_script must be a string`);
    out.setup_script = body.setup_script;
  }
  if (body.timeout_ms !== undefined) {
    if (typeof body.timeout_ms !== "number" || !Number.isInteger(body.timeout_ms) || body.timeout_ms < 1) {
      throw new EvalBenchmarkError(`${label} timeout_ms must be a positive integer`);
    }
    out.timeout_ms = body.timeout_ms;
  }
  return out;
}

/** The task spec a run snapshots from a messages case. */
export function messagesCaseSpec(entry: StoredMessagesCase): EvalTaskSpec {
  return {
    id: entry.name,
    messages: [...entry.messages],
    ...(entry.reward !== undefined ? { reward: entry.reward } : {}),
    ...(entry.setup_files !== undefined ? { setup_files: entry.setup_files.map((file) => ({ ...file })) } : {}),
    ...(entry.setup_script !== undefined ? { setup_script: entry.setup_script } : {}),
    ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}),
  };
}

// ── API projection ─────────────────────────────────────────────────────────

export function runnableCase(entry: StoredEvalCase, aliasFor: ImageAliasResolver): boolean {
  return entry.kind === "messages" || (entry.supported && aliasFor(entry.image) !== null);
}

export function caseToApi(entry: StoredEvalCase, aliasFor: ImageAliasResolver): EvalCase {
  if (entry.kind === "messages") return { ...entry } as MessagesEvalCase;
  return { ...entry, image_alias: aliasFor(entry.image) } as HarborEvalCase;
}

export function benchmarkToApi(benchmark: StoredEvalBenchmark, aliasFor: ImageAliasResolver, withCases: boolean): EvalBenchmark {
  return {
    id: benchmark.id,
    name: benchmark.name,
    kind: benchmark.kind,
    source: benchmark.source,
    case_count: benchmark.cases.length,
    runnable_count: benchmark.cases.filter((entry) => runnableCase(entry, aliasFor)).length,
    created_at: benchmark.created_at,
    updated_at: benchmark.updated_at,
    ...(withCases ? { cases: benchmark.cases.map((entry) => caseToApi(entry, aliasFor)) } : {}),
  };
}

/** One case with harbor detail (full instruction + stored file list). */
export async function caseDetail(
  store: EvalBenchmarkStore,
  benchmarkId: string,
  entry: StoredEvalCase,
  aliasFor: ImageAliasResolver,
): Promise<EvalCaseDetail> {
  const api = caseToApi(entry, aliasFor);
  if (api.kind === "messages") return api;
  const files = await store.taskFiles(benchmarkId, entry.name) ?? [];
  const instruction = files.find((file) => file.path === "instruction.md");
  return {
    ...api,
    instruction: instruction ? new TextDecoder().decode(instruction.bytes) : "",
    files: files
      .map((file) => ({ path: file.path, size: file.bytes.byteLength, executable: file.executable }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function summariseBundle(bundle: HarborTaskBundle, updatedAt: string): StoredHarborCase {
  const instruction = bundle.files.find((file) => file.path === "instruction.md");
  const preview = instruction ? new TextDecoder().decode(instruction.bytes).slice(0, 2000) : "";
  try {
    const task = parseHarborTask(bundle.name, bundle.files);
    return {
      kind: "harbor",
      name: bundle.name,
      image: task.image,
      supported: true,
      agent_timeout_sec: task.agentTimeoutSec,
      verifier_timeout_sec: task.verifierTimeoutSec,
      cpus: task.cpus,
      memory_mb: task.memoryMb,
      has_solution: task.solution !== null,
      instruction_preview: preview,
      updated_at: updatedAt,
    };
  } catch (error) {
    if (!(error instanceof UnsupportedHarborTaskError)) throw error;
    const toml = bundle.files.find((file) => file.path === "task.toml");
    const image = toml ? /docker_image\s*=\s*"([^"]+)"/u.exec(new TextDecoder().decode(toml.bytes))?.[1] ?? "" : "";
    return {
      kind: "harbor",
      name: bundle.name,
      image,
      supported: false,
      unsupported_reason: error.message,
      agent_timeout_sec: null,
      verifier_timeout_sec: 600,
      cpus: null,
      memory_mb: null,
      has_solution: bundle.files.some((file) => file.path === "solution/solve.sh"),
      instruction_preview: preview,
      updated_at: updatedAt,
    };
  }
}

// ── Import ─────────────────────────────────────────────────────────────────

export const DEFAULT_HARBOR_REGISTRY_URL = "https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json";

interface BuiltinDefinition extends BuiltinEvalBenchmark {
  github: { owner: string; repo: string; commit: string };
}

/** Benchmarks OMA ships: pinned to a commit, so the case set never drifts. */
export const BUILTIN_EVAL_BENCHMARKS: readonly BuiltinDefinition[] = [
  {
    name: "terminal-bench-sample@2.0",
    description: "10-task sample of Terminal-Bench 2.0 (Harbor registry terminal-bench-sample@2.0).",
    case_count: 10,
    github: { owner: "laude-institute", repo: "terminal-bench-2-0-sample", commit: "7e917f35c281188532772312d4ad91ca9274febc" },
  },
  {
    name: "terminal-bench@2.0",
    description: "Terminal-Bench 2.0, 89 terminal tasks (Harbor registry terminal-bench@2.0).",
    case_count: 89,
    github: { owner: "laude-institute", repo: "terminal-bench-2", commit: "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c" },
  },
];

export function listBuiltinBenchmarks(): BuiltinEvalBenchmark[] {
  return BUILTIN_EVAL_BENCHMARKS.map(({ name, description, case_count }) => ({ name, description, case_count }));
}

/** Files of a task directory OMA keeps, by path relative to the task root. */
function keepTaskFile(relative: string): boolean {
  return relative === "task.toml"
    || relative === "instruction.md"
    || relative.startsWith("tests/")
    || relative.startsWith("solution/")
    || relative === "environment/docker-compose.yaml"
    || relative === "environment/docker-compose.yml";
}

/** Same filter when the task root is not known yet (whole-archive scans). */
function keepAnywhere(path: string): boolean {
  const parts = path.split("/");
  const last = parts.at(-1);
  if (last === "task.toml" || last === "instruction.md") return true;
  if (parts.includes("tests") || parts.includes("solution")) return !parts.includes("environment");
  return path.endsWith("/environment/docker-compose.yaml") || path.endsWith("/environment/docker-compose.yml");
}

function trimBundle(bundle: HarborTaskBundle): HarborTaskBundle {
  return { ...bundle, files: bundle.files.filter((file) => keepTaskFile(file.path)) };
}

export interface HarborImportDeps {
  fetch: typeof fetch;
  /** Read an uploaded Files API object; null when it does not exist. */
  readUpload(fileId: string): Promise<{ bytes: Uint8Array; filename?: string } | null>;
}

function parseGithubUrl(url: string): { owner: string; repo: string } {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url);
  if (!match) throw new EvalBenchmarkError(`Only GitHub git_url is supported for registry import, got ${url}`);
  return { owner: match[1]!, repo: match[2]! };
}

/** Stream a GitHub tarball, keeping only entries `accept` wants (paths
 *  relative to the repository root). */
async function githubEntries(
  deps: HarborImportDeps,
  repo: { owner: string; repo: string },
  ref: string,
  accept: (path: string) => boolean,
): Promise<TarEntry[]> {
  const url = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${encodeURIComponent(ref)}`;
  const response = await deps.fetch(url, { headers: { "user-agent": "open-managed-agents-evals" } });
  if (!response.ok || response.body === null) {
    throw new EvalBenchmarkError(`Downloading ${repo.owner}/${repo.repo}@${ref} failed: HTTP ${response.status}`, 502);
  }
  // GitHub tarballs wrap everything in one "<owner>-<repo>-<sha>/" directory.
  const strip = (path: string) => path.slice(path.indexOf("/") + 1);
  const entries = await readTarStream(maybeGunzipStream(response.body as ReadableStream<Uint8Array>, true), {
    accept: (path) => path.includes("/") && accept(strip(path)),
  });
  return entries.map((entry) => ({ ...entry, path: strip(entry.path) }));
}

interface RegistryTask { name: string; git_url: string; git_commit_id?: string | null; path: string }
interface RegistryDataset { name: string; version: string; tasks: RegistryTask[] }

async function registryBundles(
  source: Extract<HarborCaseSource, { type: "registry" }>,
  taskNames: readonly string[] | undefined,
  deps: HarborImportDeps,
): Promise<HarborTaskBundle[]> {
  const url = source.registry_url ?? DEFAULT_HARBOR_REGISTRY_URL;
  const response = await deps.fetch(url);
  if (!response.ok) throw new EvalBenchmarkError(`Reading registry ${url} failed: HTTP ${response.status}`, 502);
  const registry = await response.json() as RegistryDataset[];
  if (!Array.isArray(registry)) throw new EvalBenchmarkError(`Registry ${url} is not a JSON array`, 502);
  const candidates = registry.filter((entry) => entry.name === source.name);
  if (candidates.length === 0) throw new EvalBenchmarkError(`Dataset ${source.name} is not in registry ${url}`, 404);
  const dataset = source.version === undefined
    ? (candidates.length === 1 ? candidates[0] : undefined)
    : candidates.find((entry) => entry.version === source.version);
  if (dataset === undefined) {
    throw new EvalBenchmarkError(source.version === undefined
      ? `Dataset ${source.name} has versions ${candidates.map((entry) => entry.version).join(", ")}; pass version`
      : `Dataset ${source.name} has no version ${source.version} (available: ${candidates.map((entry) => entry.version).join(", ")})`, 404);
  }
  let tasks = dataset.tasks;
  if (taskNames !== undefined) {
    const known = new Set(tasks.map((task) => task.name));
    const missing = taskNames.filter((name) => !known.has(name));
    if (missing.length > 0) throw new EvalBenchmarkError(`Unknown task(s) in ${source.name}@${dataset.version}: ${missing.join(", ")}`);
    const wanted = new Set(taskNames);
    tasks = tasks.filter((task) => wanted.has(task.name));
  }
  const groups = new Map<string, RegistryTask[]>();
  for (const task of tasks) {
    const key = `${task.git_url}@${task.git_commit_id || "HEAD"}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const bundles: HarborTaskBundle[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const repo = parseGithubUrl(first.git_url);
    const roots = group.map((task) => ({ task, prefix: `${task.path.replace(/^\/+|\/+$/gu, "")}/` }));
    const entries = await githubEntries(deps, repo, first.git_commit_id || "HEAD", (path) =>
      roots.some(({ prefix }) => path.startsWith(prefix) && keepTaskFile(path.slice(prefix.length))));
    for (const { task, prefix } of roots) {
      const files = entries
        .filter((entry) => entry.type === "file" && entry.path.startsWith(prefix))
        .map((entry) => ({ path: entry.path.slice(prefix.length), bytes: entry.bytes, executable: (entry.mode & 0o111) !== 0 }));
      if (!files.some((file) => file.path === "task.toml")) {
        throw new EvalBenchmarkError(`Task ${task.name}: no task.toml at ${task.path} in ${first.git_url}`, 502);
      }
      bundles.push({ name: task.name, root: task.path, files });
    }
  }
  return bundles;
}

async function builtinBundles(name: string, taskNames: readonly string[] | undefined, deps: HarborImportDeps): Promise<HarborTaskBundle[]> {
  const builtin = BUILTIN_EVAL_BENCHMARKS.find((entry) => entry.name === name);
  if (builtin === undefined) {
    throw new EvalBenchmarkError(`Unknown builtin benchmark ${name} (available: ${BUILTIN_EVAL_BENCHMARKS.map((entry) => entry.name).join(", ")})`, 404);
  }
  const entries = await githubEntries(deps, builtin.github, builtin.github.commit, keepAnywhere);
  return filterByName(bundlesFromEntries(entries).map(trimBundle), taskNames, name);
}

function filterByName(bundles: HarborTaskBundle[], taskNames: readonly string[] | undefined, label: string): HarborTaskBundle[] {
  if (taskNames === undefined) return bundles;
  const known = new Set(bundles.map((bundle) => bundle.name));
  const missing = taskNames.filter((name) => !known.has(name));
  if (missing.length > 0) throw new EvalBenchmarkError(`Unknown task(s) in ${label}: ${missing.join(", ")}`);
  const wanted = new Set(taskNames);
  return bundles.filter((bundle) => wanted.has(bundle.name));
}

/** Resolve a harbor source to its default benchmark name and task bundles
 *  (validated, not stored). caseNames keeps only those tasks. */
export async function collectHarborBundles(
  source: HarborCaseSource | undefined,
  caseNames: unknown,
  deps: HarborImportDeps,
): Promise<{ defaultName: string; bundles: HarborTaskBundle[] }> {
  if (typeof source !== "object" || source === null) throw new EvalBenchmarkError("source is required");
  if (caseNames !== undefined && (!Array.isArray(caseNames) || caseNames.some((name) => typeof name !== "string"))) {
    throw new EvalBenchmarkError("case_names must be an array of strings");
  }
  const names = caseNames as string[] | undefined;
  let bundles: HarborTaskBundle[];
  let defaultName: string;
  if (source.type === "upload") {
    if (typeof source.file_id !== "string" || source.file_id === "") throw new EvalBenchmarkError("source.file_id is required");
    const upload = await deps.readUpload(source.file_id);
    if (upload === null) throw new EvalBenchmarkError(`File ${source.file_id} not found`, 404);
    let entries: TarEntry[];
    try { entries = await readTarArchive(upload.bytes, { accept: keepAnywhere }); }
    catch (error) { throw new EvalBenchmarkError(`File ${source.file_id} is not a readable .tar/.tar.gz: ${error instanceof Error ? error.message : String(error)}`); }
    bundles = filterByName(bundlesFromEntries(entries).map(trimBundle), names, "the upload");
    defaultName = (upload.filename ?? source.file_id).replace(/\.(tar\.gz|tgz|tar)$/u, "");
  } else if (source.type === "registry") {
    if (typeof source.name !== "string" || source.name === "") throw new EvalBenchmarkError("source.name is required");
    if (source.registry_url !== undefined && !/^https:\/\//u.test(source.registry_url)) {
      throw new EvalBenchmarkError("source.registry_url must be an https URL");
    }
    bundles = await registryBundles(source, names, deps);
    defaultName = source.version ? `${source.name}@${source.version}` : source.name;
  } else if (source.type === "builtin") {
    bundles = await builtinBundles(source.name, names, deps);
    defaultName = source.name;
  } else {
    throw new EvalBenchmarkError(`Unknown source.type ${String((source as { type?: unknown }).type)}`);
  }
  if (bundles.length === 0) throw new EvalBenchmarkError("No Harbor task (a directory with task.toml) found");
  const seen = new Set<string>();
  for (const bundle of bundles) {
    if (seen.has(bundle.name)) throw new EvalBenchmarkError(`Duplicate task name ${bundle.name}`);
    if (!CASE_NAME.test(bundle.name)) throw new EvalBenchmarkError(`Invalid task name ${JSON.stringify(bundle.name)}`);
    seen.add(bundle.name);
  }
  return { defaultName, bundles };
}
