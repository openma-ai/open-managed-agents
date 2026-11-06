import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { createInMemoryEvalRunService } from "@open-managed-agents/evals-store/test-fakes";
import { EvalBenchmarkStore, type EvalSessionRuntime } from "@open-managed-agents/evals-runner";
import { buildEvalRoutes } from "../../src/evals";

const runtime = {
  agentExists: async (id: string) => id === "agent_1",
  environmentExists: async (id: string) => id === "env_1" || id === "env_selfhosted",
  environmentProblem: async (id: string) => (id === "env_selfhosted" ? "self_hosted environments are not supported" : null),
  imageAlias: (image: string) => (image.startsWith("img/") ? image.slice(4).split(":")[0]! : null),
} as unknown as EvalSessionRuntime;

/** A .tar.gz holding one task directory per name (image img/<name>:1). */
async function taskArchive(names: string[], instruction = "Solve"): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), "evals-routes-"));
  for (const name of names) {
    const dir = join(root, "set", name);
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "task.toml"), `[environment]\ndocker_image = "img/${name}:1"\n`);
    await writeFile(join(dir, "instruction.md"), `${instruction} ${name}.`);
    await writeFile(join(dir, "tests", "test.sh"), "#!/bin/bash\n");
  }
  const archive = join(root, "set.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "set"]);
  return new Uint8Array(await readFile(archive));
}

let app: Hono;
let uploads: Map<string, Uint8Array>;
let evals: ReturnType<typeof createInMemoryEvalRunService>["service"];

beforeEach(() => {
  const kv = new InMemoryKvStore();
  uploads = new Map();
  evals = createInMemoryEvalRunService().service;
  const routes = buildEvalRoutes({
    evals,
    runtimeFor: () => runtime,
    benchmarksFor: (t) => new EvalBenchmarkStore(kv, t),
    readUpload: async (_t, fileId) => (uploads.has(fileId) ? { bytes: uploads.get(fileId)!, filename: `${fileId}.tar.gz` } : null),
    fetch: (() => { throw new Error("no network"); }) as never,
  });
  app = new Hono();
  app.use("*", async (c, next) => { c.set("tenant_id" as never, "t" as never); await next(); });
  app.route("/", routes as never);
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as any };
};

