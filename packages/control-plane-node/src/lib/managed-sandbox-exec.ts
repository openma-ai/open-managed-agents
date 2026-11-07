import type { SandboxExecutor } from "@open-managed-agents/sandbox";

export class ManagedSandboxExecError extends Error {
  constructor(message: string, readonly output?: string) {
    super(message);
    this.name = "ManagedSandboxExecError";
  }
}

const EXIT_MARKER = "__OMA_SANDBOX_EXEC_EXIT__=";

/**
 * Run a shell command in a managed Session's sandbox from the control plane.
 * Adapters frame exit status differently ("exit=N\n…", "…\n[exit N]"), so the
 * status travels in our own trailing marker and stderr is merged into stdout
 * to keep the marker last. Shared by POST /v1/oma/sessions/:id/sandbox/exec
 * and the eval runner.
 */
export async function execManagedSandbox(
  sandbox: SandboxExecutor,
  command: string,
  timeoutMs: number,
): Promise<{ exit_code: number; output: string }> {
  const quoted = `'${command.replaceAll("'", "'\\''")}'`;
  const raw = await sandbox.exec(`sh -c ${quoted} 2>&1; printf '\\n${EXIT_MARKER}%s\\n' "$?"`, timeoutMs);
  const at = raw.lastIndexOf(EXIT_MARKER);
  if (at < 0) throw new ManagedSandboxExecError("Sandbox exec did not report an exit status", raw.slice(-2000));
  const exitCode = Number.parseInt(raw.slice(at + EXIT_MARKER.length), 10);
  const output = raw.slice(0, at).replace(/^exit=0\n/u, "").replace(/\n$/u, "");
  return { exit_code: exitCode, output };
}
