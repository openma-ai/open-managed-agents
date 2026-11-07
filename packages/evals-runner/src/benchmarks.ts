// Eval benchmarks and their cases, stored per tenant in the KvStore both
// runtimes already have (CF: CONFIG_KV, Node: SqlKvStore), so no new table or
// migration is needed:
//
//   t:{tenant}:evaldataset:{id}              -> StoredBenchmarkMeta (metadata, revision summaries,
//                                               messages cases)
//   t:{tenant}:evaldataset:{id}:rev:{n}      -> StoredRevisionManifest (harbor cases of revision n)
//   t:{tenant}:evaldataset:{id}:blob:{hex}   -> StoredTaskFiles (one harbor case's files, by digest)
//
// Harbor benchmarks are read-only imports (ADR 0017): an import or a sync
// resolves the source to commits, reads the task directories, and writes a new
// revision only when the content digest changed (Harbor publish semantics).
// Revisions are never rewritten, and case files are addressed by content
// digest, so a run bound to a revision keeps reading exactly what it was
// created with.
//
// Only the files OMA uses are kept per harbor case: task.toml, instruction.md,
// tests/, solution/ and environment/docker-compose.* (kept so the task can be
// refused as multi-container). environment/ build context is not stored:
// tasks must run from their prebuilt docker_image.

import {
  bundlesFromEntries,
  fromBase64,
  parseHarborTask,
  readTarArchive,
  sha256Hex,
  harborContentDigest,
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
  EvalBenchmarkRevision,
  EvalCase,
  EvalCaseDetail,
  EvalSourcePin,
  HarborCaseSource,
  HarborEvalCase,
  MessagesEvalCase,
} from "@open-managed-agents/api-types";
import type { RewardSpec } from "@open-managed-agents/shared";
import { EvalBenchmarkError } from "./errors";
import { gitEntries, parseGitUrl, resolveGitRef, isCommitSha } from "./git-source";
import { kvKey, type EvalTaskSpec } from "./types";

export { EvalBenchmarkError };

