import { describe, expect, expectTypeOf, it } from "vitest";
import { OpenMA, type EvalBenchmark, type EvalCaseDetail, type EvalRun, type SyncEvalBenchmarkResponse } from "../src/index.js";

type Call = { method: string; path: string; search: string; headers: Headers; body: string | FormData | null };

function mockClient(responder: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new OpenMA({
    apiKey: "evals-key", baseURL: "https://openma.test", maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      // The client probes FormData support with a data: URL; not an API call.
      if (url.protocol === "data:") return new Response("");
      const type = request.headers.get("content-type") ?? "";
      const body = request.method === "GET" || request.method === "DELETE" ? null
        : type.includes("multipart/form-data") ? await request.formData() : await request.text();
      const call = { method: request.method, path: url.pathname, search: url.search, headers: request.headers, body };
      calls.push(call);
      const out = responder(call);
      return out instanceof Response ? out : Response.json(out);
    },
  });
  return { client, calls };
}

const run = (status: EvalRun["status"]): EvalRun => ({
  id: "evr_1", kind: "harbor", agent_id: "agent_1", environment_id: null, benchmark_id: "evb_1",
  status, created_at: "2026-11-01T00:00:00Z", task_count: 1, completed_count: status === "completed" ? 1 : 0,
  failed_count: 0, tasks: [],
});

const bench = (over: Partial<EvalBenchmark> = {}): EvalBenchmark => ({
  id: "evb_1", name: "hello", kind: "harbor", source: { type: "builtin", name: "hello" }, revision: 1, case_count: 2, runnable_count: 2,
  created_at: "x", updated_at: "x", cases: [], ...over,
});

const filesResponse = { id: "file_9", type: "file", filename: "tasks.tar.gz", mime_type: "application/gzip", size_bytes: 3, created_at: "x" };

