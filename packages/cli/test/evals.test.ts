import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRun } from "@open-managed-agents/api-types";
import {
  createTarGz,
  EvalsUsageError,
  formatBenchmark,
  formatCase,
  formatRun,
  parseCreateArgs,
  parseImportArgs,
  parseRunArgs,
  parseRunsListArgs,
  runEvalsCommand,
  type EvalsIO,
} from "../src/evals";

const execFileAsync = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const temps: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "oma-evals-"));
  temps.push(d);
  return d;
}

function harborTask(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "solution"), { recursive: true });
  writeFileSync(join(dir, "task.toml"), "[environment]\ndocker_image = \"img\"\n");
  writeFileSync(join(dir, "instruction.md"), "Do it.\n");
  writeFileSync(join(dir, "tests", "test.sh"), "#!/bin/sh\necho 1 > /logs/verifier/reward.txt\n");
  chmodSync(join(dir, "tests", "test.sh"), 0o755);
  writeFileSync(join(dir, "solution", "solve.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "solution", "solve.sh"), 0o750);
  return dir;
}

function mockIO(responder: (path: string, init?: RequestInit) => unknown, json = false) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const uploads: Array<{ filename: string; bytes: Uint8Array; type: string }> = [];
  const io: EvalsIO = {
    async request<T>(path: string, init?: RequestInit) {
      calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return responder(path, init) as T;
    },
    async upload(filename, bytes, type) { uploads.push({ filename, bytes, type }); return { id: "file_up" }; },
    print: (t) => out.push(t),
    error: (t) => err.push(t),
    sleep: async () => {},
    json,
  };
  return { io, out, err, calls, uploads };
}

const baseRun = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: "evr_1", kind: "harbor", agent_id: "agent_1", environment_id: null, benchmark_id: "evb_1", mode: "agent",
  status: "completed", created_at: "2026-11-01T00:00:00Z", task_count: 2, completed_count: 2, failed_count: 0,
  score: 0.5,
  tasks: [
    { id: "hello", status: "completed", trial_total: 2, trial_pass_count: 2, mean_reward: 1,
      trials: [{ trial_index: 0, status: "completed", session_id: "sess_a", reward: 1 }, { trial_index: 1, status: "completed", session_id: "sess_b", reward: 1 }] },
    { id: "broken", status: "failed", trial_total: 1, trial_pass_count: 0, mean_reward: 0, error: "verifier crashed",
      trials: [{ trial_index: 0, status: "failed", session_id: "sess_c", error: "test.sh exit 2" }] },
  ],
  ...over,
});

