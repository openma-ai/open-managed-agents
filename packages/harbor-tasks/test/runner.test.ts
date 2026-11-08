import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRewards,
  requireAgentWorkdir,
  runInTask,
  runOracle,
  shellQuote,
  uploadFiles,
  pollDetached,
  startHarborVerifier,
  startHarborOracle,
  killDetached,
  verifyHarborTask,
  type HarborTrialSandbox,
} from "../src/runner";
import { UnsupportedHarborTaskError, type HarborTask } from "../src/task";

/** Unwraps runInTask's bash -c script so tests can assert on the inner command. */
function inner(command: string): string {
  const match = /^bash -c '([\s\S]*)'$/.exec(command);
  if (!match) throw new Error(`unexpected command ${command}`);
  return match[1]!.replace(/'\\''/g, "'");
}

class FakeSandbox implements HarborTrialSandbox {
  commands: string[] = [];
  files = new Map<string, string>();
  constructor(private readonly respond: (script: string) => { output?: string; exit?: number }) {}
  async exec(command: string, _timeout?: number): Promise<string> {
    const script = inner(command);
    this.commands.push(script);
    const { output = "", exit = 0 } = this.respond(script);
    // Mimic adapters that drop newlines between output chunks.
    return `${output}__OMA_HARBOR_EXIT__=${exit}`;
  }
  async writeFile(path: string, content: string) { this.files.set(path, content); }
  async writeFileBytes(path: string, bytes: Uint8Array) { this.files.set(path, Buffer.from(bytes).toString("utf8")); }
}

function rewardToken(kind: string, content: string) {
  return `__OMA_HARBOR_REWARD__${kind}:${Buffer.from(content).toString("base64")}__OMA_HARBOR_REWARD_END__`;
}

async function fixture(): Promise<HarborTask> {
  const file = (path: string, body: string, executable = false) => ({ path, bytes: new TextEncoder().encode(body), executable });
  return {
    name: "demo", instruction: "x", image: "img:1",
    agentTimeoutSec: 900, verifierTimeoutSec: 600, cpus: 1, memoryMb: 2048,
    verifierEnv: { GRADER: "it's on" }, solutionEnv: {},
    tests: [file("test.sh", "#!/bin/bash\n", true), file("test_outputs.py", "def test(): pass\n")],
    solution: [file("solve.sh", "#!/bin/bash\n")],
  };
}

const runtime = { workdir: "/app/site", env: { PATH: "/usr/local/bin:/usr/bin" } };

describe("runInTask", () => {
  it("runs in the task workdir with quoted environment and reads the exit marker", async () => {
    const sandbox = new FakeSandbox(() => ({ output: "line1line2", exit: 3 }));
    const result = await runInTask(sandbox, "make", { workdir: "/app/it's", env: { A: "x y" } });
    expect(result).toEqual({ exitCode: 3, output: "line1line2" });
    expect(sandbox.commands[0]).toBe(`export A='x y'; cd '/app/it'\\''s' && ( make ); echo; echo __OMA_HARBOR_EXIT__=$?`);
  });

  it("rejects invalid environment names", async () => {
    await expect(runInTask(new FakeSandbox(() => ({})), "true", { workdir: null, env: { "A;rm": "x" } }))
      .rejects.toThrow(/Invalid environment variable/);
  });

  it("fails when no exit status is reported", async () => {
    const sandbox: HarborTrialSandbox = { exec: async () => "nothing", writeFile: async () => undefined };
    await expect(runInTask(sandbox, "true", { workdir: null })).rejects.toThrow(/exit status/);
  });
});

describe("shellQuote", () => {
  it("escapes single quotes", () => expect(shellQuote("a'b")).toBe("'a'\\''b'"));
});

describe("uploadFiles", () => {
  it("copies files and restores executable bits", async () => {
    const task = await fixture();
    const sandbox = new FakeSandbox(() => ({}));
    await uploadFiles(sandbox, task.tests, "/tests");
    expect([...sandbox.files.keys()].sort()).toEqual(["/tests/test.sh", "/tests/test_outputs.py"]);
    expect(sandbox.commands).toContain("( chmod +x '/tests/test.sh' ); echo; echo __OMA_HARBOR_EXIT__=$?");
  });
});

describe("runOracle", () => {
  it("uploads solution/ and runs solve.sh in the workdir with the agent timeout", async () => {
    const task = await fixture();
    const timeouts: Array<number | undefined> = [];
    const sandbox = new FakeSandbox(() => ({}));
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command: string, timeout?: number) => { timeouts.push(timeout); return exec(command); };
    const result = await runOracle(task, sandbox, runtime);
    expect(result.exitCode).toBe(0);
    expect(sandbox.files.has("/solution/solve.sh")).toBe(true);
    expect(sandbox.commands.at(-1)).toContain("cd '/app/site' && ( /solution/solve.sh > /logs/agent/oracle.txt 2>&1 )");
    expect(timeouts.at(-1)).toBe(900_000);
  });
});