describe("evals benchmarks", () => {
  it("lists, lists builtin, creates, retrieves, renames and deletes with the managed agents beta", async () => {
    const { client, calls } = mockClient((c) => {
      if (c.path === "/v1/oma/evals/benchmarks/builtin") return { data: [{ name: "hello", description: "d", case_count: 2 }] };
      if (c.method === "DELETE") return { type: "eval_benchmark_deleted", id: "evb_1" };
      if (c.path === "/v1/oma/evals/benchmarks" && c.method === "GET") return { data: [] };
      return bench();
    });
    const evals = client.oma.evals;
    await evals.benchmarks.list();
    const builtin = await evals.benchmarks.listBuiltin();
    const created = await evals.benchmarks.create({ source: { type: "registry", name: "terminal-bench", version: "2.0" }, case_names: ["a"] });
    expectTypeOf(created).toExtend<EvalBenchmark>();
    await evals.benchmarks.create({ kind: "messages", name: "smoke", cases: [{ name: "c1", messages: ["hi"] }] });
    await evals.benchmarks.retrieve("evb/1");
    await evals.benchmarks.update("evb_1", { name: "renamed" });
    const deleted = await evals.benchmarks.delete("evb_1");
    expect(builtin.data[0].case_count).toBe(2);
    expect(deleted).toEqual({ type: "eval_benchmark_deleted", id: "evb_1" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/oma/evals/benchmarks",
      "GET /v1/oma/evals/benchmarks/builtin",
      "POST /v1/oma/evals/benchmarks",
      "POST /v1/oma/evals/benchmarks",
      "GET /v1/oma/evals/benchmarks/evb%2F1",
      "PATCH /v1/oma/evals/benchmarks/evb_1",
      "DELETE /v1/oma/evals/benchmarks/evb_1",
    ]);
    expect(JSON.parse(calls[2].body as string)).toEqual({ source: { type: "registry", name: "terminal-bench", version: "2.0" }, case_names: ["a"] });
    expect(JSON.parse(calls[3].body as string)).toEqual({ kind: "messages", name: "smoke", cases: [{ name: "c1", messages: ["hi"] }] });
    expect(JSON.parse(calls[5].body as string)).toEqual({ name: "renamed" });
    for (const c of calls) {
      expect(c.headers.get("anthropic-beta")).toContain("managed-agents-2026-04-01");
      expect(c.headers.get("x-api-key")).toBe("evals-key");
    }
  });

  it("uploads an archive through the Files API and imports it by file id", async () => {
    const { client, calls } = mockClient((c) => {
      if (c.path === "/v1/files") return filesResponse;
      return bench({ id: "evb_2", name: "mine", source: { type: "upload", file_id: "file_9" } });
    });
    const b = await client.oma.evals.benchmarks.upload({ name: "mine", file: new Uint8Array([1, 2, 3]), filename: "tasks.tar.gz", case_names: ["x"] });
    expect(b.id).toBe("evb_2");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/files", "POST /v1/oma/evals/benchmarks"]);
    const form = calls[0].body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("tasks.tar.gz");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0].headers.get("anthropic-beta")).toContain("files-api-2025-04-14");
    expect(JSON.parse(calls[1].body as string)).toEqual({ name: "mine", source: { type: "upload", file_id: "file_9" }, case_names: ["x"] });
  });

  it("rejects non-archive file names before uploading", async () => {
    const { client, calls } = mockClient(() => ({}));
    await expect(client.oma.evals.benchmarks.upload({ file: new Uint8Array([1]), filename: "tasks.zip" })).rejects.toThrow(/\.tar/);
    await expect(client.oma.evals.benchmarks.syncUpload("evb_1", { file: new Uint8Array([1]), filename: "x.zip" })).rejects.toThrow(/\.tar/);
    await expect(client.oma.evals.benchmarks.syncUpload("", { file: new Uint8Array([1]), filename: "x.tgz" })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("imports from git, reads a revision and syncs (ref, upload, no body)", async () => {
    const { client, calls } = mockClient((c) => {
      if (c.path === "/v1/files") return filesResponse;
      if (c.path.endsWith("/sync")) return { changed: true, benchmark: bench({ revision: 2 }) };
      return bench({ source: { type: "git", url: "https://github.com/o/r", ref: "main", path: "tasks" } });
    });
    const benchmarks = client.oma.evals.benchmarks;
    await benchmarks.create({ source: { type: "git", url: "https://github.com/o/r", ref: "main", path: "tasks" } });
    await benchmarks.retrieve("evb_1", { revision: 1 });
    await benchmarks.retrieve("evb_1");
    const synced = await benchmarks.sync("evb_1", { ref: "v2" });
    expectTypeOf(synced).toExtend<SyncEvalBenchmarkResponse>();
    expect(synced.changed).toBe(true);
    expect(synced.benchmark.revision).toBe(2);
    await benchmarks.sync("evb_1");
    await benchmarks.syncUpload("evb_1", { file: new Uint8Array([1]), filename: "new.tgz" });
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      "POST /v1/oma/evals/benchmarks",
      "GET /v1/oma/evals/benchmarks/evb_1?revision=1",
      "GET /v1/oma/evals/benchmarks/evb_1",
      "POST /v1/oma/evals/benchmarks/evb_1/sync",
      "POST /v1/oma/evals/benchmarks/evb_1/sync",
      "POST /v1/files",
      "POST /v1/oma/evals/benchmarks/evb_1/sync",
    ]);
    expect(JSON.parse(calls[0].body as string)).toEqual({ source: { type: "git", url: "https://github.com/o/r", ref: "main", path: "tasks" } });
    expect(JSON.parse(calls[3].body as string)).toEqual({ ref: "v2" });
    expect(JSON.parse(calls[4].body as string)).toEqual({});
    expect(JSON.parse(calls[6].body as string)).toEqual({ file_id: "file_9" });
    for (const c of calls) expect(c.headers.get("anthropic-beta")).toContain("managed-agents-2026-04-01");
  });

  it("surfaces server errors", async () => {
    const { client } = mockClient(() => Response.json({ error: "unknown builtin benchmark: nope" }, { status: 404 }));
    await expect(client.oma.evals.benchmarks.create({ source: { type: "builtin", name: "nope" } })).rejects.toThrow(/unknown builtin benchmark/);
  });
});

describe("evals cases", () => {
  it("retrieves (optionally at a revision), adds, replaces and deletes messages cases", async () => {
    const detail: EvalCaseDetail = { kind: "messages", name: "c 1", messages: ["hi"], updated_at: "x" };
    const { client, calls } = mockClient((c) => {
      if (c.method === "DELETE") return { type: "eval_case_deleted", benchmark_id: "evb_1", name: "c 1" };
      if (c.method === "POST") return bench({ kind: "messages", source: null });
      return detail;
    });
    const cases = client.oma.evals.benchmarks.cases;
    const got = await cases.retrieve("evb_1", "c 1");
    expectTypeOf(got).toExtend<EvalCaseDetail>();
    await cases.retrieve("evb_1", "c 1", { revision: 3 });
    await cases.add("evb_1", { name: "c2", messages: ["a", "b"], timeout_ms: 1000 });
    await cases.replace("evb_1", "c 1", { name: "ignored", messages: ["new"] });
    const deleted = await cases.delete("evb_1", "c 1");
    expect(deleted).toEqual({ type: "eval_case_deleted", benchmark_id: "evb_1", name: "c 1" });
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      "GET /v1/oma/evals/benchmarks/evb_1/cases/c%201",
      "GET /v1/oma/evals/benchmarks/evb_1/cases/c%201?revision=3",
      "POST /v1/oma/evals/benchmarks/evb_1/cases",
      "PUT /v1/oma/evals/benchmarks/evb_1/cases/c%201",
      "DELETE /v1/oma/evals/benchmarks/evb_1/cases/c%201",
    ]);
    expect(calls.slice(2, 4).map((c) => JSON.parse(c.body as string))).toEqual([
      { name: "c2", messages: ["a", "b"], timeout_ms: 1000 },
      { name: "ignored", messages: ["new"] },
    ]);
    for (const c of calls) expect(c.headers.get("anthropic-beta")).toContain("managed-agents-2026-04-01");
  });
});

