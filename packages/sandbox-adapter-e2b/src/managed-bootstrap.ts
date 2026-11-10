import type { SandboxManagedProcessSpec, SandboxManagedProcessHandle } from "@open-managed-agents/sandbox";
import type { E2BSandboxLike } from "./e2b";

/** Only enable for a trusted template with template/launcher.py already running.
 * Never install/start this through Commands.run in a live sandbox. */
export interface E2BManagedBootstrapOptions {
  directory?: string;
}

export async function startE2BManagedProcess(
  sandbox: E2BSandboxLike,
  options: E2BManagedBootstrapOptions,
  spec: SandboxManagedProcessSpec,
): Promise<SandboxManagedProcessHandle> {
  const directory = options.directory ?? "/run/oma-managed";
  if (!directory.startsWith("/") || directory.includes("\0")) throw new TypeError("Absolute bootstrap directory required");
  if (!spec.command.startsWith("/") || spec.command.includes("\0")) throw new TypeError("Absolute management command required");
  if (spec.cwd !== undefined && (!spec.cwd.startsWith("/") || spec.cwd.includes("\0"))) throw new TypeError("Absolute management cwd required");
  if ((spec.args ?? []).some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new TypeError("Invalid management argv");
  for (const [name, value] of Object.entries(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) throw new TypeError("Invalid replacement environment");
  }
  if (await sandbox.files.read(directory + "/ready", { user: "root" }) !== "oma-managed-v2") throw new Error("Trusted E2B management template is not ready");
  async function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const prefix = directory + "/" + id;
    // Publish the trigger only after the complete JSON file is written.
    await sandbox.files.write(prefix + ".json", JSON.stringify({ ...body, id }), { user: "root" });
    await sandbox.files.write(prefix + ".go", "", { user: "root" });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      let raw: string;
      try { raw = await sandbox.files.read(prefix + ".response.json", { user: "root" }); }
      catch (error) {
        const code = (error as { code?: string }).code;
        const name = (error as { name?: string }).name;
        if (code !== "ENOENT" && name !== "FileNotFoundError" && name !== "NotFoundError") throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      const result = JSON.parse(raw) as Record<string, unknown>;
      if (result.ok !== true) throw Object.assign(new Error(typeof result.error === "string" ? result.error : "E2B management request failed"), { outcome: "rejected" });
      return result;
    }
    // Dispatch may have happened: never retry or fall back to a shell.
    throw new Error("E2B management outcome unknown; destroy the owning sandbox before retrying");
  }
  let result: Record<string, unknown>;
  try { result = await request({ op: "start", spec }); }
  catch (error) {
    if ((error as { outcome?: string }).outcome === "rejected") throw error;
    throw Object.assign(new Error("E2B management launch outcome unknown; destroy the owning sandbox", { cause: error }), { outcome: "unknown" });
  }
  if (typeof result.id !== "string" || !Number.isSafeInteger(result.pid) || Number(result.pid) <= 0) throw Object.assign(new Error("Invalid E2B management process acknowledgement"), { outcome: "unknown" });
  const target = result.id;
  return {
    id: target, pid: Number(result.pid),
    async getStatus() {
      const result = await request({ op: "status", target });
      if (result.status !== "running" && result.status !== "exited") throw new Error("Invalid E2B management status");
      return result.status;
    },
    async kill(signal) {
      if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new TypeError("Unsupported management signal");
      await request({ op: "kill", target, signal });
    },
  };
}
