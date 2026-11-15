import type { SandboxManagedProcessSpec, SandboxManagedProcessHandle } from "@open-managed-agents/sandbox";
import type { E2BSandboxLike } from "./e2b";

/** Only enable for a trusted template with template/launcher.py already running.
 * Never install/start this through Commands.run in a live sandbox. */
export interface E2BManagedBootstrapOptions {
  directory?: string;
  /** Allowlisted diagnostics only, never request/response bodies or credentials. */
  observe?(event: E2BManagementObservation): void;
  /** Opt-in for read-only lease recovery; legacy callers retain auto-resume. */
  disableAutoResume?: boolean;
}

export interface E2BManagementObservation {
  sandboxId?: string;
  requestId: string;
  operation: string;
  stage: string;
  status: "started" | "completed" | "failed";
  durationMs: number;
  target?: string;
  workId?: string;
  sessionId?: string;
  attemptId?: string;
  errorName?: string;
  errorCode?: string | number;
}

export async function startE2BManagedProcess(
  sandbox: E2BSandboxLike,
  options: E2BManagedBootstrapOptions,
  spec: SandboxManagedProcessSpec,
  identity?: E2BManagedIdentity,
): Promise<SandboxManagedProcessHandle> {
  const directory = options.directory ?? "/run/oma-managed";
  if (!directory.startsWith("/") || directory.includes("\0")) throw new TypeError("Absolute bootstrap directory required");
  if (!spec.command.startsWith("/") || spec.command.includes("\0")) throw new TypeError("Absolute management command required");
  if (spec.cwd !== undefined && (!spec.cwd.startsWith("/") || spec.cwd.includes("\0"))) throw new TypeError("Absolute management cwd required");
  if ((spec.args ?? []).some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new TypeError("Invalid management argv");
  for (const [name, value] of Object.entries(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) throw new TypeError("Invalid replacement environment");
  }
  const boundIdentity = identity === undefined ? undefined : checkedIdentity(identity);
  const request = await managementRequest(sandbox, options);
  let result: Record<string, unknown>;
  try { result = await request({ op: "start", spec, identity: boundIdentity, sandboxId: sandbox.sandboxId }); }
  catch (error) {
    if ((error as { outcome?: string }).outcome === "rejected") throw error;
    throw Object.assign(new Error("E2B management launch outcome unknown; recover only the exact management locator", { cause: error }), { outcome: "unknown" });
  }
  if (typeof result.id !== "string" || typeof result.epoch !== "string" || !Number.isSafeInteger(result.pid) || Number(result.pid) <= 0) throw Object.assign(new Error("Invalid E2B management process acknowledgement"), { outcome: "unknown" });
  const target = result.id;
  const epoch = result.epoch;
  return {
    id: target, pid: Number(result.pid),
    async getStatus() {
      const result = await request({ op: "status", target, epoch, identity: boundIdentity });
      if (result.status !== "running" && result.status !== "exited") throw new Error("Invalid E2B management status");
      return result.status;
    },
    async kill(signal) {
      if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new TypeError("Unsupported management signal");
      await request({ op: "kill", target, signal, epoch, identity: boundIdentity });
    },
  };
}

export interface E2BManagedIdentity {
  workspaceId: string;
  sessionId: string;
  workId: string;
  attemptId: string;
}
export interface E2BManagedLocator {
  sandboxId: string;
  id: string;
  epoch: string;
  pid: number;
  identity: E2BManagedIdentity;
  status: "running" | "exited";
  /** Optional for old launchers. SHA-256 of original token random part. */
  holderHash?: string;
}
function checkedIdentity(identity: E2BManagedIdentity): E2BManagedIdentity {
  const keys = ["workspaceId", "sessionId", "workId", "attemptId"] as const;
  if (!identity || Object.keys(identity).length !== 4 || keys.some(key => typeof identity[key] !== "string" || !identity[key].length || identity[key].length > 256 || identity[key].includes("\0"))) throw new TypeError("Invalid E2B management identity");
  return Object.fromEntries(keys.map(key => [key, identity[key]])) as unknown as E2BManagedIdentity;
}
async function managementRequest(sandbox: E2BSandboxLike, options: E2BManagedBootstrapOptions) {
  const directory = options.directory ?? "/run/oma-managed";
  if (!directory.startsWith("/") || directory.includes("\0")) throw new TypeError("Absolute bootstrap directory required");
  async function observe<T>(requestId: string, operation: string, stage: string, body: Record<string, unknown>, action: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const identity = body.identity as Partial<E2BManagedIdentity> | undefined;
    const report = (status: E2BManagementObservation["status"], error?: unknown) => {
      try {
      const e = error as {name?: unknown; code?: unknown; status?: unknown} | undefined;
      const event: E2BManagementObservation = { sandboxId: sandbox.sandboxId, requestId, operation, stage, status, durationMs: Date.now()-start,
        ...(typeof body.target === "string" ? {target: body.target} : {}),
        ...(typeof identity?.workId === "string" ? {workId: identity.workId} : {}),
        ...(typeof identity?.sessionId === "string" ? {sessionId: identity.sessionId} : {}),
        ...(typeof identity?.attemptId === "string" ? {attemptId: identity.attemptId} : {}),
        ...(typeof e?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? {errorName:e.name} : {}),
        ...(typeof e?.code === "number" ? {errorCode:e.code} : typeof e?.code === "string" && ["ENOENT","ECONNRESET","ETIMEDOUT","ECONNREFUSED"].includes(e.code) ? {errorCode:e.code} : typeof e?.status === "number" ? {errorCode:e.status} : {}),
      };
      options.observe?.(event);
      } catch { /* Diagnostics cannot change native semantics. */ }
    };
    report("started");
    try { const result = await action(); report("completed"); return result; }
    catch (error) { report("failed", error); throw error; }
  }
  if (await observe(crypto.randomUUID(), "ready", "files.read.ready", {}, () => sandbox.files.read(directory + "/ready", { user: "root" })) !== "oma-managed-v2") throw new Error("Trusted E2B management template is not ready");
  async function request(body: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
    const prefix = directory + "/" + id;
    // Publish the trigger only after the complete JSON file is written.
    await observe(id, String(body.op), "files.write.request", body, () => sandbox.files.write(prefix + ".json", JSON.stringify({ ...body, id }), { user: "root" }));
    await observe(id, String(body.op), "files.write.trigger", body, () => sandbox.files.write(prefix + ".go", "", { user: "root" }));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      let raw: string;
      try { raw = await observe(id, String(body.op), "files.read.response", body, () => sandbox.files.read(prefix + ".response.json", { user: "root" })); }
      catch (error) {
        const code = (error as { code?: string }).code;
        const name = (error as { name?: string }).name;
        if (code !== "ENOENT" && name !== "FileNotFoundError" && name !== "NotFoundError") throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      return observe(id, String(body.op), "response.validate", body, async () => {
        const result = JSON.parse(raw) as Record<string, unknown>;
        if (result.ok !== true) throw Object.assign(new Error(typeof result.error === "string" ? result.error : "E2B management request failed"), { outcome: "rejected" });
        return result;
      });
    }
    // Dispatch may have happened: never retry or fall back to a shell.
    throw new Error("E2B management outcome unknown; inspect the exact management slot before recovery");
  }
  return async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = crypto.randomUUID();
    try { return await request(body, id); }
    catch (error) {
      // A Files failure is not evidence of provider death (it can be a paused
      // sandbox, an envd outage or a network failure). Only the official exact
      // sandbox control-plane lookup can prove that no process remains there.
      // This resolves cleanup only; construction/remount stays in openSandbox.
      if ((body.op !== "kill" && body.op !== "status") || typeof sandbox.getInfo !== "function" || !sandbox.sandboxId) throw error;
      try {
        await observe(id, String(body.op), "provider.getInfo", body, () => sandbox.getInfo!());
      } catch (lookupError) {
        if ((lookupError as {name?: unknown})?.name !== "SandboxNotFoundError") throw lookupError;
        return observe(id, String(body.op), "provider.absence", body, async () => ({ok: true, status: "exited"}));
      }
      throw error;
    }
  };
}
export async function inspectE2BManagedSlot(sandbox: E2BSandboxLike, options: E2BManagedBootstrapOptions): Promise<E2BManagedLocator> {
  const request = await managementRequest(sandbox, options);
  const result = await request({ op: "inspect-slot" });
  const locator = result.locator as Omit<E2BManagedLocator, "sandboxId">;
  if (!sandbox.sandboxId || !locator || typeof locator.id !== "string" || typeof locator.epoch !== "string" || !Number.isSafeInteger(locator.pid) || locator.pid <= 0 || !["running", "exited"].includes(locator.status)) throw new Error("Invalid management locator");
  if (locator.holderHash !== undefined && (typeof locator.holderHash !== "string" || !/^[a-f0-9]{64}$/.test(locator.holderHash) || (locator as E2BManagedLocator).sandboxId !== sandbox.sandboxId)) throw new Error("Invalid process-bound holder hash or sandbox");
  return { ...locator, identity: checkedIdentity(locator.identity), sandboxId: sandbox.sandboxId };
}
export async function restoreE2BManagedProcess(sandbox: E2BSandboxLike, options: E2BManagedBootstrapOptions, locator: E2BManagedLocator): Promise<SandboxManagedProcessHandle> {
  if (!sandbox.sandboxId || locator.sandboxId !== sandbox.sandboxId) throw new Error("Management locator belongs to another sandbox");
  const identity = checkedIdentity(locator.identity);
  const request = await managementRequest(sandbox, options);
  if (locator.holderHash !== undefined && !/^[a-f0-9]{64}$/.test(locator.holderHash)) throw new Error("Invalid process-bound holder hash");
  const body = { target: locator.id, epoch: locator.epoch, identity, requireBound: true,
    ...(locator.holderHash === undefined ? {} : { holderHash: locator.holderHash, sandboxId: locator.sandboxId }),
  };
  const getStatus = async () => {
    const result = await request({ ...body, op: "status" });
    if (result.status !== "running" && result.status !== "exited") throw new Error("Invalid management status");
    return result.status;
  };
  await getStatus(); // Exact UUID+epoch+identity must still be known, not merely a slot match.
  return { id: locator.id, pid: locator.pid, getStatus, async kill(signal) {
    if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new TypeError("Unsupported management signal");
    await request({ ...body, op: "kill", signal });
  } };
}