export const CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface StoredHarborCase {
  kind: "harbor";
  name: string;
  digest: string;
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

export interface StoredRevision extends EvalBenchmarkRevision {
  /** image of every supported case, for runnable counts without the manifest. */
  supported_images: string[];
}

/** A benchmark with the cases of one revision (harbor) or its cases (messages). */
export interface StoredEvalBenchmark {
  id: string;
  name: string;
  kind: EvalBenchmarkKind;
  source: HarborCaseSource | null;
  created_at: string;
  updated_at: string;
  /** harbor: latest revision number; messages: null. */
  revision: number | null;
  /** harbor: oldest first. */
  revisions: StoredRevision[];
  /** Revision `cases` belong to (harbor). */
  cases_revision: number | null;
  cases: StoredEvalCase[];
}

type StoredBenchmarkMeta = Omit<StoredEvalBenchmark, "cases" | "cases_revision"> & { cases?: StoredMessagesCase[] };

interface StoredRevisionManifest { cases: StoredHarborCase[] }

interface StoredTaskFiles {
  files: Array<{ path: string; b64: string; executable: boolean }>;
}

/** What an import or sync read from a source, before it is stored. */
export interface CollectedHarborSource {
  defaultName: string;
  source: HarborCaseSource;
  pins: EvalSourcePin[];
  case_names?: string[];
  bundles: HarborTaskBundle[];
}

/** Maps a task's docker_image to the operator SANDBOX_IMAGES alias whose
 *  reference is exactly that image, or null. */
export type ImageAliasResolver = (image: string) => string | null;

function stamp(): string { return new Date().toISOString(); }

function digestHex(digest: string): string { return digest.replace(/^sha256:/u, ""); }

/** "sha256:<hex>" over the sorted "<name>\0<case digest>\n" lines. */
async function revisionDigest(cases: ReadonlyArray<{ name: string; digest: string }>): Promise<string> {
  const lines = [...cases].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((entry) => `${entry.name}\0${entry.digest}\n`);
  return `sha256:${await sha256Hex(new TextEncoder().encode(lines.join("")))}`;
}

// ── Storage ────────────────────────────────────────────────────────────────

export class EvalBenchmarkStore {
  constructor(private readonly kv: KvStore, private readonly tenantId: string) {}

  private metaKey(id: string) { return kvKey(this.tenantId, "evaldataset", id); }
  private revisionKey(id: string, revision: number) { return kvKey(this.tenantId, "evaldataset", id, "rev", String(revision)); }
  private blobKey(id: string, digest: string) { return kvKey(this.tenantId, "evaldataset", id, "blob", digestHex(digest)); }

  private async readMeta(id: string): Promise<StoredBenchmarkMeta | null> {
    const raw = await this.kv.get(this.metaKey(id));
    if (raw === null) return null;
    const meta = JSON.parse(raw) as StoredBenchmarkMeta;
    meta.revisions ??= [];
    meta.revision ??= null;
    return meta;
  }

  private async saveMeta(meta: StoredBenchmarkMeta) {
    await this.kv.put(this.metaKey(meta.id), JSON.stringify(meta));
  }

  private async manifest(id: string, revision: number): Promise<StoredHarborCase[]> {
    const raw = await this.kv.get(this.revisionKey(id, revision));
    if (raw === null) throw new EvalBenchmarkError(`Revision ${revision} of benchmark ${id} not found`, 404);
    return (JSON.parse(raw) as StoredRevisionManifest).cases;
  }

  private withCases(meta: StoredBenchmarkMeta, cases: StoredEvalCase[], casesRevision: number | null): StoredEvalBenchmark {
    const { cases: _messages, ...rest } = meta;
    return { ...rest, cases, cases_revision: casesRevision };
  }

  /** Write a new revision of `meta` from collected bundles; returns null
   *  when its digest equals the latest revision's (nothing written). */
  private async writeRevision(meta: StoredBenchmarkMeta, collected: CollectedHarborSource): Promise<StoredHarborCase[] | null> {
    const now = stamp();
    const latest = meta.revisions.at(-1);
    const previous = latest === undefined ? new Map<string, StoredHarborCase>() : new Map((await this.manifest(meta.id, latest.revision)).map((entry) => [entry.digest, entry]));
    const digested = await Promise.all(collected.bundles.map(async (bundle) => ({ bundle, digest: await harborContentDigest(bundle.files) })));
    const digest = await revisionDigest(digested.map(({ bundle, digest: caseDigest }) => ({ name: bundle.name, digest: caseDigest })));
    if (latest !== undefined && latest.digest === digest) return null;
    const cases: StoredHarborCase[] = [];
    for (const { bundle, digest: caseDigest } of digested) {
      const known = previous.get(caseDigest);
      // Same content and name as before: keep its first-seen time.
      if (known !== undefined && known.name === bundle.name) { cases.push(known); continue; }
      const stored: StoredTaskFiles = { files: bundle.files.map((file) => ({ path: file.path, b64: toBase64(file.bytes), executable: file.executable })) };
      await this.kv.put(this.blobKey(meta.id, caseDigest), JSON.stringify(stored));
      cases.push(summariseBundle(bundle, caseDigest, now));
    }
    const revision = (latest?.revision ?? 0) + 1;
    await this.kv.put(this.revisionKey(meta.id, revision), JSON.stringify({ cases } satisfies StoredRevisionManifest));
    meta.revisions.push({
      revision,
      digest,
      source: collected.source,
      pins: collected.pins,
      ...(collected.case_names !== undefined ? { case_names: collected.case_names } : {}),
      case_count: cases.length,
      created_at: now,
      supported_images: cases.filter((entry) => entry.supported).map((entry) => entry.image),
    });
    meta.revision = revision;
    meta.source = collected.source;
    meta.updated_at = now;
    // Blobs and manifest first, metadata last: a revision is visible only once complete.
    await this.saveMeta(meta);
    return cases;
  }

  async createHarbor(name: string, collected: CollectedHarborSource): Promise<StoredEvalBenchmark> {
    const now = stamp();
    const meta: StoredBenchmarkMeta = {
      id: `evbm_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      name,
      kind: "harbor",
      source: collected.source,
      created_at: now,
      updated_at: now,
      revision: null,
      revisions: [],
    };
    const cases = (await this.writeRevision(meta, collected))!;
    return this.withCases(meta, cases, meta.revision);
  }

  async createMessages(name: string, cases: Omit<StoredMessagesCase, "updated_at">[]): Promise<StoredEvalBenchmark> {
    const now = stamp();
    const meta: StoredBenchmarkMeta = {
      id: `evbm_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      name,
      kind: "messages",
      source: null,
      created_at: now,
      updated_at: now,
      revision: null,
      revisions: [],
      cases: cases.map((entry) => ({ ...entry, updated_at: now })),
    };
    await this.saveMeta(meta);
    return this.withCases(meta, meta.cases!, null);
  }

  /** Re-read a harbor benchmark's source into a new revision when it changed. */
  async sync(id: string, collected: CollectedHarborSource): Promise<{ changed: boolean; benchmark: StoredEvalBenchmark }> {
    const meta = await this.readMeta(id);
    if (meta === null) throw new EvalBenchmarkError("Benchmark not found", 404);
    if (meta.kind !== "harbor") throw new EvalBenchmarkError(`Benchmark ${id} is a ${meta.kind} benchmark`);
    const cases = await this.writeRevision(meta, collected);
    if (cases === null) return { changed: false, benchmark: (await this.get(id))! };
    return { changed: true, benchmark: this.withCases(meta, cases, meta.revision) };
  }

  /** With the cases of `revision` (harbor; default latest). */
  async get(id: string, revision?: number): Promise<StoredEvalBenchmark | null> {
    const meta = await this.readMeta(id);
    if (meta === null) return null;
    if (meta.kind === "messages") return this.withCases(meta, meta.cases ?? [], null);
    const wanted = revision ?? meta.revision;
    if (wanted === null) return this.withCases(meta, [], null);
    if (!meta.revisions.some((entry) => entry.revision === wanted)) throw new EvalBenchmarkError(`Benchmark ${id} has no revision ${wanted}`, 404);
    return this.withCases(meta, await this.manifest(id, wanted), wanted);
  }

  /** Metadata only (cases empty). */
  async list(): Promise<StoredEvalBenchmark[]> {
    const prefix = kvKey(this.tenantId, "evaldataset", "");
    const keys = await listAll(this.kv, prefix);
    const metaKeys = keys.map((key) => key.name).filter((name) => !name.slice(prefix.length).includes(":"));
    const rows = await Promise.all(metaKeys.map(async (key) => {
      const raw = await this.kv.get(key);
      if (raw === null) return null;
      const meta = JSON.parse(raw) as StoredBenchmarkMeta;
      return meta.kind === "messages" ? this.withCases(meta, meta.cases ?? [], null) : this.withCases(meta, [], null);
    }));
    return rows
      .filter((row): row is StoredEvalBenchmark => row !== null)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  async rename(id: string, name: string): Promise<StoredEvalBenchmark | null> {
    const meta = await this.readMeta(id);
    if (meta === null) return null;
    meta.name = name;
    meta.updated_at = stamp();
    await this.saveMeta(meta);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const meta = await this.readMeta(id);
    if (meta === null) return false;
    await this.kv.delete(this.metaKey(id));
    for (const key of await listAll(this.kv, kvKey(this.tenantId, "evaldataset", id, ""))) await this.kv.delete(key.name);
    return true;
  }

  private async requireMessages(id: string): Promise<StoredBenchmarkMeta & { cases: StoredMessagesCase[] }> {
    const meta = await this.readMeta(id);
    if (meta === null) throw new EvalBenchmarkError("Benchmark not found", 404);
    if (meta.kind !== "messages") {
      throw new EvalBenchmarkError(`Benchmark ${id} is a harbor benchmark: its cases are read-only, edit them at the source and sync`);
    }
    meta.cases ??= [];
    return meta as StoredBenchmarkMeta & { cases: StoredMessagesCase[] };
  }

  async addMessagesCase(id: string, entry: Omit<StoredMessagesCase, "updated_at">): Promise<StoredEvalBenchmark> {
    const meta = await this.requireMessages(id);
    if (meta.cases.some((existing) => existing.name === entry.name)) throw new EvalBenchmarkError(`Case(s) already in the benchmark: ${entry.name}`, 409);
    const now = stamp();
    meta.cases.push({ ...entry, updated_at: now });
    meta.updated_at = now;
    await this.saveMeta(meta);
    return this.withCases(meta, meta.cases, null);
  }

  private static indexOf(cases: readonly StoredEvalCase[], name: string): number {
    const index = cases.findIndex((entry) => entry.name === name);
    if (index < 0) throw new EvalBenchmarkError(`Case ${name} not found`, 404);
    return index;
  }

  async replaceMessagesCase(id: string, name: string, entry: Omit<StoredMessagesCase, "updated_at" | "name">): Promise<StoredMessagesCase> {
    const meta = await this.requireMessages(id);
    const index = EvalBenchmarkStore.indexOf(meta.cases, name);
    const now = stamp();
    const replaced: StoredMessagesCase = { ...entry, kind: "messages", name, updated_at: now };
    meta.cases[index] = replaced;
    meta.updated_at = now;
    await this.saveMeta(meta);
    return replaced;
  }

  async deleteMessagesCase(id: string, name: string): Promise<void> {
    const meta = await this.requireMessages(id);
    meta.cases.splice(EvalBenchmarkStore.indexOf(meta.cases, name), 1);
    meta.updated_at = stamp();
    await this.saveMeta(meta);
  }

  async taskFiles(id: string, digest: string): Promise<HarborTaskFile[] | null> {
    const raw = await this.kv.get(this.blobKey(id, digest));
    if (raw === null) return null;
    const stored = JSON.parse(raw) as StoredTaskFiles;
    return stored.files.map((file) => ({ path: file.path, bytes: fromBase64(file.b64), executable: file.executable }));
  }

  /** A harbor case by content digest (runs read the revision they were bound to). */
  async loadTask(id: string, name: string, digest: string | undefined): Promise<HarborTask> {
    if (digest === undefined) throw new EvalBenchmarkError(`Case ${name} of benchmark ${id}: the run has no case digest`, 404);
    const files = await this.taskFiles(id, digest);
    if (files === null) throw new EvalBenchmarkError(`Case ${name} (${digest}) of benchmark ${id} not found`, 404);
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

function revisionToApi(revision: StoredRevision): EvalBenchmarkRevision {
  const { supported_images: _images, ...rest } = revision;
  return rest;
}

/** withCases: cases of benchmark.cases_revision and every revision (newest first). */
export function benchmarkToApi(benchmark: StoredEvalBenchmark, aliasFor: ImageAliasResolver, withCases: boolean): EvalBenchmark {
  const shown = benchmark.kind === "harbor"
    ? benchmark.revisions.find((entry) => entry.revision === (benchmark.cases_revision ?? benchmark.revision))
    : undefined;
  const caseCount = benchmark.kind === "messages" ? benchmark.cases.length : shown?.case_count ?? 0;
  const runnable = benchmark.kind === "messages"
    ? benchmark.cases.length
    : (shown?.supported_images ?? []).filter((image) => aliasFor(image) !== null).length;
  return {
    id: benchmark.id,
    name: benchmark.name,
    kind: benchmark.kind,
    source: benchmark.source,
    revision: benchmark.revision,
    case_count: caseCount,
    runnable_count: runnable,
    created_at: benchmark.created_at,
    updated_at: benchmark.updated_at,
    ...(withCases ? { cases: benchmark.cases.map((entry) => caseToApi(entry, aliasFor)) } : {}),
    ...(withCases && benchmark.kind === "harbor"
      ? { revisions: [...benchmark.revisions].reverse().map(revisionToApi), ...(benchmark.cases_revision !== null ? { cases_revision: benchmark.cases_revision } : {}) }
      : {}),
  };
}

/** One case with harbor detail (full instruction + stored file list). */
export async function caseDetail(
  store: EvalBenchmarkStore,
  benchmark: StoredEvalBenchmark,
  entry: StoredEvalCase,
  aliasFor: ImageAliasResolver,
): Promise<EvalCaseDetail> {
  const api = caseToApi(entry, aliasFor);
  if (api.kind === "messages") return api;
  const files = await store.taskFiles(benchmark.id, api.digest) ?? [];
  const instruction = files.find((file) => file.path === "instruction.md");
  return {
    ...api,
    revision: benchmark.cases_revision ?? benchmark.revision ?? 0,
    instruction: instruction ? new TextDecoder().decode(instruction.bytes) : "",
    files: files
      .map((file) => ({ path: file.path, size: file.bytes.byteLength, executable: file.executable }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function summariseBundle(bundle: HarborTaskBundle, digest: string, updatedAt: string): StoredHarborCase {
  const instruction = bundle.files.find((file) => file.path === "instruction.md");
  const preview = instruction ? new TextDecoder().decode(instruction.bytes).slice(0, 2000) : "";
  try {
    const task = parseHarborTask(bundle.name, bundle.files);
    return {
      kind: "harbor",
      name: bundle.name,
      digest,
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
      digest,
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

export const DEFAULT_HARBOR_REGISTRY_URL = "https://raw.githubusercontent.com/harbor-framework/harbor/main/registry.json";

interface BuiltinDefinition extends BuiltinEvalBenchmark {
  git: { url: string; commit: string };
}

/** Benchmarks OMA ships: pinned to a commit, so the case set never drifts. */
export const BUILTIN_EVAL_BENCHMARKS: readonly BuiltinDefinition[] = [
  {
    name: "terminal-bench-sample@2.0",
    description: "10-task sample of Terminal-Bench 2.0 (Harbor registry terminal-bench-sample@2.0).",
    case_count: 10,
    git: { url: "https://github.com/laude-institute/terminal-bench-2-0-sample", commit: "7e917f35c281188532772312d4ad91ca9274febc" },
  },
  {
    name: "terminal-bench@2.0",
    description: "Terminal-Bench 2.0, 89 terminal tasks (Harbor registry terminal-bench@2.0).",
    case_count: 89,
    git: { url: "https://github.com/laude-institute/terminal-bench-2", commit: "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c" },
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

/** Same filter when the task root is not known yet (whole-tree scans). */
function keepAnywhere(path: string): boolean {
  const parts = path.split("/");
  const last = parts.at(-1);
  if (last === "task.toml" || last === "instruction.md") return true;
  if (parts.includes("tests") || parts.includes("solution")) return !parts.includes("environment");
  return path.endsWith("/environment/docker-compose.yaml") || path.endsWith("/environment/docker-compose.yml")
    || path === "environment/docker-compose.yaml" || path === "environment/docker-compose.yml";
}

function trimBundle(bundle: HarborTaskBundle): HarborTaskBundle {
  return { ...bundle, files: bundle.files.filter((file) => keepTaskFile(file.path)) };
}

export interface HarborImportDeps {
  fetch: typeof fetch;
  /** Read an uploaded Files API object; null when it does not exist. */
  readUpload(fileId: string): Promise<{ bytes: Uint8Array; filename?: string } | null>;
}

interface RegistryTask { name: string; git_url: string; git_commit_id?: string | null; path: string }
interface RegistryDataset { name: string; version: string; tasks: RegistryTask[] }

function cleanPath(path: string): string { return path.replace(/^\/+|\/+$/gu, ""); }

async function registryBundles(
  source: Extract<HarborCaseSource, { type: "registry" }>,
  taskNames: readonly string[] | undefined,
  deps: HarborImportDeps,
): Promise<{ bundles: HarborTaskBundle[]; pins: EvalSourcePin[]; version: string }> {
  const url = source.registry_url ?? DEFAULT_HARBOR_REGISTRY_URL;
  const fetchImpl = deps.fetch; // plain call: Workers' fetch rejects a foreign `this`
  const response = await fetchImpl(url);
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
  // One read per repository and commit; a task without a commit is pinned to HEAD now.
  const groups = new Map<string, { repo: ReturnType<typeof parseGitUrl>; commit: string; tasks: RegistryTask[] }>();
  const heads = new Map<string, string>();
  for (const task of tasks) {
    const repo = parseGitUrl(task.git_url);
    let commit = task.git_commit_id || undefined;
    if (commit === undefined || !isCommitSha(commit)) {
      const ref = commit;
      const key = `${repo.url}@${ref ?? "HEAD"}`;
      commit = heads.get(key) ?? await resolveGitRef(deps.fetch, repo, ref);
      heads.set(key, commit);
    }
    const key = `${repo.url}@${commit}`;
    const group = groups.get(key) ?? { repo, commit, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const bundles: HarborTaskBundle[] = [];
  for (const { repo, commit, tasks: groupTasks } of groups.values()) {
    const roots = groupTasks.map((task) => ({ task, root: cleanPath(task.path) }));
    const entries = await gitEntries(deps.fetch, repo, commit, roots.map(({ root }) => root), (path) =>
      roots.some(({ root }) => path.startsWith(`${root}/`) && keepTaskFile(path.slice(root.length + 1))));
    for (const { task, root } of roots) {
      const files = entries
        .filter((entry) => entry.type === "file" && entry.path.startsWith(`${root}/`))
        .map((entry) => ({ path: entry.path.slice(root.length + 1), bytes: entry.bytes, executable: (entry.mode & 0o111) !== 0 }));
      if (!files.some((file) => file.path === "task.toml")) {
        throw new EvalBenchmarkError(`Task ${task.name}: no task.toml at ${task.path} in ${repo.url}@${commit}`, 502);
      }
      bundles.push({ name: task.name, root: task.path, files });
    }
  }
  return { bundles, pins: [...groups.values()].map(({ repo, commit }) => ({ url: repo.url, commit })), version: dataset.version };
}

/** Bundles of every task directory under `path` (repository-relative). */
function bundlesUnder(entries: TarEntry[], path: string, fallbackName: string): HarborTaskBundle[] {
  const relative = path === ""
    ? entries
    : entries.filter((entry) => entry.path.startsWith(`${path}/`)).map((entry) => ({ ...entry, path: entry.path.slice(path.length + 1) }));
  return bundlesFromEntries(relative).map((bundle) => ({
    ...trimBundle(bundle),
    // A task at the import root is named after the path (or the repository).
    name: bundle.root === "" ? fallbackName : bundle.name,
    root: path === "" ? bundle.root : bundle.root === "" ? path : `${path}/${bundle.root}`,
  }));
}

function filterByName(bundles: HarborTaskBundle[], taskNames: readonly string[] | undefined, label: string): HarborTaskBundle[] {
  if (taskNames === undefined) return bundles;
  const known = new Set(bundles.map((bundle) => bundle.name));
  const missing = taskNames.filter((name) => !known.has(name));
  if (missing.length > 0) throw new EvalBenchmarkError(`Unknown task(s) in ${label}: ${missing.join(", ")}`);
  const wanted = new Set(taskNames);
  return bundles.filter((bundle) => wanted.has(bundle.name));
}

function stringField(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new EvalBenchmarkError(`${field} must be a non-empty string`);
  return value.trim();
}

/** Resolve a harbor source to commits and read its task bundles (validated,
 *  not stored). caseNames keeps only those tasks. */
export async function collectHarborBundles(
  input: HarborCaseSource | undefined,
  caseNames: unknown,
  deps: HarborImportDeps,
): Promise<CollectedHarborSource> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new EvalBenchmarkError("source is required");
  if (caseNames !== undefined && (!Array.isArray(caseNames) || caseNames.length === 0 || caseNames.some((name) => typeof name !== "string"))) {
    throw new EvalBenchmarkError("case_names must be a non-empty array of strings");
  }
  const names = caseNames as string[] | undefined;
  const raw = input as Record<string, unknown>;
  let collected: Omit<CollectedHarborSource, "case_names">;
  if (raw.type === "upload") {
    const fileId = stringField(raw.file_id, "source.file_id", true)!;
    const upload = await deps.readUpload(fileId);
    if (upload === null) throw new EvalBenchmarkError(`File ${fileId} not found`, 404);
    let entries: TarEntry[];
    try { entries = await readTarArchive(upload.bytes, { accept: keepAnywhere }); }
    catch (error) { throw new EvalBenchmarkError(`File ${fileId} is not a readable .tar/.tar.gz: ${error instanceof Error ? error.message : String(error)}`); }
    const defaultName = (upload.filename ?? fileId).replace(/\.(tar\.gz|tgz|tar)$/u, "");
    collected = { defaultName, source: { type: "upload", file_id: fileId }, pins: [], bundles: filterByName(bundlesUnder(entries, "", defaultName), names, "the upload") };
  } else if (raw.type === "git") {
    const url = stringField(raw.url, "source.url", true)!;
    const ref = stringField(raw.ref, "source.ref", false);
    const path = cleanPath(stringField(raw.path, "source.path", false) ?? "");
    if (path.split("/").includes("..")) throw new EvalBenchmarkError("source.path must not contain ..");
    const repo = parseGitUrl(url);
    const commit = await resolveGitRef(deps.fetch, repo, ref);
    const entries = await gitEntries(deps.fetch, repo, commit, path === "" ? null : [path], keepAnywhere);
    const repoName = repo.url.split("/").at(-1)!;
    const fallbackName = path === "" ? repoName : path.split("/").at(-1)!;
    collected = {
      defaultName: path === "" ? repoName : `${repoName}/${path}`,
      source: { type: "git", url: repo.url, ...(ref !== undefined ? { ref } : {}), ...(path !== "" ? { path } : {}) },
      pins: [{ url: repo.url, ref: ref ?? "HEAD", commit }],
      bundles: filterByName(bundlesUnder(entries, path, fallbackName), names, `${repo.url}${path ? `/${path}` : ""}`),
    };
  } else if (raw.type === "registry") {
    const name = stringField(raw.name, "source.name", true)!;
    const version = stringField(raw.version, "source.version", false);
    const registryUrl = stringField(raw.registry_url, "source.registry_url", false);
    if (registryUrl !== undefined && !/^https:\/\//u.test(registryUrl)) throw new EvalBenchmarkError("source.registry_url must be an https URL");
    const source = { type: "registry" as const, name, ...(version !== undefined ? { version } : {}), ...(registryUrl !== undefined ? { registry_url: registryUrl } : {}) };
    const read = await registryBundles(source, names, deps);
    collected = { defaultName: `${name}@${read.version}`, source: { ...source, version: read.version }, pins: read.pins, bundles: read.bundles };
  } else if (raw.type === "builtin") {
    const name = stringField(raw.name, "source.name", true)!;
    const builtin = BUILTIN_EVAL_BENCHMARKS.find((entry) => entry.name === name);
    if (builtin === undefined) {
      throw new EvalBenchmarkError(`Unknown builtin benchmark ${name} (available: ${BUILTIN_EVAL_BENCHMARKS.map((entry) => entry.name).join(", ")})`, 404);
    }
    const repo = parseGitUrl(builtin.git.url);
    const entries = await gitEntries(deps.fetch, repo, builtin.git.commit, null, keepAnywhere);
    collected = {
      defaultName: name,
      source: { type: "builtin", name },
      pins: [{ url: repo.url, commit: builtin.git.commit }],
      bundles: filterByName(bundlesUnder(entries, "", name), names, name),
    };
  } else {
    throw new EvalBenchmarkError(`Unknown source.type ${JSON.stringify(raw.type)} (git, registry, builtin or upload)`);
  }
  if (collected.bundles.length === 0) throw new EvalBenchmarkError("No Harbor task (a directory with task.toml) found");
  const seen = new Set<string>();
  for (const bundle of collected.bundles) {
    if (seen.has(bundle.name)) throw new EvalBenchmarkError(`Duplicate task name ${bundle.name}`);
    if (!CASE_NAME.test(bundle.name)) throw new EvalBenchmarkError(`Invalid task name ${JSON.stringify(bundle.name)}`);
    seen.add(bundle.name);
  }
  return { ...collected, ...(names !== undefined ? { case_names: [...names] } : {}) };
}
