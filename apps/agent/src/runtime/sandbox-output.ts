import type { SandboxExecutor } from "@open-managed-agents/agent-harness";

/** Stdout of a CF sandbox command (`exit=N\n<stdout>`); throws on failure. */
export async function sandboxStdout(sandbox: SandboxExecutor, command: string, timeoutMs: number): Promise<string> {
  const out = await sandbox.exec(command, timeoutMs);
  const match = out.match(/^exit=(\d+)\n([\s\S]*)$/);
  if (!match || match[1] !== "0") throw new Error(out.slice(0, 300));
  return match[2]!;
}

/** Binary-safe file read: SandboxExecutor.readFile is UTF-8 only, so the
 * sandbox base64-encodes and this side decodes. */
export async function readSandboxFileBytes(sandbox: SandboxExecutor, path: string, timeoutMs: number): Promise<Uint8Array> {
  const encoded = (await sandboxStdout(sandbox, `base64 -w0 -- '${path.replace(/'/g, "'\\''")}' 2>&1`, timeoutMs)).trim();
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