describe("evals runs", () => {
  it("creates, lists with query, retrieves, cancels and deletes", async () => {
    const { client, calls } = mockClient((c) => {
      if (c.path === "/v1/oma/evals/runs" && c.method === "POST") return { run_id: "evr_1", task_count: 3 };
      if (c.path === "/v1/oma/evals/runs" && c.method === "GET") return { data: [run("running")] };
      if (c.method === "DELETE") return { type: "eval_run_deleted", id: "evr_1" };
      if (c.path.endsWith("/cancel")) return run("cancelled");
      return run("running");
    });
    const created = await client.oma.evals.runs.create({ benchmark_id: "evb_1", mode: "oracle", trials: 2, concurrency: 8, case_names: ["t1"] });
    expect(created).toEqual({ run_id: "evr_1", task_count: 3 });
    await client.oma.evals.runs.list({ status: "running", benchmark_id: "evb_1", limit: 10 });
    await client.oma.evals.runs.retrieve("evr_1");
    expect((await client.oma.evals.runs.cancel("evr_1")).status).toBe("cancelled");
    await client.oma.evals.runs.delete("evr_1");
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      "POST /v1/oma/evals/runs",
      "GET /v1/oma/evals/runs?status=running&benchmark_id=evb_1&limit=10",
      "GET /v1/oma/evals/runs/evr_1",
      "POST /v1/oma/evals/runs/evr_1/cancel",
      "DELETE /v1/oma/evals/runs/evr_1",
    ]);
    expect(JSON.parse(calls[0].body as string)).toEqual({ benchmark_id: "evb_1", mode: "oracle", trials: 2, concurrency: 8, case_names: ["t1"] });
  });

  it("creates messages benchmark runs with an environment and inline messages runs", async () => {
    const { client, calls } = mockClient(() => ({ run_id: "evr_2", task_count: 1 }));
    await client.oma.evals.runs.create({ benchmark_id: "evb_m", agent_id: "agent_1", environment_id: "env_1" });
    await client.oma.evals.runs.create({ agent_id: "agent_1", environment_id: "env_1", tasks: [{ id: "t", messages: ["hi"] }] });
    expect(calls.map((c) => JSON.parse(c.body as string))).toEqual([
      { benchmark_id: "evb_m", agent_id: "agent_1", environment_id: "env_1" },
      { agent_id: "agent_1", environment_id: "env_1", tasks: [{ id: "t", messages: ["hi"] }] },
    ]);
  });

  it("waitForRun polls until a terminal status and reports progress", async () => {
    const statuses: EvalRun["status"][] = ["pending", "running", "completed"];
    let i = 0;
    const { client, calls } = mockClient(() => run(statuses[Math.min(i++, statuses.length - 1)]));
    const seen: string[] = [];
    const final = await client.oma.evals.runs.waitForRun("evr_1", { intervalMs: 1, onProgress: (r) => seen.push(r.status) });
    expect(final.status).toBe("completed");
    expect(seen).toEqual(["pending", "running", "completed"]);
    expect(calls).toHaveLength(3);
  });

  it("waitForRun returns failed and cancelled runs and times out on stuck ones", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const { client } = mockClient(() => run(status));
      expect((await client.oma.evals.runs.waitForRun("evr_1", { intervalMs: 1 })).status).toBe(status);
    }
    const { client } = mockClient(() => run("running"));
    await expect(client.oma.evals.runs.waitForRun("evr_1", { intervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/Timed out/);
    await expect(client.oma.evals.runs.waitForRun("evr_1", { timeoutMs: 0 })).rejects.toThrow(RangeError);
  });
});
