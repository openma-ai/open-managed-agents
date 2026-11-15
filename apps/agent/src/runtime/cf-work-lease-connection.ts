import { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";

/** Maintenance must never call Sandbox.connect: its POST can resume and renew.
 * The SDK's public ApiClient GET returns envd credentials (getInfo drops them).
 * Constructing the SDK object performs no I/O. Refuse traffic auto-resume too:
 * a running-state check alone cannot fence a pause racing the first Files read.
 */
export async function readCfWorkLeaseRuntime(env: { E2B_API_KEY?: string; E2B_DOMAIN?: string }, runtimeId: string): Promise<E2BSandboxExecutor> {
  if (!env.E2B_API_KEY) throw new Error("Work lease recovery requires E2B_API_KEY");
  const { ApiClient, ConnectionConfig, Sandbox } = await import("e2b");
  const options = { apiKey: env.E2B_API_KEY, ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}) };
  const client = new ApiClient(new ConnectionConfig(options));
  const { data, error } = await client.api.GET("/sandboxes/{sandboxID}", {
    params: { path: { sandboxID: runtimeId } },
  });
  if (error || !data) throw new Error("Work lease provider read unavailable");
  if (data.sandboxID !== runtimeId || data.state !== "running" || data.lifecycle?.autoResume !== false) {
    throw new Error("Work lease recovery requires an already running sandbox with auto-resume disabled");
  }
  if (!data.envdVersion || !data.envdAccessToken) throw new Error("Work lease read has no authenticated envd connection");
  const sandbox = new Sandbox({ ...options, sandboxId: data.sandboxID, envdVersion: data.envdVersion,
    envdAccessToken: data.envdAccessToken, ...(data.domain ? { sandboxDomain: data.domain } : {}),
  });
  return new E2BSandboxExecutor({
    sandboxId: sandbox.sandboxId,
    files: { read: (path, opts) => sandbox.files.read(path, opts), write: (path, bytes, opts) => sandbox.files.write(path, bytes, opts) },
    commands: { run: async () => { throw new Error("Work lease recovery cannot execute commands"); } },
    kill: async () => { throw new Error("Work lease recovery cannot destroy a sandbox"); },
    setTimeout: ms => sandbox.setTimeout(ms),
  }, { ...options, managedBootstrap: {} });
}