describe("evals argument parsing", () => {
  it("builds benchmark run requests and validates flags", () => {
    expect(parseRunArgs(["--benchmark", "evb_1", "--agent", "a", "--case", "t1", "--case=t2", "--trials", "3", "--concurrency=8", "--wait"])).toEqual({
      request: { benchmark_id: "evb_1", agent_id: "a", case_names: ["t1", "t2"], trials: 3, concurrency: 8 },
      wait: true,
    });
    expect(parseRunArgs(["--benchmark", "evb_1", "--mode", "oracle"]).request).toEqual({ benchmark_id: "evb_1", mode: "oracle" });
    expect(parseRunArgs(["--benchmark", "evb_m", "--agent", "a", "--environment", "env_1", "--mode", "agent"]).request)
      .toEqual({ benchmark_id: "evb_m", mode: "agent", agent_id: "a", environment_id: "env_1" });
    expect(parseRunArgs(["--file", "tasks.json", "--agent", "a", "--environment", "e"])).toEqual({ file: "tasks.json", agent: "a", environment: "e", wait: false });
    const bad: Array<[string[], RegExp]> = [
      [["--agent", "a"], /--benchmark <id> \(or --file tasks.json\) is required/],
      [["--benchmark", "d"], /--agent <id> is required/],
      [["--benchmark", "d", "--mode", "oracle", "--agent", "a"], /cannot be used with --mode oracle/],
      [["--benchmark", "d", "--mode", "oracle", "--environment", "e"], /--environment cannot be used with --mode oracle/],
      [["--benchmark", "d", "--mode", "judge"], /--mode must be/],
      [["--benchmark", "d", "--agent", "a", "--trials", "21"], /--trials must be an integer between 1 and 20/],
      [["--benchmark", "d", "--agent", "a", "--concurrency", "0"], /--concurrency/],
      [["--benchmark", "d", "--agent", "a", "--trials", "1.5"], /--trials/],
      [["--benchmark", "d", "--agent", "a", "--bogus"], /Unknown option: --bogus/],
      [["--benchmark", "d", "--agent"], /--agent requires a value/],
      [["--benchmark", "d", "--agent", "a", "extra"], /Unexpected argument: extra/],
      [["--benchmark", "d", "--benchmark", "e", "--agent", "a"], /more than once/],
      [["--benchmark", "d", "--file", "t.json", "--agent", "a"], /not both/],
      [["--file", "t.json", "--agent", "a"], /need --agent <id> and --environment <id>/],
      [["--file", "t.json", "--agent", "a", "--environment", "e", "--case", "x"], /--case cannot be used with --file/],
      [["--dataset", "d"], /Unknown option: --dataset/],
    ];
    for (const [args, re] of bad) expect(() => parseRunArgs(args), args.join(" ")).toThrow(re);
  });

  it("builds benchmark import and create requests", () => {
    expect(parseImportArgs(["--builtin", "hello-world", "--case", "a", "--name", "hw"])).toEqual({ name: "hw", source: { type: "builtin", name: "hello-world" }, case_names: ["a"] });
    expect(parseImportArgs(["--registry", "terminal-bench@2.0", "--registry-url", "https://reg.example/registry.json"])).toEqual({
      source: { type: "registry", name: "terminal-bench", version: "2.0", registry_url: "https://reg.example/registry.json" },
    });
    expect(parseImportArgs(["--registry", "swebench"])).toEqual({ source: { type: "registry", name: "swebench" } });
    expect(() => parseImportArgs([])).toThrow(/exactly one of/);
    expect(() => parseImportArgs(["--builtin", "a", "--registry", "b"])).toThrow(/only one of/);
    expect(() => parseImportArgs(["--builtin", "a", "--registry-url", "https://x"])).toThrow(/only valid with --registry/);
    expect(() => parseImportArgs(["--registry", "a@"])).toThrow(/Invalid --registry/);
    expect(() => parseImportArgs(["--registry", "a", "--registry-url", "not a url"])).toThrow(/Invalid --registry-url/);
    expect(parseCreateArgs(["--name", "smoke", "--kind", "messages"])).toEqual({ kind: "messages", name: "smoke" });
    expect(parseCreateArgs(["--kind=harbor", "--name=tb"])).toEqual({ kind: "harbor", name: "tb" });
    expect(() => parseCreateArgs(["--kind", "messages"])).toThrow(/--name <n> is required/);
    expect(() => parseCreateArgs(["--name", "x"])).toThrow(/--kind messages\|harbor is required/);
    expect(() => parseCreateArgs(["--name", "x", "--kind", "csv"])).toThrow(/--kind must be/);
  });

  it("builds runs list queries", () => {
    expect(parseRunsListArgs([])).toBe("/v1/oma/evals/runs");
    expect(parseRunsListArgs(["--status", "running", "--benchmark", "evb_1", "--agent", "a", "--limit", "5"]))
      .toBe("/v1/oma/evals/runs?status=running&agent_id=a&benchmark_id=evb_1&limit=5");
    expect(() => parseRunsListArgs(["--status", "done"])).toThrow(EvalsUsageError);
  });
});