describe("verifyHarborTask", () => {
  it("uploads tests only at verification time and parses reward.txt", async () => {
    const task = await fixture();
    const sandbox = new FakeSandbox((script) => script.includes("__OMA_HARBOR_REWARD__")
      ? { output: rewardToken("text", "1\n") }
      : {});
    const result = await verifyHarborTask(task, sandbox, runtime);
    expect(result.rewards).toEqual({ reward: 1 });
    const test = sandbox.commands.find((c) => c.includes("/tests/test.sh >"))!;
    expect(test).toContain("export GRADER='it'\\''s on'");
    expect(test).toContain("cd '/app/site' && ( /tests/test.sh > /logs/verifier/test-stdout.txt 2>&1 )");
  });

  it("prefers reward.json with named metrics", async () => {
    const sandbox = new FakeSandbox((script) => script.includes("__OMA_HARBOR_REWARD__")
      ? { output: rewardToken("json", '{"reward": 0.5, "coverage": 1}') }
      : {});
    expect((await verifyHarborTask(await fixture(), sandbox, runtime)).rewards).toEqual({ reward: 0.5, coverage: 1 });
  });

  it("fails when the verifier wrote no reward", async () => {
    const sandbox = new FakeSandbox((script) => script.includes("__OMA_HARBOR_REWARD__")
      ? { output: rewardToken("none", "") }
      : {});
    await expect(verifyHarborTask(await fixture(), sandbox, runtime)).rejects.toThrow(/No reward file/);
  });
});

describe("parseRewards", () => {
  it("follows Harbor's validation", () => {
    expect(parseRewards("text", " 0.25\n")).toEqual({ reward: 0.25 });
    expect(parseRewards("json", "1")).toEqual({ reward: 1 });
    expect(() => parseRewards("text", "")).toThrow(/empty/);
    expect(() => parseRewards("text", "nan")).toThrow(/Non-finite/);
    expect(() => parseRewards("json", '{"reward": "1"}')).toThrow(/Non-numeric/);
  });
});

describe("requireAgentWorkdir (ADR 0016)", () => {
  it("returns the image WORKDIR the agent must start in", () => {
    expect(requireAgentWorkdir({ name: "t" }, "/app/site/")).toBe("/app/site");
  });
  it("refuses images without WORKDIR instead of running them in /workspace", () => {
    for (const workdir of [null, "", "/"]) {
      expect(() => requireAgentWorkdir({ name: "t" }, workdir)).toThrow(UnsupportedHarborTaskError);
    }
  });
});

describe("detached steps", () => {
  it("starts test.sh in the background in the task workdir and records its exit status under /oma/eval", async () => {
    const task = await fixture();
    const sandbox = new FakeSandbox(() => ({}));
    await startHarborVerifier(task, sandbox, runtime);
    expect(sandbox.files.has("/tests/test.sh")).toBe(true);
    const launch = sandbox.commands.find((c) => c.includes("nohup bash -c"))!;
    expect(launch).toContain("rm -f /oma/eval/verifier.exit /oma/eval/verifier.pid");
    expect(launch).toContain("/tests/test.sh > /logs/verifier/test-stdout.txt 2>&1");
    expect(launch).toContain("echo $? > /oma/eval/verifier.exit");
    expect(launch).toContain("cd '\\''/app/site'\\''");
  });

  it("polls the exit file", async () => {
    let exit = "";
    const sandbox = new FakeSandbox((script) => script.includes("/oma/eval/verifier.exit") ? { output: exit } : {});
    expect(await pollDetached(sandbox, "verifier")).toEqual({ done: false });
    exit = "2\n";
    expect(await pollDetached(sandbox, "verifier")).toEqual({ done: true, exitCode: 2 });
  });

  it("refuses an oracle run without solve.sh and kills by pid", async () => {
    const task = { ...(await fixture()), solution: null };
    const sandbox = new FakeSandbox(() => ({}));
    await expect(startHarborOracle(task, sandbox, runtime)).rejects.toThrow(/no solution/);
    await killDetached(sandbox, "oracle");
    expect(sandbox.commands.at(-1)).toContain("/oma/eval/oracle.pid");
  });

  it("uploads through exec in base64 chunks when the sandbox has no binary write", async () => {
    const commands: string[] = [];
    const sandbox: HarborTrialSandbox = {
      exec: async (command) => { commands.push(command); return "\n__OMA_HARBOR_EXIT__=0"; },
      writeFile: async () => { throw new Error("not used"); },
    };
    await uploadFiles(sandbox, [{ path: "a/b.sh", bytes: new Uint8Array(70_000).fill(65), executable: true }], "/tests");
    const writes = commands.filter((c) => c.includes("base64 -d"));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain(">>");
    expect(commands.at(-1)).toContain("chmod +x");
  });
});
