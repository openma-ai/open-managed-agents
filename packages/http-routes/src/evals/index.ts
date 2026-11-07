// Eval routes — /v1/oma/evals (benchmarks, their cases, runs). Wire contract:
// packages/api-types/src/evals.ts. Runs are advanced by the scheduler tick
// (@open-managed-agents/evals-runner tickEvalRuns); these routes create,
// read, cancel and delete. Both runtimes mount the same routes and inject a
// managed-Session runtime, the benchmark store and an upload reader.

import { Hono } from "hono";
import type { EvalRunService, EvalRunRow, EvalRunStatus } from "@open-managed-agents/evals-store";
import type {
  AddEvalCasesRequest,
  CreateEvalBenchmarkRequest,
  CreateEvalRunRequest,
  HarborCaseSource,
  ReplaceEvalCaseRequest,
  SyncEvalBenchmarkRequest,
  UpdateEvalBenchmarkRequest,
} from "@open-managed-agents/api-types";
import {
  benchmarkToApi,
  caseDetail,
  collectHarborBundles,
  EvalBenchmarkError,
  listBuiltinBenchmarks,
  messagesCaseSpec,
  parseMessagesCase,
  recordToApi,
  rowToRecord,
  extractResults,
  isTerminal,
  runnableCase,
  stopRunTrials,
  DEFAULT_EVAL_CONCURRENCY,
  REWARD_TYPES,
  type EvalBenchmarkStore,
  type EvalRunRecord,
  type EvalSessionRuntime,
  type EvalTaskSpec,
  type StoredEvalBenchmark,
  type StoredHarborCase,
  type StoredMessagesCase,
} from "@open-managed-agents/evals-runner";

interface Vars {
  Variables: { tenant_id: string };
}

export type { EvalTaskSpec };

export interface EvalRoutesDeps {
  evals: EvalRunService;
  runtimeFor(tenantId: string): EvalSessionRuntime | Promise<EvalSessionRuntime>;
  benchmarksFor(tenantId: string): EvalBenchmarkStore | Promise<EvalBenchmarkStore>;
  /** Files API read for upload-sourced harbor cases. */
  readUpload(tenantId: string, fileId: string): Promise<{ bytes: Uint8Array; filename?: string } | null>;
  /** Outbound fetch for registry / GitHub imports; defaults to global fetch. */
  fetch?: typeof fetch;
}

const RUN_STATUSES: readonly EvalRunStatus[] = ["pending", "running", "completed", "failed", "cancelled"];
const MAX_TRIALS = 20;
const MAX_CONCURRENCY = 32;

function bad(message: string) { return { error: message }; }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function intInRange(value: unknown, field: string, min: number, max: number, fallback: number): number | string {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return `${field} must be an integer between ${min} and ${max}`;
  }
  return value;
}