async function messagesBenchmark() {
  const res = await call("POST", "/benchmarks", {
    kind: "messages", name: " chat ",
    cases: [{ name: "a", messages: ["hello"], reward: { type: "verifiable", check: "x" } }, { name: "b", messages: ["one", "two"], timeout_ms: 5000 }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("messages benchmarks and cases", () => {
  it("creates, reads, renames and lists", async () => {
    const created = await messagesBenchmark();
    expect(created).toMatchObject({ name: "chat", kind: "messages", source: null, case_count: 2, runnable_count: 2 });
    expect(created.cases[1]).toMatchObject({ kind: "messages", name: "b", messages: ["one", "two"], timeout_ms: 5000, updated_at: expect.any(String) });
    const list = await call("GET", "/benchmarks");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].cases).toBeUndefined();
    const renamed = await call("PATCH", `/benchmarks/${created.id}`, { name: "renamed" });
    expect(renamed).toMatchObject({ status: 200, body: { name: "renamed", case_count: 2 } });
    expect((await call("PATCH", `/benchmarks/${created.id}`, { name: "" })).status).toBe(400);
    expect((await call("PATCH", `/benchmarks/${created.id}`, { kind: "harbor" })).status).toBe(400);
    expect((await call("PATCH", "/benchmarks/evbm_nope", { name: "x" })).status).toBe(404);
  });

  it("validates create requests", async () => {
    expect((await call("POST", "/benchmarks", { kind: "messages" })).status).toBe(400);
    expect((await call("POST", "/benchmarks", { name: "x" })).status).toBe(400);
    expect((await call("POST", "/benchmarks", { kind: "messages", name: "x", cases: [{ name: "a", messages: ["m"] }, { name: "a", messages: ["m"] }] })).status).toBe(400);
    expect((await call("POST", "/benchmarks", { kind: "messages", name: "x", cases: [{ name: "a", messages: ["m"], reward: { type: "bogus" } }] })).status).toBe(400);
    expect((await call("POST", "/benchmarks", { kind: "messages", name: "x", source: { type: "upload", file_id: "f" } })).status).toBe(400);
    expect((await call("POST", "/benchmarks", { kind: "harbor", name: "x", cases: [] })).status).toBe(400);
  });

  it("adds, gets, replaces and deletes a case; duplicate add is 409", async () => {
    const { id } = await messagesBenchmark();
    const added = await call("POST", `/benchmarks/${id}/cases`, { name: "c", messages: ["third"] });
    expect(added.status).toBe(201);
    expect(added.body.cases.map((entry: any) => entry.name)).toEqual(["a", "b", "c"]);
    expect((await call("POST", `/benchmarks/${id}/cases`, { name: "c", messages: ["again"] })).status).toBe(409);
    expect((await call("POST", `/benchmarks/${id}/cases`, { source: { type: "upload", file_id: "f" } })).status).toBe(400);

    expect(await call("GET", `/benchmarks/${id}/cases/a`)).toMatchObject({ status: 200, body: { kind: "messages", name: "a", messages: ["hello"] } });
    expect((await call("GET", `/benchmarks/${id}/cases/zzz`)).status).toBe(404);

    const replaced = await call("PUT", `/benchmarks/${id}/cases/a`, { name: "ignored", messages: ["changed"] });
    expect(replaced).toMatchObject({ status: 200, body: { name: "a", messages: ["changed"] } });
    expect(replaced.body.reward).toBeUndefined();
    expect((await call("PUT", `/benchmarks/${id}/cases/zzz`, { messages: ["x"] })).status).toBe(404);
    expect((await call("PUT", `/benchmarks/${id}/cases/a`, { messages: [] })).status).toBe(400);

    expect(await call("DELETE", `/benchmarks/${id}/cases/c`)).toEqual({ status: 200, body: { type: "eval_case_deleted", benchmark_id: id, name: "c" } });
    expect((await call("GET", `/benchmarks/${id}`)).body.case_count).toBe(2);
  });

  it("runs a messages benchmark: snapshot specs, concurrency, 409 on writes while active", async () => {
    const { id } = await messagesBenchmark();
    const base = { benchmark_id: id, agent_id: "agent_1", environment_id: "env_1" };
    expect((await call("POST", "/runs", { ...base, mode: "oracle" })).status).toBe(400);
    expect((await call("POST", "/runs", { benchmark_id: id, agent_id: "agent_1" })).status).toBe(400);
    expect((await call("POST", "/runs", { ...base, agent_id: "agent_x" })).status).toBe(404);
    expect((await call("POST", "/runs", { ...base, environment_id: "env_x" })).status).toBe(404);
    const selfHosted = await call("POST", "/runs", { ...base, environment_id: "env_selfhosted" });
    expect(selfHosted.status).toBe(400);
    expect(selfHosted.body.error).toMatch(/self_hosted/);
    expect((await call("POST", "/runs", { ...base, case_names: ["nope"] })).status).toBe(400);
    expect((await call("POST", "/runs", { ...base, trials: 21 })).status).toBe(400);
    expect((await call("POST", "/runs", { ...base, concurrency: 33 })).status).toBe(400);
    expect((await call("POST", "/runs", { benchmark_id: "evbm_nope", agent_id: "agent_1", environment_id: "env_1" })).status).toBe(404);

    const created = await call("POST", "/runs", { ...base, case_names: ["b"], trials: 3 });
    expect(created).toMatchObject({ status: 200, body: { task_count: 1 } });
    const run = (await call("GET", `/runs/${created.body.run_id}`)).body;
    expect(run).toMatchObject({ kind: "messages", benchmark_id: id, mode: "agent", concurrency: 4, agent_id: "agent_1", environment_id: "env_1", status: "pending" });
    expect(run.tasks).toHaveLength(1);
    expect(run.tasks[0]).toMatchObject({ id: "b", trial_total: 3, spec: { id: "b", messages: ["one", "two"], timeout_ms: 5000 } });
    expect(run.tasks[0].trials).toHaveLength(3);

    expect((await call("POST", `/benchmarks/${id}/cases`, { name: "z", messages: ["m"] })).status).toBe(409);
    expect((await call("PUT", `/benchmarks/${id}/cases/b`, { messages: ["edited"] })).status).toBe(409);
    expect((await call("DELETE", `/benchmarks/${id}/cases/a`)).status).toBe(409);
    expect((await call("DELETE", `/benchmarks/${id}`)).status).toBe(409);
    expect((await call("PATCH", `/benchmarks/${id}`, { name: "still allowed" })).status).toBe(200);

    expect((await call("GET", `/runs?benchmark_id=${id}`)).body.data.map((entry: any) => entry.id)).toEqual([created.body.run_id]);
    expect((await call("GET", "/runs?benchmark_id=evbm_other")).body.data).toEqual([]);

    expect((await call("POST", `/runs/${created.body.run_id}/cancel`, {})).status).toBe(200);
    expect((await call("PUT", `/benchmarks/${id}/cases/b`, { messages: ["edited"] })).status).toBe(200);
    // The run keeps its snapshot.
    expect((await call("GET", `/runs/${created.body.run_id}`)).body.tasks[0].spec.messages).toEqual(["one", "two"]);
    expect((await call("POST", "/runs", base)).body.task_count).toBe(2);
  });

  it("rejects a run from an empty messages benchmark and the removed kind:harbor form", async () => {
    const { body } = await call("POST", "/benchmarks", { kind: "messages", name: "empty" });
    expect(body.case_count).toBe(0);
    const res = await call("POST", "/runs", { benchmark_id: body.id, agent_id: "agent_1", environment_id: "env_1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no cases/);
    expect((await call("POST", "/runs", { kind: "harbor", dataset_id: "evds_x", mode: "oracle" })).status).toBe(400);
    expect((await call("POST", "/runs", { benchmark_id: body.id, kind: "messages", agent_id: "agent_1", environment_id: "env_1" })).status).toBe(400);
  });

  it("keeps the inline messages form", async () => {
    const res = await call("POST", "/runs", { agent_id: "agent_1", environment_id: "env_1", tasks: [{ id: "t1", messages: ["hi"], trials: 2 }] });
    expect(res).toMatchObject({ status: 200, body: { task_count: 1 } });
    const run = (await call("GET", `/runs/${res.body.run_id}`)).body;
    expect(run.benchmark_id).toBeUndefined();
    expect(run.concurrency).toBeUndefined();
  });
});

describe("harbor benchmarks and cases", () => {
  it("creates empty, adds from an upload, replaces one case, and runs", async () => {
    const created = await call("POST", "/benchmarks", { kind: "harbor", name: "tb" });
    expect(created).toMatchObject({ status: 201, body: { kind: "harbor", source: null, case_count: 0 } });
    const id = created.body.id;
    uploads.set("file_two", await taskArchive(["alpha", "beta"]));
    const added = await call("POST", `/benchmarks/${id}/cases`, { source: { type: "upload", file_id: "file_two" } });
    expect(added.status).toBe(201);
    expect(added.body.cases.map((entry: any) => [entry.name, entry.image_alias])).toEqual([["alpha", "alpha"], ["beta", "beta"]]);
    expect((await call("POST", `/benchmarks/${id}/cases`, { source: { type: "upload", file_id: "file_two" }, case_names: ["beta"] })).status).toBe(409);
    expect((await call("POST", `/benchmarks/${id}/cases`, { name: "m", messages: ["x"] })).status).toBe(400);

    const detail = await call("GET", `/benchmarks/${id}/cases/alpha`);
    expect(detail.body).toMatchObject({ kind: "harbor", instruction: "Solve alpha." });
    expect(detail.body.files.map((file: any) => file.path)).toEqual(["instruction.md", "task.toml", "tests/test.sh"]);

    expect((await call("PUT", `/benchmarks/${id}/cases/alpha`, { source: { type: "upload", file_id: "file_two" } })).status).toBe(400);
    uploads.set("file_one", await taskArchive(["gamma"], "Do"));
    const replaced = await call("PUT", `/benchmarks/${id}/cases/alpha`, { source: { type: "upload", file_id: "file_one" } });
    expect(replaced).toMatchObject({ status: 200, body: { name: "alpha", image: "img/gamma:1", instruction: "Do gamma." } });
    expect((await call("PUT", `/benchmarks/${id}/cases/alpha`, { source: { type: "registry", name: "x" } })).status).toBe(400);

    expect((await call("POST", "/runs", { benchmark_id: id, agent_id: "agent_1", environment_id: "env_1" })).status).toBe(400);
    expect((await call("POST", "/runs", { benchmark_id: id })).status).toBe(400);
    const run = await call("POST", "/runs", { benchmark_id: id, agent_id: "agent_1", concurrency: 2, trials: 2 });
    expect(run).toMatchObject({ status: 200, body: { task_count: 2 } });
    const stored = (await call("GET", `/runs/${run.body.run_id}`)).body;
    expect(stored).toMatchObject({ kind: "harbor", benchmark_id: id, mode: "agent", concurrency: 2, environment_id: null });
    expect(stored.tasks.map((task: any) => task.image_alias)).toEqual(["gamma", "beta"]);
    expect((await call("DELETE", `/benchmarks/${id}/cases/beta`)).status).toBe(409);

    await call("DELETE", `/runs/${run.body.run_id}`);
    expect((await call("DELETE", `/benchmarks/${id}/cases/beta`)).status).toBe(200);
    expect(await call("DELETE", `/benchmarks/${id}`)).toEqual({ status: 200, body: { type: "eval_benchmark_deleted", id } });
    expect((await call("GET", `/benchmarks/${id}`)).status).toBe(404);
  });

  it("imports a benchmark from an upload with case_names and the upload name", async () => {
    uploads.set("suite", await taskArchive(["alpha", "beta"]));
    const res = await call("POST", "/benchmarks", { source: { type: "upload", file_id: "suite" }, case_names: ["beta"] });
    expect(res).toMatchObject({ status: 201, body: { name: "suite", kind: "harbor", source: { type: "upload", file_id: "suite" }, case_count: 1 } });
    expect((await call("POST", "/benchmarks", { source: { type: "upload", file_id: "missing" } })).status).toBe(404);
    expect((await call("POST", "/runs", { benchmark_id: res.body.id, mode: "oracle" })).status).toBe(400); // no solution
  });
});
