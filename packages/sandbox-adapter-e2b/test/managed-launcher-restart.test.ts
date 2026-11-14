import { describe, expect, it } from "vitest";
import { E2BSandboxExecutor, E2B_MANAGED_LAUNCHER_START } from "../src/e2b";

/** A filesystem snapshot (environment or checkpoint) cold-boots without the
 * template start command; the adapter re-runs exactly that root step. */
function fakeSandbox(readyInitially: boolean, becomesReady = true) {
  let ready = readyInitially;
  const runs: Array<{ cmd: string; opts: Record<string, unknown> | undefined }> = [];
  const sandbox = {
    sandboxId: "sbx",
    commands: { run: async (cmd: string, opts?: Record<string, unknown>) => { runs.push({ cmd, opts }); if (becomesReady) setTimeout(() => { ready = true; }, 20); return { pid: 1 }; } },
    files: { read: async (path: string, opts?: { user?: string }) => {
      expect(opts?.user).toBe("root");
      if (path === "/run/oma-managed/ready" && ready) return "oma-managed-v2";
      throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    } },
  };
  return { sandbox, runs };
}

describe("ensureManagedLauncher", () => {
  it("is a no-op when the template launcher is already ready", async () => {
    const { sandbox, runs } = fakeSandbox(true);
    await new E2BSandboxExecutor(sandbox as never, { managedBootstrap: {} }).ensureManagedLauncher();
    expect(runs).toEqual([]);
  });
  it("restarts the verified launcher as root in the background and waits for ready", async () => {
    const { sandbox, runs } = fakeSandbox(false);
    await new E2BSandboxExecutor(sandbox as never, { managedBootstrap: {} }).ensureManagedLauncher();
    expect(runs).toEqual([{ cmd: E2B_MANAGED_LAUNCHER_START, opts: { background: true, user: "root", timeoutMs: 0 } }]);
    expect(E2B_MANAGED_LAUNCHER_START).toContain("/opt/oma-managed/verify-install.py");
    expect(E2B_MANAGED_LAUNCHER_START.split("\n").at(-1)).toBe("exec /usr/bin/python3 -I -S /opt/oma-managed/launcher.py");
  });
  it("fails closed when the launcher never becomes ready (e.g. verification failed)", async () => {
    const { sandbox } = fakeSandbox(false, false);
    await expect(new E2BSandboxExecutor(sandbox as never, { managedBootstrap: {} }).ensureManagedLauncher(300)).rejects.toThrow(/did not become ready/);
  });
  it("does nothing for an unmanaged sandbox", async () => {
    const { sandbox, runs } = fakeSandbox(false);
    await new E2BSandboxExecutor(sandbox as never, {}).ensureManagedLauncher();
    expect(runs).toEqual([]);
  });
});
