import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  Deadlock,
  retryTransientDb,
  setDbBoundaryLogger,
  withDbBoundary,
  type DbBoundaryLog,
} from "@open-managed-agents/sql-client";

describe("db boundary retry", () => {
  it("records one summary with the retry count after a recovered deadlock", async () => {
    const logs: DbBoundaryLog[] = [];
    setDbBoundaryLogger((record) => logs.push(record));
    let calls = 0;
    const value = await withDbBoundary({
      op: "session_execution.renew",
      sessionId: "session_01",
      timeoutMs: 30,
    }, () => retryTransientDb(async () => {
      calls += 1;
      if (calls < 3) throw new Deadlock({ op: "session_execution.renew", sessionId: "session_01" });
      return "ok";
    }));
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(logs).toEqual([expect.objectContaining({
      op: "session_execution.renew",
      sessionId: "session_01",
      timeoutMs: 30,
      outcome: "ok",
      errorTag: "Deadlock",
      retryCount: 2,
    })]);
  });

  it("stops after five attempts and logs the final Deadlock", async () => {
    const logs: DbBoundaryLog[] = [];
    setDbBoundaryLogger((record) => logs.push(record));
    let calls = 0;
    await expect(withDbBoundary({ op: "session_execution.settle", sessionId: "session_02" }, () =>
      retryTransientDb(async () => {
        calls += 1;
        throw new Deadlock({ op: "session_execution.settle", sessionId: "session_02" });
      }),
    )).rejects.toBeInstanceOf(Deadlock);
    expect(calls).toBe(5);
    expect(logs[0]).toMatchObject({
      op: "session_execution.settle",
      sessionId: "session_02",
      outcome: "error",
      errorTag: "Deadlock",
      retryCount: 4,
    });
  });
});

describe("process failure log", () => {
  it("prints one structured line and exits on an unhandled rejection", async () => {
    const fixture = resolve(import.meta.dirname, "helpers/process-failure-fixture.ts");
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    const code = await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`fixture hung: ${output}`));
      }, 10_000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolvePromise(status ?? -1);
      });
    });
    expect(code).toBe(1);
    const line = output.split("\n").map((entry) => entry.trim()).find((entry) => entry.includes("process.failure"));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      msg: "process.failure",
      op: "process.unhandled_rejection",
      errorTag: "CasConflict",
      sessionId: "session_fatal",
    });
  });

  it.each([
    ["timeout", "production", "Timeout"],
    ["connection", "production", "ConnectionLost"],
    ["exception", "production", "Timeout"],
    ["logger", "production", null],
    ["metrics", "production", "Timeout"],
    ["timeout", "test", "Timeout"],
  ])("exits for unowned %s even with NODE_ENV=%s", async (mode, nodeEnv, tag) => {
    const fixture = resolve(import.meta.dirname, "helpers/process-failure-fixture.ts");
    const child = spawn(process.execPath, ["--import", "tsx", fixture, mode], {
      env: { ...process.env, NODE_ENV: nodeEnv }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const code = await new Promise<number>((resolvePromise, reject) => {
      const deadline = setTimeout(() => { child.kill(); reject(new Error(`failure fixture hung: ${output}`)); }, 10_000);
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("close", (status) => { clearTimeout(deadline); resolvePromise(status ?? -1); });
    });
    expect(output).toContain("fixture-ready");
    expect(output).not.toContain("survived");
    expect(code).toBe(1);
    if (tag !== null) {
      const line = output.split("\n").find((entry) => entry.startsWith('{"msg":"process.failure"'));
      expect(JSON.parse(line ?? "{}")).toMatchObject({
        errorTag: tag,
        op: mode === "exception" ? "process.uncaught_exception" : "process.unhandled_rejection",
      });
    }
  });

});
