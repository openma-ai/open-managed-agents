import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
  try {
  for (const name of names) {
    const dir = join(root, "set", name);
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "task.toml"), `[environment]\ndocker_image = "img/${name}:1"\n`);
    await writeFile(join(dir, "instruction.md"), `${instruction} ${name}.`);
    await writeFile(join(dir, "tests", "test.sh"), "#!/bin/bash\n");
  }
  const archive = join(root, "set.tar.gz");
  // macOS copyfile metadata must not become extra task files in the fixture.
  execFileSync("tar", ["-czf", archive, "-C", root, "set"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return new Uint8Array(await readFile(archive));
  } finally { await rm(root, { recursive: true, force: true }); }
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

  it("runs a messages benchmark: snapshot specs, concurrency; cases stay editable, delete is 409 while active", async () => {
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

    // The run copied its cases, so editing them does not need a lock.
    expect((await call("PUT", `/benchmarks/${id}/cases/b`, { messages: ["edited"] })).status).toBe(200);
    expect((await call("DELETE", `/benchmarks/${id}`)).status).toBe(409);
    expect((await call("PATCH", `/benchmarks/${id}`, { name: "still allowed" })).status).toBe(200);

    expect((await call("GET", `/runs?benchmark_id=${id}`)).body.data.map((entry: any) => entry.id)).toEqual([created.body.run_id]);
    expect((await call("GET", "/runs?benchmark_id=evbm_other")).body.data).toEqual([]);

    expect((await call("POST", `/runs/${created.body.run_id}/cancel`, {})).status).toBe(200);
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
  it("imports read-only revisions, syncs only on change, and binds runs to a revision", async () => {
    expect((await call("POST", "/benchmarks", { kind: "harbor", name: "tb" })).status).toBe(400); // no empty harbor benchmarks
    uploads.set("file_two", await taskArchive(["alpha", "beta"]));
    const created = await call("POST", "/benchmarks", { name: "tb", source: { type: "upload", file_id: "file_two" } });
    expect(created).toMatchObject({ status: 201, body: { kind: "harbor", revision: 1, cases_revision: 1, case_count: 2, source: { type: "upload", file_id: "file_two" } } });
    expect(created.body.revisions).toEqual([expect.objectContaining({ revision: 1, pins: [], case_count: 2, digest: expect.stringMatching(/^sha256:/) })]);
    const id = created.body.id;
    const v1 = created.body.cases.map((entry: any) => [entry.name, entry.image_alias, entry.digest]);
    expect(v1.map((entry: any[]) => entry.slice(0, 2))).toEqual([["alpha", "alpha"], ["beta", "beta"]]);

    // Harbor cases are edited at the source, never in OMA.
    expect((await call("POST", `/benchmarks/${id}/cases`, { name: "m", messages: ["x"] })).body.error).toMatch(/read-only/);
    expect((await call("PUT", `/benchmarks/${id}/cases/alpha`, { messages: ["x"] })).status).toBe(400);
    expect((await call("DELETE", `/benchmarks/${id}/cases/alpha`)).status).toBe(400);

    const detail = await call("GET", `/benchmarks/${id}/cases/alpha`);
    expect(detail.body).toMatchObject({ kind: "harbor", revision: 1, instruction: "Solve alpha.", digest: v1[0][2] });
    expect(detail.body.files.map((file: any) => file.path)).toEqual(["instruction.md", "task.toml", "tests/test.sh"]);

    const run = await call("POST", "/runs", { benchmark_id: id, agent_id: "agent_1", concurrency: 2, trials: 2 });
    expect(run).toMatchObject({ status: 200, body: { task_count: 2 } });

    expect((await call("POST", `/benchmarks/${id}/sync`, {})).status).toBe(400); // an upload needs a new file_id
    expect((await call("POST", `/benchmarks/${id}/sync`, { file_id: "file_two", ref: "main" })).status).toBe(400);
    uploads.set("same_again", await taskArchive(["beta", "alpha"]));
    expect(await call("POST", `/benchmarks/${id}/sync`, { file_id: "same_again" })).toMatchObject({ status: 200, body: { changed: false, benchmark: { revision: 1 } } });
    uploads.set("file_new", await taskArchive(["alpha", "beta"], "Do"));
    const synced = await call("POST", `/benchmarks/${id}/sync`, { file_id: "file_new" });
    expect(synced).toMatchObject({ status: 200, body: { changed: true, benchmark: { revision: 2, source: { file_id: "file_new" } } } });
    expect(synced.body.benchmark.revisions.map((entry: any) => entry.revision)).toEqual([2, 1]);
    expect((await call("GET", `/benchmarks/${id}/cases/alpha`)).body).toMatchObject({ revision: 2, instruction: "Do alpha." });
    expect((await call("GET", `/benchmarks/${id}/cases/alpha?revision=1`)).body).toMatchObject({ revision: 1, instruction: "Solve alpha." });
    expect((await call("GET", `/benchmarks/${id}?revision=1`)).body).toMatchObject({ revision: 2, cases_revision: 1 });
    expect((await call("GET", `/benchmarks/${id}?revision=0`)).status).toBe(400);

    // The run created before the sync still points at revision 1's content.
    const stored = (await call("GET", `/runs/${run.body.run_id}`)).body;
    expect(stored).toMatchObject({ kind: "harbor", benchmark_id: id, benchmark_revision: 1, mode: "agent", concurrency: 2, environment_id: null });
    expect(stored.tasks.map((task: any) => [task.id, task.image_alias, task.digest])).toEqual(v1);
    const later = await call("POST", "/runs", { benchmark_id: id, agent_id: "agent_1" });
    expect((await call("GET", `/runs/${later.body.run_id}`)).body.benchmark_revision).toBe(2);

    expect((await call("POST", "/runs", { benchmark_id: id, agent_id: "agent_1", environment_id: "env_1" })).status).toBe(400);
    expect((await call("POST", "/runs", { benchmark_id: id })).status).toBe(400);
    expect((await call("DELETE", `/benchmarks/${id}`)).status).toBe(409);
    await call("DELETE", `/runs/${run.body.run_id}`);
    await call("DELETE", `/runs/${later.body.run_id}`);
    expect(await call("DELETE", `/benchmarks/${id}`)).toEqual({ status: 200, body: { type: "eval_benchmark_deleted", id } });
    expect((await call("GET", `/benchmarks/${id}`)).status).toBe(404);
  });

  it("imports a benchmark from an upload with case_names and the upload name; sync keeps the filter", async () => {
    uploads.set("suite", await taskArchive(["alpha", "beta"]));
    const res = await call("POST", "/benchmarks", { source: { type: "upload", file_id: "suite" }, case_names: ["beta"] });
    expect(res).toMatchObject({ status: 201, body: { name: "suite", kind: "harbor", source: { type: "upload", file_id: "suite" }, case_count: 1 } });
    expect(res.body.revisions[0].case_names).toEqual(["beta"]);
    uploads.set("suite2", await taskArchive(["alpha", "beta"], "Again"));
    const synced = await call("POST", `/benchmarks/${res.body.id}/sync`, { file_id: "suite2" });
    expect(synced.body.benchmark.cases.map((entry: any) => entry.name)).toEqual(["beta"]);
    expect((await call("POST", "/benchmarks", { source: { type: "upload", file_id: "missing" } })).status).toBe(404);
    expect((await call("POST", "/runs", { benchmark_id: res.body.id, mode: "oracle" })).status).toBe(400); // no solution
    const messages = await messagesBenchmark();
    expect((await call("POST", `/benchmarks/${messages.id}/sync`, {})).status).toBe(400);
  });
});

describe("git refs", () => {
  it("lists a repository's branches and tags, and maps errors to statuses", async () => {
    const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
    const A = "a".repeat(40);
    const urls: string[] = [];
    const routes = buildEvalRoutes({
      evals: createInMemoryEvalRunService().service,
      runtimeFor: () => runtime,
      benchmarksFor: (t) => new EvalBenchmarkStore(new InMemoryKvStore(), t),
      readUpload: async () => null,
      fetch: (async (url: string) => {
        urls.push(url);
        if (url.includes("/missing")) return new Response("", { status: 404 });
        return new Response(pkt("# service=git-upload-pack\n") + "0000" + pkt(A + " HEAD\0symref=HEAD:refs/heads/main\n") + pkt(A + " refs/heads/main\n") + pkt(A + " refs/tags/v1\n") + "0000");
      }) as never,
    });
    const refsApp = new Hono();
    refsApp.use("*", async (c, next) => { c.set("tenant_id" as never, "t" as never); await next(); });
    refsApp.route("/", routes as never);
    const get = async (path: string) => { const res = await refsApp.request(path); return { status: res.status, body: await res.json() as any }; };

    expect(await get(`/git-refs?url=${encodeURIComponent("https://github.com/o/r.git")}`)).toEqual({
      status: 200,
      body: { url: "https://github.com/o/r", default_branch: "main", branches: [{ name: "main", commit: A }], tags: [{ name: "v1", commit: A }], truncated: false },
    });
    expect(urls).toEqual(["https://github.com/o/r.git/info/refs?service=git-upload-pack"]);
    expect((await get("/git-refs")).status).toBe(400);
    expect((await get(`/git-refs?url=${encodeURIComponent("https://gitlab.com/o/r")}`)).status).toBe(400);
    expect((await get(`/git-refs?url=${encodeURIComponent("https://github.com/o/missing")}`)).status).toBe(404);
  });
});
