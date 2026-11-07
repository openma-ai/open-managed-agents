import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHarborTask, type HarborTask } from "@open-managed-agents/harbor-tasks";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { advanceHarborRun } from "../src/harbor";
import { benchmarkToApi, collectHarborBundles, EvalBenchmarkStore } from "../src/benchmarks";
import type { EvalSessionRuntime } from "../src/runtime";
import type { EvalRunRecord } from "../src/types";

const enc = (s: string) => new TextEncoder().encode(s);

function harborTask(name: string, toml = ""): HarborTask {
  return parseHarborTask(name, [
    { path: "task.toml", bytes: enc(`[environment]\ndocker_image = "img/${name}:1"\n[agent]\ntimeout_sec = 60\n${toml}`), executable: false },
    { path: "instruction.md", bytes: enc(`do ${name}`), executable: false },
    { path: "tests/test.sh", bytes: enc("#!/bin/bash\n"), executable: true },
    { path: "solution/solve.sh", bytes: enc("#!/bin/bash\n"), executable: true },
  ]);
}

/** Fake Session sandboxes that understand the commands harbor-tasks sends. */
function fakeRuntime(options: { aliases?: Record<string, string>; sandboxReady?: () => boolean } = {}) {
  const calls: string[] = [];
  const settled = new Set<string>();
  const started = new Map<string, Set<string>>();
  const finished = new Map<string, Map<string, number>>();
  let sessions = 0;
  const marker = (out: string) => `${out}\n__OMA_HARBOR_EXIT__=0`;
  const runtime: EvalSessionRuntime = {
    agentExists: async () => true,
    environmentExists: async () => true,
    trajectoryConfigs: async () => ({ agent: {}, environment: {} }),
    oracleAgentId: async () => "agent_oracle",
    environmentForImage: async (alias) => `env_${alias}`,
    createSession: async ({ agentId }) => { calls.push(`create:${agentId}`); return `sess_${++sessions}`; },
    sendUserMessage: async (sessionId, text) => { calls.push(`message:${sessionId}:${text}`); return `msg_${sessionId}`; },
    interrupt: async (sessionId) => { calls.push(`interrupt:${sessionId}`); settled.add(sessionId); },
    settledAfter: async (sessionId) => settled.has(sessionId) ? { settled: true, stopReason: "end_turn" } : { settled: false },
    listEvents: async () => [],
    status: async () => "idle",
    ensureSandbox: async () => options.sandboxReady?.() ?? true,
    releaseSandbox: async (sessionId) => { calls.push(`release:${sessionId}`); },
    imageAlias: (image) => (options.aliases ?? { "img/a:1": "a", "img/b:1": "b" })[image] ?? null,
    exec: async (sessionId, command) => {
      if (command.includes("__OMA_PWD__")) return { exit_code: 0, output: marker("__OMA_PWD__/app__OMA_PWD__") };
      const launch = /\/oma\/eval\/(oracle|verifier)\.pid\)/u.exec(command);
      if (launch) {
        const set = started.get(sessionId) ?? new Set(); set.add(launch[1]!); started.set(sessionId, set);
        calls.push(`start:${sessionId}:${launch[1]}`);
        return { exit_code: 0, output: marker("") };
      }
      const poll = /cat \/oma\/eval\/(oracle|verifier)\.exit/u.exec(command);
      if (poll) return { exit_code: 0, output: marker(String(finished.get(sessionId)?.get(poll[1]!) ?? "")) };
      if (command.includes("__OMA_HARBOR_REWARD__")) {
        return { exit_code: 0, output: marker(`__OMA_HARBOR_REWARD__json:${btoa('{"reward":0.5,"extra":2}')}__OMA_HARBOR_REWARD_END__`) };
      }
      if (command.includes("tail -c 4000")) return { exit_code: 0, output: marker("3 passed") };
      return { exit_code: 0, output: marker("") };
    },
  };
  return {
    runtime, calls, settled,
    finish: (sessionId: string, step: string, code = 0) => {
      const map = finished.get(sessionId) ?? new Map(); map.set(step, code); finished.set(sessionId, map);
    },
    started: (sessionId: string, step: string) => started.get(sessionId)?.has(step) ?? false,
  };
}