describe("evals output", () => {
  it("prints a per-task table with passes, mean reward, sessions, errors and score", () => {
    const text = formatRun(baseRun());
    expect(text).toMatch(/CASE\s+STATUS\s+PASSED\s+MEAN REWARD\s+SESSIONS/);
    expect(text).toContain("Benchmark: evb_1");
    expect(formatRun(baseRun(), { id: "evb_1", name: "tb-sample" })).toContain("Benchmark: tb-sample (evb_1)");
    expect(text).toMatch(/hello\s+completed\s+2\/2\s+1\.000\s+sess_a,sess_b/);
    expect(text).toMatch(/broken\s+failed\s+0\/1\s+0\.000\s+sess_c/);
    expect(text).toContain("broken: verifier crashed");
    expect(text).toContain("broken#0: test.sh exit 2");
    expect(text).toContain("Score:     0.500");
  });

  it("shows running phases and placeholders for ungraded tasks", () => {
    const text = formatRun(baseRun({ status: "running", score: undefined, tasks: [
      { id: "t", status: "running", trial_total: 2, trials: [{ trial_index: 0, status: "running", phase: "verifying" }, { trial_index: 1, status: "pending" }] },
    ] }));
    expect(text).toMatch(/t\s+running \(verifying\)\s+—\/2\s+—\s+—/);
    expect(text).toContain("Score:     —");
  });

  it("formats harbor and messages benchmarks and cases", () => {
    const harbor = formatBenchmark({ id: "evb_1", name: "tb", kind: "harbor", source: { type: "registry", name: "tb", version: "2.0" }, case_count: 2, runnable_count: 1,
      created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", cases: [
        { kind: "harbor", name: "ok", image: "img:1", image_alias: "py", supported: true, agent_timeout_sec: 600, verifier_timeout_sec: 60, cpus: null, memory_mb: null, has_solution: true, instruction_preview: "", updated_at: "x" },
        { kind: "harbor", name: "gpu", image: "img:2", image_alias: null, supported: false, unsupported_reason: "gpus", agent_timeout_sec: null, verifier_timeout_sec: 60, cpus: null, memory_mb: null, has_solution: false, instruction_preview: "", updated_at: "x" },
      ] });
    expect(harbor).toContain("Kind:     harbor");
    expect(harbor).toContain("Source:   registry:tb@2.0");
    expect(harbor).toMatch(/ok\s+yes\s+py\s+yes\s+600s/);
    expect(harbor).toMatch(/gpu\s+no\s+—\s+no\s+—\s+unsupported: gpus/);
    const messages = formatBenchmark({ id: "evb_m", name: "smoke", kind: "messages", source: null, case_count: 1, runnable_count: 1, created_at: "x", updated_at: "x",
      cases: [{ kind: "messages", name: "greets", messages: ["Say hi", "Again"], reward: { type: "verifiable" }, updated_at: "x" }] });
    expect(messages).toContain("Source:   —");
    expect(messages).toMatch(/greets\s+2\s+verifiable\s+—\s+Say hi/);
    const hc = formatCase({ kind: "harbor", name: "ok", image: "img:1", image_alias: "py", supported: true, agent_timeout_sec: 600, verifier_timeout_sec: 60, cpus: null,
      memory_mb: null, has_solution: true, instruction_preview: "Do", instruction: "Do it all.", updated_at: "x", files: [{ path: "tests/test.sh", size: 10, executable: true }] });
    expect(hc).toMatch(/tests\/test\.sh\s+10\s+yes/);
    expect(hc).toContain("Do it all.");
    const mc = formatCase({ kind: "messages", name: "greets", messages: ["Say hi"], setup_script: "touch a", reward: { type: "verifiable" }, updated_at: "x" });
    expect(mc).toContain("  1. Say hi");
    expect(mc).toContain('Reward:   {"type":"verifiable"}');
  });
});