function benchmarkName(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function buildEvalRoutes(deps: EvalRoutesDeps) {
  const app = new Hono<Vars>();
  const fetchImpl = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const importDeps = (t: string) => ({ fetch: fetchImpl, readUpload: (fileId: string) => deps.readUpload(t, fileId) });

  // EvalBenchmarkError -> its status; anything else propagates.
  const guard = async (c: { json: (body: unknown, status: 400 | 404 | 409 | 502) => Response }, work: () => Promise<Response>) => {
    try { return await work(); }
    catch (error) {
      if (error instanceof EvalBenchmarkError) return c.json(bad(error.message), error.status);
      throw error;
    }
  };

  async function context(t: string) {
    const [store, runtime] = await Promise.all([deps.benchmarksFor(t), deps.runtimeFor(t)]);
    return { store, runtime, alias: (image: string) => runtime.imageAlias(image) };
  }

  /** A pending/running run of the benchmark, or null. */
  async function activeRunOf(t: string, benchmarkId: string): Promise<string | null> {
    const rows = (await Promise.all((["pending", "running"] as const).map((status) => deps.evals.list({ tenantId: t, status, limit: 1000 })))).flat();
    return rows.map(rowToRecord).find((run) => run.benchmark_id === benchmarkId)?.id ?? null;
  }

  async function requireIdle(t: string, benchmarkId: string) {
    const active = await activeRunOf(t, benchmarkId);
    if (active !== null) throw new EvalBenchmarkError(`Benchmark is used by active run ${active}; wait for it or cancel it first`, 409);
  }

  async function requireBenchmark(store: EvalBenchmarkStore, id: string, revision?: number): Promise<StoredEvalBenchmark> {
    const benchmark = await store.get(id, revision);
    if (benchmark === null) throw new EvalBenchmarkError("Benchmark not found", 404);
    return benchmark;
  }

  // ── Benchmarks ──────────────────────────────────────────────────────────

  function revisionParam(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 1) throw new EvalBenchmarkError("revision must be a positive integer");
    return revision;
  }

  app.get("/benchmarks", async (c) => {
    const { store, alias } = await context(c.var.tenant_id);
    return c.json({ data: (await store.list()).map((benchmark) => benchmarkToApi(benchmark, alias, false)) });
  });

  app.get("/benchmarks/builtin", (c) => c.json({ data: listBuiltinBenchmarks() }));

  app.post("/benchmarks", async (c) => {
    const t = c.var.tenant_id;
    const body = await c.req.json<CreateEvalBenchmarkRequest>().catch(() => null);
    if (!isObject(body)) return c.json(bad("Request body must be a JSON object"), 400);
    return guard(c, async () => {
      const { store, alias } = await context(t);
      const raw = body as Record<string, unknown>;
      if (raw.kind !== undefined && raw.kind !== "harbor" && raw.kind !== "messages") {
        throw new EvalBenchmarkError("kind must be harbor or messages");
      }
      if (raw.source !== undefined) {
        if (raw.kind === "messages") throw new EvalBenchmarkError("source is only used by harbor benchmarks");
        if (raw.cases !== undefined) throw new EvalBenchmarkError("cases is only used by messages benchmarks");
        const collected = await collectHarborBundles(raw.source as HarborCaseSource, raw.case_names, importDeps(t));
        const name = raw.name === undefined ? collected.defaultName : benchmarkName(raw.name);
        if (name === null) throw new EvalBenchmarkError("name must be a non-empty string");
        return c.json(benchmarkToApi(await store.createHarbor(name, collected), alias, true), 201);
      }
      if (raw.kind !== "messages") {
        throw new EvalBenchmarkError("A harbor benchmark is imported from a source (git, registry, builtin or upload); pass source");
      }
      if (raw.case_names !== undefined) throw new EvalBenchmarkError("case_names needs a source");
      const name = benchmarkName(raw.name);
      if (name === null) throw new EvalBenchmarkError("name is required");
      if (raw.cases !== undefined && !Array.isArray(raw.cases)) throw new EvalBenchmarkError("cases must be an array");
      const cases = ((raw.cases as unknown[] | undefined) ?? []).map((entry) => parseMessagesCase(entry));
      const seen = new Set<string>();
      for (const entry of cases) {
        if (seen.has(entry.name)) throw new EvalBenchmarkError(`Duplicate case name ${entry.name}`);
        seen.add(entry.name);
      }
      return c.json(benchmarkToApi(await store.createMessages(name, cases), alias, true), 201);
    });
  });

  app.get("/benchmarks/:id", async (c) => guard(c, async () => {
    const { store, alias } = await context(c.var.tenant_id);
    return c.json(benchmarkToApi(await requireBenchmark(store, c.req.param("id"), revisionParam(c.req.query("revision"))), alias, true));
  }));

  app.patch("/benchmarks/:id", async (c) => {
    const body = await c.req.json<UpdateEvalBenchmarkRequest>().catch(() => null);
    if (!isObject(body)) return c.json(bad("Request body must be a JSON object"), 400);
    const unknown = Object.keys(body).filter((key) => key !== "name");
    if (unknown.length > 0) return c.json(bad(`Only name can be updated (got ${unknown.join(", ")})`), 400);
    const name = benchmarkName(body.name);
    if (name === null) return c.json(bad("name must be a non-empty string"), 400);
    return guard(c, async () => {
      const { store, alias } = await context(c.var.tenant_id);
      const renamed = await store.rename(c.req.param("id"), name);
      if (renamed === null) throw new EvalBenchmarkError("Benchmark not found", 404);
      return c.json(benchmarkToApi(renamed, alias, true));
    });
  });

  app.post("/benchmarks/:id/sync", async (c) => {
    const t = c.var.tenant_id;
    const body = await c.req.json<SyncEvalBenchmarkRequest>().catch(() => ({}));
    if (!isObject(body)) return c.json(bad("Request body must be a JSON object"), 400);
    return guard(c, async () => {
      const { store, alias } = await context(t);
      const id = c.req.param("id");
      const benchmark = await requireBenchmark(store, id);
      if (benchmark.kind !== "harbor") throw new EvalBenchmarkError("Only harbor benchmarks are synced from a source");
      const unknown = Object.keys(body).filter((key) => key !== "ref" && key !== "file_id");
      if (unknown.length > 0) throw new EvalBenchmarkError(`Unknown field(s): ${unknown.join(", ")}`);
      const latest = benchmark.revisions.at(-1)!;
      let source = latest.source;
      if (source.type === "upload") {
        if (typeof body.file_id !== "string" || body.file_id === "") throw new EvalBenchmarkError("An upload benchmark syncs from a new archive: pass file_id");
        source = { type: "upload", file_id: body.file_id };
      } else if (body.file_id !== undefined) {
        throw new EvalBenchmarkError(`file_id is only used by upload benchmarks (this one is ${source.type})`);
      }
      if (body.ref !== undefined) {
        if (source.type !== "git") throw new EvalBenchmarkError(`ref is only used by git benchmarks (this one is ${source.type})`);
        if (typeof body.ref !== "string" || body.ref.trim() === "") throw new EvalBenchmarkError("ref must be a non-empty string");
        source = { ...source, ref: body.ref.trim() };
      }
      const collected = await collectHarborBundles(source, latest.case_names, importDeps(t));
      const result = await store.sync(id, collected);
      return c.json({ changed: result.changed, benchmark: benchmarkToApi(result.benchmark, alias, true) });
    });
  });

  app.delete("/benchmarks/:id", async (c) => guard(c, async () => {
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    const store = await deps.benchmarksFor(t);
    await requireBenchmark(store, id);
    await requireIdle(t, id);
    await store.delete(id);
    return c.json({ type: "eval_benchmark_deleted", id });
  }));

  // ── Cases ───────────────────────────────────────────────────────────────
  // Harbor cases are read-only (sync the benchmark from its source); writes
  // apply to messages benchmarks, whose runs copy their cases at creation.

  app.get("/benchmarks/:id/cases/:name", async (c) => guard(c, async () => {
    const { store, alias } = await context(c.var.tenant_id);
    const name = c.req.param("name");
    const benchmark = await requireBenchmark(store, c.req.param("id"), revisionParam(c.req.query("revision")));
    const entry = benchmark.cases.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new EvalBenchmarkError(`Case ${name} not found`, 404);
    return c.json(await caseDetail(store, benchmark, entry, alias));
  }));

  app.post("/benchmarks/:id/cases", async (c) => {
    const body = await c.req.json<AddEvalCasesRequest>().catch(() => null);
    if (!isObject(body)) return c.json(bad("Request body must be a JSON object"), 400);
    return guard(c, async () => {
      const { store, alias } = await context(c.var.tenant_id);
      const updated = await store.addMessagesCase(c.req.param("id"), parseMessagesCase(body));
      return c.json(benchmarkToApi(updated, alias, true), 201);
    });
  });

  app.put("/benchmarks/:id/cases/:name", async (c) => {
    const body = await c.req.json<ReplaceEvalCaseRequest>().catch(() => null);
    if (!isObject(body)) return c.json(bad("Request body must be a JSON object"), 400);
    return guard(c, async () => {
      const { store, alias } = await context(c.var.tenant_id);
      const id = c.req.param("id");
      const name = c.req.param("name");
      const { name: _name, ...content } = parseMessagesCase(body, name);
      const replaced = await store.replaceMessagesCase(id, name, content);
      return c.json(await caseDetail(store, (await store.get(id))!, replaced, alias));
    });
  });

  app.delete("/benchmarks/:id/cases/:name", async (c) => guard(c, async () => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    await (await deps.benchmarksFor(c.var.tenant_id)).deleteMessagesCase(id, name);
    return c.json({ type: "eval_case_deleted", benchmark_id: id, name });
  }));

  // ── Runs ────────────────────────────────────────────────────────────────

  type NewRun = Omit<EvalRunRecord, "id" | "tenant_id" | "status" | "created_at">;

  async function createBenchmarkRun(t: string, runtime: EvalSessionRuntime, body: Record<string, unknown>): Promise<{ status: 200 | 400 | 404; body: unknown }> {
    const fail = (status: 400 | 404, message: string) => ({ status, body: bad(message) });
    if (typeof body.benchmark_id !== "string" || body.benchmark_id === "") return fail(400, "benchmark_id must be a non-empty string");
    if (body.kind !== undefined) return fail(400, "kind is not used with benchmark_id (the run has the benchmark's kind)");
    if (body.tasks !== undefined) return fail(400, "tasks is not used with benchmark_id (use case_names)");
    const trials = intInRange(body.trials, "trials", 1, MAX_TRIALS, 1);
    if (typeof trials === "string") return fail(400, trials);
    const concurrency = intInRange(body.concurrency, "concurrency", 1, MAX_CONCURRENCY, DEFAULT_EVAL_CONCURRENCY);
    if (typeof concurrency === "string") return fail(400, concurrency);
    const mode = body.mode ?? "agent";
    if (mode !== "agent" && mode !== "oracle") return fail(400, "mode must be agent or oracle");
    const benchmark = await (await deps.benchmarksFor(t)).get(body.benchmark_id);
    if (benchmark === null) return fail(404, "Benchmark not found");
    const alias = (image: string) => runtime.imageAlias(image);

    let selected = benchmark.cases;
    if (body.case_names !== undefined) {
      const names = body.case_names;
      if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string")) {
        return fail(400, "case_names must be a non-empty array of strings");
      }
      const byName = new Map(benchmark.cases.map((entry) => [entry.name, entry]));
      const missing = (names as string[]).filter((name) => !byName.has(name));
      if (missing.length > 0) return fail(400, `Unknown case(s): ${missing.join(", ")}`);
      selected = [...new Set(names as string[])].map((name) => byName.get(name)!);
      const blocked = selected.filter((entry) => !runnableCase(entry, alias)) as StoredHarborCase[];
      if (blocked.length > 0) {
        return fail(400, `Case(s) cannot run here: ${blocked.map((entry) => entry.supported
          ? `${entry.name} (image ${entry.image} is not in SANDBOX_IMAGES)`
          : `${entry.name} (${entry.unsupported_reason})`).join("; ")}`);
      }
    } else {
      selected = selected.filter((entry) => runnableCase(entry, alias));
      if (selected.length === 0) {
        return fail(400, benchmark.kind === "messages"
          ? "Benchmark has no cases"
          : "No case of this benchmark can run here (unsupported, or image not in SANDBOX_IMAGES)");
      }
    }
    const pendingTrials = () => Array.from({ length: trials }, (_, index) => ({ trial_index: index, status: "pending" as const }));

    if (benchmark.kind === "messages") {
      if (mode !== "agent") return fail(400, "messages benchmarks run in mode agent only");
      if (typeof body.agent_id !== "string" || body.agent_id === "") return fail(400, "agent_id is required");
      if (typeof body.environment_id !== "string" || body.environment_id === "") return fail(400, "environment_id is required for a messages benchmark");
      const [agentOk, envOk] = await Promise.all([runtime.agentExists(body.agent_id), runtime.environmentExists(body.environment_id)]);
      if (!agentOk) return fail(404, "Agent not found");
      if (!envOk) return fail(404, "Environment not found");
      const envProblem = await runtime.environmentProblem?.(body.environment_id) ?? null;
      if (envProblem !== null) return fail(400, envProblem);
      const record: NewRun = {
        kind: "messages",
        agent_id: body.agent_id,
        environment_id: body.environment_id,
        benchmark_id: benchmark.id,
        mode: "agent",
        concurrency,
        task_count: selected.length,
        completed_count: 0,
        failed_count: 0,
        // Snapshot: later case edits do not change this run.
        tasks: (selected as StoredMessagesCase[]).map((entry) => ({
          id: entry.name,
          spec: messagesCaseSpec(entry),
          status: "pending" as const,
          trial_total: trials,
          trials: pendingTrials(),
        })),
      };
      const run = await deps.evals.create({
        tenantId: t,
        agentId: body.agent_id,
        environmentId: body.environment_id,
        suite: benchmark.name,
        results: extractResults({ ...record, id: "", tenant_id: t, status: "pending", created_at: "" }),
      });
      return { status: 200, body: { run_id: run.id, task_count: selected.length } };
    }

    if (body.environment_id !== undefined) return fail(400, "environment_id is not used by harbor benchmarks (each case's image picks its environment)");
    if (mode === "agent") {
      if (typeof body.agent_id !== "string" || body.agent_id === "") return fail(400, "agent_id is required for mode agent");
      if (!(await runtime.agentExists(body.agent_id))) return fail(404, "Agent not found");
    } else if (body.agent_id !== undefined) {
      return fail(400, "agent_id is not used in mode oracle");
    }
    const harborCases = selected as StoredHarborCase[];
    if (mode === "oracle") {
      const noSolution = harborCases.filter((entry) => !entry.has_solution);
      if (noSolution.length > 0) return fail(400, `Case(s) without solution/solve.sh: ${noSolution.map((entry) => entry.name).join(", ")}`);
    }
    const record: NewRun = {
      kind: "harbor",
      agent_id: mode === "agent" ? body.agent_id as string : null,
      environment_id: null,
      benchmark_id: benchmark.id,
      benchmark_revision: benchmark.revision!,
      mode,
      concurrency,
      task_count: harborCases.length,
      completed_count: 0,
      failed_count: 0,
      tasks: harborCases.map((entry) => ({
        id: entry.name,
        status: "pending" as const,
        trial_total: trials,
        image_alias: alias(entry.image)!,
        digest: entry.digest,
        trials: pendingTrials(),
      })),
    };
    const run = await deps.evals.create({
      tenantId: t,
      // NOT NULL columns: the agent column keeps agent-delete safety checks
      // working; oracle runs and the environment column use "".
      agentId: record.agent_id ?? "",
      environmentId: "",
      suite: benchmark.name,
      results: extractResults({ ...record, id: "", tenant_id: t, status: "pending", created_at: "" }),
    });
    return { status: 200, body: { run_id: run.id, task_count: harborCases.length } };
  }

  app.post("/runs", async (c) => {
    const t = c.var.tenant_id;
    const body = await c.req.json<CreateEvalRunRequest>().catch(() => null);
    if (body === null || typeof body !== "object") return c.json(bad("Request body must be a JSON object"), 400);
    const runtime = await deps.runtimeFor(t);

    if ("benchmark_id" in body) {
      const result = await createBenchmarkRun(t, runtime, body as Record<string, unknown>);
      return c.json(result.body, result.status);
    }
    if (body.kind !== undefined && body.kind !== "messages") {
      return c.json(bad("kind must be messages; benchmark runs pass benchmark_id instead"), 400);
    }
    if (!body.agent_id) return c.json(bad("agent_id is required"), 400);
    if (!body.environment_id) return c.json(bad("environment_id is required"), 400);
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) return c.json(bad("tasks array is required and must be non-empty"), 400);
    for (const task of body.tasks) {
      if (!task.id) return c.json(bad(`task missing id: ${JSON.stringify(task).slice(0, 100)}`), 400);
      if (!Array.isArray(task.messages) || task.messages.length === 0) return c.json(bad(`task ${task.id} requires non-empty messages array`), 400);
      const reward = (task as { reward?: unknown }).reward;
      if (reward !== undefined) {
        const type = reward !== null && typeof reward === "object" ? (reward as { type?: unknown }).type : undefined;
        if (typeof type !== "string" || !REWARD_TYPES.has(type)) {
          return c.json(bad(`task ${task.id} reward.type must be one of ${[...REWARD_TYPES].join(", ")}`), 400);
        }
      }
      const trials = intInRange(task.trials, `task ${task.id} trials`, 1, MAX_TRIALS, 1);
      if (typeof trials === "string") return c.json(bad(trials), 400);
    }
    const [agentOk, envOk] = await Promise.all([runtime.agentExists(body.agent_id), runtime.environmentExists(body.environment_id)]);
    if (!agentOk) return c.json(bad("Agent not found"), 404);
    if (!envOk) return c.json(bad("Environment not found"), 404);
    const envProblem = await runtime.environmentProblem?.(body.environment_id) ?? null;
    if (envProblem !== null) return c.json(bad(envProblem), 400);
    const record: Omit<EvalRunRecord, "id" | "tenant_id" | "status" | "created_at"> = {
      kind: "messages",
      agent_id: body.agent_id,
      environment_id: body.environment_id,
      task_count: body.tasks.length,
      completed_count: 0,
      failed_count: 0,
      tasks: body.tasks.map((spec) => {
        const trialCount = spec.trials ?? 1;
        return {
          id: spec.id,
          spec: spec as EvalTaskSpec,
          status: "pending" as const,
          trial_total: trialCount,
          trials: Array.from({ length: trialCount }, (_, index) => ({ trial_index: index, status: "pending" as const })),
        };
      }),
    };
    const run = await deps.evals.create({
      tenantId: t,
      agentId: body.agent_id,
      environmentId: body.environment_id,
      results: extractResults({ ...record, id: "", tenant_id: t, status: "pending", created_at: "" }),
    });
    return c.json({ run_id: run.id, task_count: body.tasks.length });
  });

  app.get("/runs", async (c) => {
    const t = c.var.tenant_id;
    const limitParam = c.req.query("limit");
    let limit = limitParam ? parseInt(limitParam, 10) : 100;
    if (isNaN(limit) || limit < 1) limit = 100;
    if (limit > 1000) limit = 1000;
    const statusRaw = c.req.query("status");
    if (statusRaw !== undefined && !RUN_STATUSES.includes(statusRaw as EvalRunStatus)) {
      return c.json(bad(`Invalid status '${statusRaw}'; expected one of ${RUN_STATUSES.join("|")}.`), 400);
    }
    const benchmarkId = c.req.query("benchmark_id") || undefined;
    const rows = await deps.evals.list({
      tenantId: t,
      limit: benchmarkId ? 1000 : limit,
      agentId: c.req.query("agent_id") || undefined,
      environmentId: c.req.query("environment_id") || undefined,
      ...(statusRaw !== undefined ? { status: statusRaw as EvalRunStatus } : {}),
    });
    let runs = rows.map(rowToRecord);
    if (benchmarkId) runs = runs.filter((run) => run.benchmark_id === benchmarkId).slice(0, limit);
    return c.json({ data: runs.map(recordToApi) });
  });

  app.get("/runs/:id", async (c) => {
    const run = await deps.evals.get({ tenantId: c.var.tenant_id, runId: c.req.param("id") });
    if (!run) return c.json(bad("Run not found"), 404);
    return c.json(recordToApi(rowToRecord(run)));
  });

  async function cancel(t: string, row: EvalRunRow): Promise<EvalRunRecord> {
    const run = rowToRecord(row);
    if (isTerminal(run.status)) return run;
    // Flip the row first so a concurrent tick stops writing it.
    await deps.evals.markCompleted({ tenantId: t, runId: run.id, status: "cancelled", error: "cancelled by user" });
    await stopRunTrials(await deps.runtimeFor(t), run);
    run.status = "cancelled";
    run.error = "cancelled by user";
    const saved = await deps.evals.markCompleted({ tenantId: t, runId: run.id, status: "cancelled", results: extractResults(run), error: run.error });
    return rowToRecord(saved);
  }

  app.post("/runs/:id/cancel", async (c) => {
    const t = c.var.tenant_id;
    const row = await deps.evals.get({ tenantId: t, runId: c.req.param("id") });
    if (!row) return c.json(bad("Run not found"), 404);
    return c.json(recordToApi(await cancel(t, row)));
  });

  app.delete("/runs/:id", async (c) => {
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    const row = await deps.evals.get({ tenantId: t, runId: id });
    if (!row) return c.json(bad("Run not found"), 404);
    await cancel(t, row);
    await deps.evals.delete({ tenantId: t, runId: id });
    return c.json({ type: "eval_run_deleted", id });
  });

  return app;
}
