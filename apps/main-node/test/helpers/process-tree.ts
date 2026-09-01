import type { ChildProcess } from "node:child_process";

/** The pnpm/tsx launcher creates a child Node process. A detached process
 * group lets test cleanup fence the launcher and every inherited descendant
 * instead of killing only the shell wrapper and leaking the actual server. */
export const detachedProcessOptions: { detached?: boolean } =
  process.platform === "win32" ? {} : { detached: true };

export async function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  const exited = alreadyExited
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));

  let killedGroup = false;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      killedGroup = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (!killedGroup && !alreadyExited) child.kill(signal);
  await exited;
}