describe("evals tar packing", () => {
  it("packs a task directory under its basename and preserves executable bits", async () => {
    const root = tmp();
    const task = harborTask(root, "hello");
    const deep = join(task, "environment", "a".repeat(60), "b".repeat(60));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "long-name.txt"), "long path");
    const { bytes, taskCount } = await createTarGz(task);
    expect(taskCount).toBe(1);
    const archive = join(tmp(), "out.tar.gz");
    writeFileSync(archive, bytes);
    const dest = tmp();
    execFileSync("tar", ["-xzf", archive, "-C", dest]);
    expect(readFileSync(join(dest, "hello", "task.toml"), "utf8")).toContain("docker_image");
    expect(statSync(join(dest, "hello", "tests", "test.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, "hello", "solution", "solve.sh")).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(dest, "hello", "environment", "a".repeat(60), "b".repeat(60), "long-name.txt"), "utf8")).toBe("long path");
  });

  it("packs a directory of tasks and rejects directories without task.toml", async () => {
    const root = tmp();
    harborTask(root, "one");
    harborTask(root, "two");
    expect((await createTarGz(root)).taskCount).toBe(2);
    const empty = tmp();
    writeFileSync(join(empty, "README.md"), "x");
    await expect(createTarGz(empty)).rejects.toThrow(/No task.toml found/);
  });
});

describe("evals commands", () => {
  it("--wait polls, prints progress and exits 0 only when the run completes", async () => {
    const statuses: EvalRun["status"][] = ["pending", "running", "completed"];
    let poll = 0;
    const { io, out, calls } = mockIO((path, init) => {
      if (init?.method === "POST") return { run_id: "evr_1", task_count: 2 };
      const status = statuses[Math.min(poll++, 2)];
      return baseRun({ status, failed_count: 0, tasks: status === "completed" ? baseRun().tasks.slice(0, 1) : [] });
    });
    const code = await runEvalsCommand(io, ["evals", "run", "--benchmark", "evb_1", "--agent", "agent_1", "--wait"]);
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/oma/evals/runs", "GET /v1/oma/evals/runs/evr_1", "GET /v1/oma/evals/runs/evr_1", "GET /v1/oma/evals/runs/evr_1",
    ]);
    expect(calls[0].body).toEqual({ benchmark_id: "evb_1", agent_id: "agent_1" });
    const text = out.join("\n");
    expect(text).toMatch(/pending — /);
    expect(text).toMatch(/completed — /);
    expect(text).toMatch(/hello {2}completed {2}passed 2\/2 {2}reward 1\.000/);
  });

  it("--wait exits non-zero when the run fails or is cancelled", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const { io, err } = mockIO((_p, init) => init?.method === "POST" ? { run_id: "evr_1", task_count: 1 } : baseRun({ status, error: "boom" }));
      expect(await runEvalsCommand(io, ["evals", "run", "--benchmark", "d", "--mode", "oracle", "--wait"])).toBe(1);
      expect(err.join("\n")).toContain(`Eval run evr_1 ${status}: boom`);
    }
  });

  it("reports usage errors without calling the API", async () => {
    const { io, err, calls } = mockIO(() => ({}));
    expect(await runEvalsCommand(io, ["evals", "runs", "list", "--status", "nope"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "benchmarks", "upload", "/definitely/missing/path"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "benchmarks", "frobnicate"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "run", "--benchmark", "b", "--mode", "oracle", "--agent", "a"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "cases", "show", "evb_1"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "cases", "add", "evb_1"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "cases", "add", "evb_1", "--file", "c.json", "--builtin", "x"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "cases", "replace", "evb_1", "c"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "benchmarks", "rename", "evb_1"])).toBe(1);
    expect(await runEvalsCommand(io, ["evals", "datasets", "list"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toMatch(/--status must be one of/);
    expect(err.join("\n")).toMatch(/No such file or directory/);
    expect(err.join("\n")).toMatch(/Unknown command: oma evals benchmarks frobnicate/);
    expect(err.join("\n")).toMatch(/--agent cannot be used with --mode oracle/);
    expect(err.join("\n")).toMatch(/Missing <case>\. Usage: oma evals cases show/);
    expect(err.join("\n")).toMatch(/Pass exactly one of --file, --from, --builtin or --registry/);
    expect(err.join("\n")).toMatch(/Pass exactly one of --file or --from/);
    expect(err.join("\n")).toMatch(/Missing <name>\. Usage: oma evals benchmarks rename/);
  });

  it("uploads an existing archive as-is and rejects other files", async () => {
    const dir = tmp();
    const archive = join(dir, "set.tgz");
    writeFileSync(archive, new Uint8Array([31, 139, 8]));
    writeFileSync(join(dir, "set.zip"), "zip");
    const { io, out, err, uploads, calls } = mockIO(() => ({ id: "evb_9", name: "set.tgz", kind: "harbor", source: { type: "upload", file_id: "file_up" }, case_count: 2, runnable_count: 1, created_at: "x", updated_at: "x",
      cases: [{ kind: "harbor", name: "x", image: "img:1", image_alias: null, supported: true }] }));
    expect(await runEvalsCommand(io, ["evals", "benchmarks", "upload", archive, "--name", "mine"])).toBe(0);
    expect(uploads).toEqual([{ filename: "set.tgz", bytes: new Uint8Array([31, 139, 8]), type: "application/gzip" }]);
    expect(calls).toEqual([{ path: "/v1/oma/evals/benchmarks", method: "POST", body: { name: "mine", source: { type: "upload", file_id: "file_up" } } }]);
    expect(out.join("\n")).toContain("Benchmark uploaded: set.tgz (evb_9) — 2 cases, 1 runnable");
    expect(err.join("\n")).toContain("x: no image alias for img:1");
    expect(await runEvalsCommand(io, ["evals", "benchmarks", "upload", join(dir, "set.zip")])).toBe(1);
    expect(err.join("\n")).toMatch(/Unsupported path/);
  });

  const benchBody = { id: "evb_1", name: "b", kind: "messages", source: null, case_count: 1, runnable_count: 1, created_at: "x", updated_at: "x", cases: [] };

  it("benchmark list, builtin, show, create, import, rename and delete hit the right endpoints", async () => {
    const { io, out, calls } = mockIO((path, init) => {
      if (path === "/v1/oma/evals/benchmarks" && !init?.method) return { data: [benchBody] };
      if (path.endsWith("/builtin")) return { data: [{ name: "hello", description: "Hello tasks", case_count: 2 }] };
      if (init?.method === "DELETE") return { type: "eval_benchmark_deleted", id: "evb_1" };
      if (init?.method === "PATCH") return { ...benchBody, name: "renamed" };
      return benchBody;
    });
    const cmds = [
      ["benchmarks", "list"], ["benchmarks", "builtin"], ["benchmarks", "show", "evb/1"],
      ["benchmarks", "create", "--name", "b", "--kind", "messages"],
      ["benchmarks", "import", "--builtin", "hello", "--case", "a"],
      ["benchmarks", "rename", "evb_1", "renamed"], ["benchmarks", "delete", "evb_1"],
    ];
    for (const c of cmds) expect(await runEvalsCommand(io, ["evals", ...c]), c.join(" ")).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/oma/evals/benchmarks", "GET /v1/oma/evals/benchmarks/builtin", "GET /v1/oma/evals/benchmarks/evb%2F1",
      "POST /v1/oma/evals/benchmarks", "POST /v1/oma/evals/benchmarks", "PATCH /v1/oma/evals/benchmarks/evb_1", "DELETE /v1/oma/evals/benchmarks/evb_1",
    ]);
    expect(calls[3].body).toEqual({ kind: "messages", name: "b" });
    expect(calls[4].body).toEqual({ source: { type: "builtin", name: "hello" }, case_names: ["a"] });
    expect(calls[5].body).toEqual({ name: "renamed" });
    const text = out.join("\n");
    expect(text).toMatch(/NAME\s+ID\s+KIND\s+SOURCE\s+CASES\s+RUNNABLE/);
    expect(text).toMatch(/hello\s+2\s+Hello tasks/);
    expect(text).toContain("Benchmark created: b (evb_1) — messages");
    expect(text).toContain("oma evals cases add evb_1 --file case.json");
    expect(text).toContain("Benchmark renamed: renamed (evb_1)");
    expect(text).toContain("Benchmark deleted: evb_1");
  });

  it("cases show, add, replace and delete send the contract bodies", async () => {
    const dir = tmp();
    const caseFile = join(dir, "case.json");
    writeFileSync(caseFile, JSON.stringify({ name: "greets", messages: ["hi"], reward: { type: "verifiable" } }));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ name: "x", messages: "hi" }));
    writeFileSync(join(dir, "broken.json"), "{");
    const tasks = tmp();
    harborTask(tasks, "one");
    harborTask(tasks, "two");
    const { io, out, err, calls, uploads } = mockIO((_path, init) => {
      if (init?.method === "DELETE") return { type: "eval_case_deleted", benchmark_id: "evb_1", name: "greets" };
      if (init?.method === "POST") return benchBody;
      return { kind: "messages", name: "greets", messages: ["hi"], updated_at: "x" };
    });
    const run = (...a: string[]) => runEvalsCommand(io, ["evals", "cases", ...a]);
    expect(await run("show", "evb_1", "greets")).toBe(0);
    expect(await run("add", "evb_1", "--file", caseFile)).toBe(0);
    expect(await run("add", "evb_1", "--registry", "tb@2.0", "--case", "a", "--case", "b")).toBe(0);
    expect(await run("add", "evb_1", "--from", tasks)).toBe(0);
    expect(await run("replace", "evb_1", "greets", "--file", caseFile)).toBe(0);
    expect(await run("replace", "evb_1", "one", "--from", join(tasks, "one"))).toBe(0);
    expect(await run("delete", "evb_1", "greets")).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/oma/evals/benchmarks/evb_1/cases/greets",
      "POST /v1/oma/evals/benchmarks/evb_1/cases",
      "POST /v1/oma/evals/benchmarks/evb_1/cases",
      "POST /v1/oma/evals/benchmarks/evb_1/cases",
      "PUT /v1/oma/evals/benchmarks/evb_1/cases/greets",
      "PUT /v1/oma/evals/benchmarks/evb_1/cases/one",
      "DELETE /v1/oma/evals/benchmarks/evb_1/cases/greets",
    ]);
    expect(calls[1].body).toEqual({ name: "greets", messages: ["hi"], reward: { type: "verifiable" } });
    expect(calls[2].body).toEqual({ source: { type: "registry", name: "tb", version: "2.0" }, case_names: ["a", "b"] });
    expect(calls[3].body).toEqual({ source: { type: "upload", file_id: "file_up" } });
    expect(calls[5].body).toEqual({ source: { type: "upload", file_id: "file_up" } });
    expect(uploads.map((u) => u.filename)).toEqual([`${tasks.split("/").pop()}.tar.gz`, "one.tar.gz"]);
    const text = out.join("\n");
    expect(text).toContain("  1. hi");
    expect(text).toContain("Benchmark updated: b (evb_1) — 1 cases, 1 runnable");
    expect(text).toContain("Case replaced: greets in evb_1");
    expect(text).toContain("Case deleted: greets from evb_1");

    const before = calls.length;
    expect(await run("replace", "evb_1", "one", "--from", tasks)).toBe(1);
    expect(await run("add", "evb_1", "--file", join(dir, "bad.json"))).toBe(1);
    expect(await run("add", "evb_1", "--file", join(dir, "broken.json"))).toBe(1);
    expect(await run("add", "evb_1", "--file", caseFile, "--case", "x")).toBe(1);
    expect(calls).toHaveLength(before);
    const errors = err.join("\n");
    expect(errors).toMatch(/has 2 task.toml files; replacing a case needs exactly one/);
    expect(errors).toMatch(/"messages" must be an array of strings/);
    expect(errors).toMatch(/Invalid JSON in/);
    expect(errors).toMatch(/--case only applies to harbor sources/);
  });

  it("runs inline tasks from --file and shows runs with the benchmark name", async () => {
    const dir = tmp();
    const file = join(dir, "tasks.json");
    writeFileSync(file, JSON.stringify({ tasks: [{ id: "t1", messages: ["hi"] }] }));
    writeFileSync(join(dir, "empty.json"), "[]");
    const { io, out, err, calls } = mockIO((path, init) => {
      if (init?.method === "POST") return { run_id: "evr_1", task_count: 1 };
      if (path.startsWith("/v1/oma/evals/benchmarks/")) return { ...benchBody, name: "tb-sample" };
      if (path.startsWith("/v1/oma/evals/runs?")) return { data: [baseRun()] };
      return baseRun();
    });
    expect(await runEvalsCommand(io, ["evals", "run", "--file", file, "--agent", "a", "--environment", "e"])).toBe(0);
    expect(calls[0].body).toEqual({ agent_id: "a", environment_id: "e", tasks: [{ id: "t1", messages: ["hi"] }] });
    expect(await runEvalsCommand(io, ["evals", "runs", "show", "evr_1"])).toBe(0);
    expect(await runEvalsCommand(io, ["evals", "runs", "list", "--benchmark", "evb_1"])).toBe(0);
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/oma/evals/runs/evr_1", "GET /v1/oma/evals/benchmarks/evb_1", "GET /v1/oma/evals/runs?benchmark_id=evb_1",
    ]);
    const text = out.join("\n");
    expect(text).toContain("Eval run created: evr_1 (1 cases)");
    expect(text).toContain("Benchmark: tb-sample (evb_1)");
    expect(text).toMatch(/ID\s+STATUS\s+KIND\s+BENCHMARK/);
    expect(text).toMatch(/evr_1\s+completed\s+harbor\/agent\s+evb_1/);
    expect(await runEvalsCommand(io, ["evals", "run", "--file", join(dir, "empty.json"), "--agent", "a", "--environment", "e"])).toBe(1);
    expect(err.join("\n")).toMatch(/non-empty JSON array of tasks/);
  });

  it("runs show still prints when the benchmark lookup fails", async () => {
    const { io, out } = mockIO((path) => {
      if (path.startsWith("/v1/oma/evals/benchmarks/")) throw new Error("404 not found");
      return baseRun();
    });
    expect(await runEvalsCommand(io, ["evals", "runs", "show", "evr_1"])).toBe(0);
    expect(out.join("\n")).toContain("Benchmark: evb_1");
  });
});

