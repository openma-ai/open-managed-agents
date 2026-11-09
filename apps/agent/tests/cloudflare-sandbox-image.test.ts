import { afterEach, describe, expect, it } from "vitest";

import { CloudflareSandbox, resolveCloudflareSandboxNamespace } from "../src/runtime/sandbox";
import { setSandboxForTest } from "../../../test/sandbox-stub";

afterEach(() => setSandboxForTest(undefined));

function recordingSandbox() {
  const calls: Array<{ op: string; command: string; options: Record<string, unknown> }> = [];
  setSandboxForTest({
    async exec(command: string, options: Record<string, unknown>) {
      calls.push({ op: "exec", command, options });
      return { stdout: "out", stderr: "", exitCode: 0, success: true };
    },
    async startProcess(command: string, options: Record<string, unknown>) {
      calls.push({ op: "startProcess", command, options });
      return { id: "p1", pid: 1, kill: async () => {}, getLogs: async () => ({}), getStatus: async () => "running" };
    },
  });
  return calls;
}

describe("CloudflareSandbox catalog image", () => {
  it("uses the default SANDBOX namespace and /workspace without an image", async () => {
    const calls = recordingSandbox();
    const sandbox = new CloudflareSandbox({ SANDBOX: { name: "default" } } as never, "sess-default");
    expect(await sandbox.resolveWorkspaceRoot()).toBe("/workspace");
    expect(await sandbox.exec("pwd")).toBe("exit=0\nout");
    expect(calls[0]!.options).not.toHaveProperty("cwd");
  });

  it("runs exec and background processes in the catalog workdir", async () => {
    const calls = recordingSandbox();
    const sandbox = new CloudflareSandbox(
      { SANDBOX: {}, SANDBOX_FIX_GIT: {} } as never,
      "sess-task",
      { alias: "fix-git", binding: "SANDBOX_FIX_GIT", workdir: "/app" },
    );
    expect(await sandbox.resolveWorkspaceRoot()).toBe("/app");
    await sandbox.exec("bash /tests/test.sh", 1000);
    await sandbox.startProcess("sleep 1");
    expect(calls.map((call) => call.options.cwd)).toEqual(["/app", "/app"]);
  });

  it("selects the container namespace of the alias", () => {
    const task = { name: "task" };
    const env = { SANDBOX: { name: "default" }, SANDBOX_FIX_GIT: task } as never;
    expect(resolveCloudflareSandboxNamespace(env, null)).toEqual({ name: "default" });
    expect(resolveCloudflareSandboxNamespace(env, { alias: "fix-git", binding: "SANDBOX_FIX_GIT" })).toBe(task);
  });

  it("fails explicitly instead of falling back to the default container", async () => {
    const env = { SANDBOX: {} } as never;
    expect(() => resolveCloudflareSandboxNamespace(env, { alias: "fix-git", binding: "SANDBOX_FIX_GIT" }))
      .toThrow(/needs container binding SANDBOX_FIX_GIT, which this agent worker does not declare/);
    expect(() => resolveCloudflareSandboxNamespace(env, { alias: "x", binding: "bad-name" }))
      .toThrow(/invalid container binding name/);
    expect(() => resolveCloudflareSandboxNamespace({ SANDBOX: {}, B: {} } as never, { alias: "x", binding: "B", workdir: "app" }))
      .toThrow(/invalid workdir/);
    recordingSandbox();
    const sandbox = new CloudflareSandbox(env, "sess-missing", { alias: "fix-git", binding: "SANDBOX_FIX_GIT" });
    await expect(sandbox.exec("true")).rejects.toThrow(/SANDBOX_FIX_GIT/);
  });
});