function harborRun(tasks: string[], extra: Partial<EvalRunRecord> = {}, trials = 1): EvalRunRecord {
  return {
    id: "evrun-1", tenant_id: "t", kind: "harbor", agent_id: "agent_1", environment_id: null,
    benchmark_id: "evbm_1", mode: "agent", concurrency: 4, status: "running", created_at: new Date(0).toISOString(),
    task_count: tasks.length, completed_count: 0, failed_count: 0,
    tasks: tasks.map((id) => ({
      id, status: "pending", trial_total: trials,
      runtime: { workdir: "/app", env: { PATH: "/usr/bin" } },
      trials: Array.from({ length: trials }, (_, index) => ({ trial_index: index, status: "pending" as const })),
    })),
    ...extra,
  };
}

const benchmarks = (tasks: Record<string, HarborTask>) => ({ loadTask: async (_id: string, name: string) => tasks[name]! }) as unknown as EvalBenchmarkStore;

describe("advanceHarborRun", () => {
  it("runs an agent trial: message, settle, detached verifier, reward", async () => {
    const fake = fakeRuntime();
    const run = harborRun(["a"]);
    let now = 1_000_000;
    const deps = { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => now };

    await advanceHarborRun(run, deps);
    const trial = run.tasks[0]!.trials[0]!;
    expect(trial).toMatchObject({ status: "running", phase: "agent", session_id: "sess_1", message_event_id: "msg_sess_1" });
    expect(fake.calls).toContain("message:sess_1:do a");
    expect(run.environments).toEqual({ a: "env_a" });

    await advanceHarborRun(run, deps); // not settled yet
    expect(trial.phase).toBe("agent");

    fake.settled.add("sess_1");
    await advanceHarborRun(run, deps);
    expect(trial.phase).toBe("verifying");
    expect(fake.started("sess_1", "verifier")).toBe(true);

    fake.finish("sess_1", "verifier", 0);
    now += 5_000;
    await advanceHarborRun(run, deps);
    expect(trial).toMatchObject({ status: "completed", phase: "done", reward: 0.5, rewards: { reward: 0.5, extra: 2 }, test_exit_code: 0, verifier_output_tail: "3 passed" });
    expect(fake.calls).toContain("release:sess_1");
    expect(run.tasks[0]).toMatchObject({ status: "completed", mean_reward: 0.5, trial_pass_count: 0 });
  });

  it("starts at most `concurrency` trials, first trial of every task first", async () => {
    const fake = fakeRuntime();
    const run = harborRun(["a", "b"], { concurrency: 2 }, 2);
    await advanceHarborRun(run, { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a"), b: harborTask("b") }), now: () => 0 });
    const states = run.tasks.map((task) => task.trials.map((trial) => trial.status));
    expect(states).toEqual([["running", "pending"], ["running", "pending"]]);
  });

  it("interrupts the agent at the task timeout and still grades", async () => {
    const fake = fakeRuntime();
    const run = harborRun(["a"]);
    let now = 0;
    const deps = { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => now };
    await advanceHarborRun(run, deps);
    now = 61_000;
    await advanceHarborRun(run, deps);
    const trial = run.tasks[0]!.trials[0]!;
    expect(fake.calls).toContain("interrupt:sess_1");
    expect(trial.agent_timed_out).toBe(true);
    await advanceHarborRun(run, deps); // interrupt settled the turn
    expect(trial.phase).toBe("verifying");
  });

  it("fails a trial whose image has no SANDBOX_IMAGES alias", async () => {
    const fake = fakeRuntime({ aliases: {} });
    const run = harborRun(["a"]);
    await advanceHarborRun(run, { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => 0 });
    expect(run.tasks[0]!.trials[0]).toMatchObject({ status: "failed", error: expect.stringContaining("not in this deployment's SANDBOX_IMAGES") });
    expect(run.tasks[0]).toMatchObject({ status: "failed", mean_reward: 0 });
    expect(fake.calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  it("oracle mode waits for the sandbox, runs solve.sh detached, then verifies", async () => {
    let ready = false;
    const fake = fakeRuntime({ sandboxReady: () => ready });
    const run = harborRun(["a"], { mode: "oracle", agent_id: null });
    const deps = { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => 0 };
    await advanceHarborRun(run, deps);
    const trial = run.tasks[0]!.trials[0]!;
    expect(fake.calls).toContain("create:agent_oracle");
    expect(trial.phase).toBe("provisioning");
    await advanceHarborRun(run, deps);
    expect(trial.phase).toBe("provisioning");
    ready = true;
    await advanceHarborRun(run, deps);
    expect(trial.phase).toBe("agent");
    expect(fake.started("sess_1", "oracle")).toBe(true);
    fake.finish("sess_1", "oracle", 0);
    await advanceHarborRun(run, deps);
    expect(trial.phase).toBe("verifying");
    expect(fake.calls.some((call) => call.startsWith("message:"))).toBe(false);
  });

  it("counts an errored trial as 0 in the task mean (Harbor's mean metric)", async () => {
    const fake = fakeRuntime();
    const run = harborRun(["a"], {}, 2);
    const task = run.tasks[0]!;
    task.trials[0] = { trial_index: 0, status: "completed", phase: "done", reward: 1, session_id: "s0" };
    task.trials[1] = { trial_index: 1, status: "failed", phase: "done", error: "boom" };
    await advanceHarborRun(run, { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => 0 });
    expect(task).toMatchObject({ status: "completed", mean_reward: 0.5, trial_pass_count: 1 });
  });

  it("uses the deployment's known image WORKDIR/ENV instead of reading the registry", async () => {
    const fake = fakeRuntime();
    fake.runtime.imageRuntime = (alias) => alias === "a" ? { workdir: "/app", env: {} } : null;
    const run = harborRun(["a"]);
    delete run.tasks[0]!.runtime;
    const fetch = (() => { throw new Error("registry must not be read"); }) as never;
    await advanceHarborRun(run, { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => 0, fetch });
    expect(run.tasks[0]!.runtime).toEqual({ workdir: "/app", env: {} });
    expect(run.tasks[0]!.trials[0]).toMatchObject({ status: "running", phase: "agent" });
  });

  it("reads the image config from the registry when the deployment does not know it", async () => {
    const fake = fakeRuntime();
    const run = harborRun(["a"]);
    delete run.tasks[0]!.runtime;
    const urls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      if (url.endsWith("/manifests/1")) return json({ config: { digest: "sha256:cfg" } });
      if (url.endsWith("/blobs/sha256:cfg")) return json({ config: { WorkingDir: "/srv", Env: ["A=1"] } });
      return new Response("", { status: 404 });
    }) as typeof globalThis.fetch;
    await advanceHarborRun(run, { runtime: fake.runtime, benchmarks: benchmarks({ a: harborTask("a") }), now: () => 0, fetch });
    expect(run.tasks[0]!.runtime).toEqual({ workdir: "/srv", env: { A: "1" } });
    expect(urls.length).toBeGreaterThan(0);
  });
});

describe("harbor benchmarks", () => {
  it("imports an uploaded tar.gz, stores task files and resolves aliases at read time", async () => {
    const root = await mkdtemp(join(tmpdir(), "evals-dataset-"));
    for (const name of ["alpha", "beta"]) {
      const dir = join(root, "set", name);
      await mkdir(join(dir, "tests"), { recursive: true });
      await mkdir(join(dir, "environment"), { recursive: true });
      await writeFile(join(dir, "task.toml"), name === "beta"
        ? `[environment]\ndocker_image = "img/${name}:1"\ngpus = 1\n`
        : `[environment]\ndocker_image = "img/${name}:1"\n`);
      await writeFile(join(dir, "instruction.md"), `Solve ${name}.`);
      await writeFile(join(dir, "tests", "test.sh"), "#!/bin/bash\n");
      await chmod(join(dir, "tests", "test.sh"), 0o755);
      await writeFile(join(dir, "environment", "Dockerfile"), "FROM scratch\n");
    }
    const archive = join(root, "set.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", root, "set"]);
    const bytes = new Uint8Array(await readFile(archive));
    const collected = await collectHarborBundles(
      { type: "upload", file_id: "file_1" },
      undefined,
      { fetch: (() => { throw new Error("no network"); }) as never, readUpload: async () => ({ bytes, filename: "set.tar.gz" }) },
    );
    expect(collected).toMatchObject({ defaultName: "set", source: { type: "upload", file_id: "file_1" }, pins: [] });
    expect(collected.bundles.map((bundle) => bundle.name)).toEqual(["alpha", "beta"]);
    // The environment/ build context is not kept.
    expect(collected.bundles[0]!.files.map((file) => file.path).sort()).toEqual(["instruction.md", "task.toml", "tests/test.sh"]);

    const store = new EvalBenchmarkStore(new InMemoryKvStore(), "t");
    const stored = await store.createHarbor(collected.defaultName, collected);
    const api = benchmarkToApi(stored, (image) => (image === "img/alpha:1" ? "alpha" : null), true);
    expect(api).toMatchObject({ kind: "harbor", case_count: 2, runnable_count: 1 });
    expect(api.cases![1]).toMatchObject({ kind: "harbor", name: "beta", supported: false, image_alias: null, unsupported_reason: expect.stringContaining("GPU") });
    expect((await store.list()).map((benchmark) => benchmark.id)).toEqual([stored.id]);
    const alpha = stored.cases.find((entry) => entry.name === "alpha")!;
    const task = await store.loadTask(stored.id, "alpha", alpha.kind === "harbor" ? alpha.digest : undefined);
    expect(task.tests.find((file) => file.path === "test.sh")!.executable).toBe(true);
    expect(await store.delete(stored.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("rejects unknown builtin benchmarks and missing registry versions clearly", async () => {
    const deps = { fetch: (async () => new Response(JSON.stringify([
      { name: "x", version: "1.0", tasks: [] }, { name: "x", version: "2.0", tasks: [] },
    ]))) as never, readUpload: async () => null };
    await expect(collectHarborBundles({ type: "builtin", name: "nope" }, undefined, deps)).rejects.toThrow(/Unknown builtin benchmark nope/);
    await expect(collectHarborBundles({ type: "registry", name: "x" }, undefined, deps)).rejects.toThrow(/has versions 1.0, 2.0; pass version/);
    await expect(collectHarborBundles({ type: "git", url: "https://gitlab.com/o/r" }, undefined, deps)).rejects.toThrow(/github.com/);
    await expect(collectHarborBundles({ type: "git", url: "https://github.com/o/r", path: "a/../b" }, undefined, deps)).rejects.toThrow(/\.\./);
  });

  it("reads a registry dataset whose tasks live on GitHub and on the Hub, pinned per repository", async () => {
    const gh = "1".repeat(40);
    const hf = "2".repeat(40);
    const root = await mkdtemp(join(tmpdir(), "evals-registry-"));
    const dir = join(root, "repo-sha", "tasks", "gh-task");
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "task.toml"), `[environment]\ndocker_image = "img/a:1"\n`);
    await writeFile(join(dir, "instruction.md"), "from github");
    await writeFile(join(dir, "tests", "test.sh"), "#!/bin/bash\n");
    const tarball = join(root, "gh.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", root, "repo-sha"]);
    const tarBytes = new Uint8Array(await readFile(tarball));
    const registry = [{ name: "mix", version: "1.0", tasks: [
      { name: "gh-task", git_url: "https://github.com/o/r.git", git_commit_id: gh, path: "tasks/gh-task" },
      { name: "hf-task", git_url: "https://huggingface.co/datasets/org/set", git_commit_id: hf, path: "datasets/mix/hf-task" },
    ] }];
    const hubFiles: Record<string, string> = {
      "datasets/mix/hf-task/task.toml": `[environment]\ndocker_image = "img/b:1"\n`,
      "datasets/mix/hf-task/instruction.md": "from the hub",
      "datasets/mix/hf-task/tests/test.sh": "#!/bin/bash\n",
    };
    const fetchImpl = (async (url: string) => {
      if (url === "https://reg.example/registry.json") return new Response(JSON.stringify(registry));
      if (url === `https://codeload.github.com/o/r/tar.gz/${gh}`) return new Response(tarBytes);
      if (url.startsWith(`https://huggingface.co/api/datasets/org/set/tree/${hf}/`)) {
        return new Response(JSON.stringify([...Object.keys(hubFiles), "datasets/mix/hf-task/environment/big.bin"].map((path) => ({ type: "file", path }))));
      }
      const hub = `https://huggingface.co/datasets/org/set/resolve/${hf}/`;
      if (url.startsWith(hub)) return new Response(hubFiles[url.slice(hub.length)] ?? "", { status: hubFiles[url.slice(hub.length)] ? 200 : 404 });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const collected = await collectHarborBundles({ type: "registry", name: "mix", version: "1.0", registry_url: "https://reg.example/registry.json" }, undefined, { fetch: fetchImpl, readUpload: async () => null });
    expect(collected.defaultName).toBe("mix@1.0");
    expect(collected.pins).toEqual([{ url: "https://github.com/o/r", commit: gh }, { url: "https://huggingface.co/datasets/org/set", commit: hf }]);
    expect(collected.bundles.map((bundle) => [bundle.name, bundle.files.map((file) => file.path).sort()])).toEqual([
      ["gh-task", ["instruction.md", "task.toml", "tests/test.sh"]],
      ["hf-task", ["instruction.md", "task.toml", "tests/test.sh"]],
    ]);
    const hfInstruction = collected.bundles[1]!.files.find((file) => file.path === "instruction.md")!;
    expect(new TextDecoder().decode(hfInstruction.bytes)).toBe("from the hub");
  });
});