describe("evals CLI end to end", () => {
  it("lists the eval endpoints in the API reference", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", entry, "api", "evals"], { env: { ...process.env, OMA_API_KEY: "k" } });
    expect(stdout).toContain("GET    /v1/oma/evals/benchmarks/builtin");
    expect(stdout).toContain("PUT    /v1/oma/evals/benchmarks/:id/cases/:name");
    expect(stdout).not.toContain("datasets");
    expect(stdout).toContain("POST   /v1/oma/evals/runs/:id/cancel");
    expect(stdout).not.toContain("Get eval run results");
  });

  it("packs a directory, uploads it as multipart and imports it", async () => {
    const root = tmp();
    harborTask(root, "hello");
    const seen: Array<{ method: string; url: string; type: string; beta?: string; body: Buffer }> = [];
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(c as Buffer);
      seen.push({ method: req.method!, url: req.url!, type: String(req.headers["content-type"]), beta: req.headers["anthropic-beta"] as string, body: Buffer.concat(parts) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/files"
        ? { id: "file_1", type: "file" }
        : { id: "evb_1", name: "hello", kind: "harbor", source: { type: "upload", file_id: "file_1" }, case_count: 1, runnable_count: 1, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", entry, "evals", "benchmarks", "upload", join(root, "hello")], {
      env: { ...process.env, OMA_BASE_URL: `http://127.0.0.1:${addr.port}`, OMA_API_KEY: "k" },
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /v1/files", "POST /v1/oma/evals/benchmarks"]);
    expect(seen[0].type).toMatch(/^multipart\/form-data/);
    // The real Files API rejects uploads without its own beta flag.
    expect(seen[0].beta).toBe("managed-agents-2026-04-01,files-api-2025-04-14");
    expect(seen[0].body.toString("latin1")).toContain('filename="hello.tar.gz"');
    expect(JSON.parse(seen[1].body.toString())).toEqual({ source: { type: "upload", file_id: "file_1" } });
    expect(stdout).toContain("Benchmark uploaded: hello (evb_1) — 1 cases, 1 runnable");
  });
});
