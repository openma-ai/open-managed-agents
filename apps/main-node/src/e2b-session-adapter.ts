// SANDBOX_PROVIDER=e2b: Session sandboxes go through the native Sandbox SDK v2
// E2B adapter (research/sandbox-sdk-v2-design.md §0.2) under the shared
// Session sandbox core. The `e2b` SDK is this application's dependency (the
// adapter only declares it as an optional peer), so it is loaded here and
// handed to the adapter.

import { E2BSandboxExecutor, type E2BSandboxOptions, type E2BSandboxLike } from "@open-managed-agents/sandbox-adapter-e2b";
import type { NodeSessionSandboxAdapter } from "@open-managed-agents/control-plane-node";
import { assertLeaseCoversIdle, readS3MemoryBucket, SANDBOX_LEASE_MARGIN_MS } from "@open-managed-agents/sandbox";
import {
  createE2BV2Adapter,
  E2B_SANDBOX_DIRECTORIES,
  type E2BV2Module,
} from "@open-managed-agents/sandbox-adapter-e2b/v2";

/** E2B lease (its own idle reclaim) when E2B_SANDBOX_TIMEOUT_MS is unset:
 * idlePauseMs + SANDBOX_LEASE_MARGIN_MS (design §0.0b A.10), renewed by
 * keepAlive inside executions only. A shorter E2B_SANDBOX_TIMEOUT_MS fails
 * composition. */
export function defaultE2BLeaseMs(idlePauseMs: number): number {
  return idlePauseMs + SANDBOX_LEASE_MARGIN_MS;
}

export async function createNodeE2BSessionAdapter(
  env: Readonly<Record<string, string | undefined>>,
  idlePauseMs: number,
  loadSdk: () => Promise<unknown> = () => import("e2b"),
): Promise<NodeSessionSandboxAdapter> {
  const maxLifetimeMs = positiveMs(env, "E2B_MAX_LIFETIME_MS");
  if (maxLifetimeMs === undefined) {
    throw new TypeError(
      "E2B_MAX_LIFETIME_MS is required with SANDBOX_PROVIDER=e2b: the account plan's continuous-run cap in milliseconds (Hobby 3600000, Pro 86400000)",
    );
  }
  const leaseMs = positiveMs(env, "E2B_SANDBOX_TIMEOUT_MS") ?? defaultE2BLeaseMs(idlePauseMs);
  assertLeaseCoversIdle("E2B_SANDBOX_TIMEOUT_MS", leaseMs, idlePauseMs);
  const memoryBucket = readS3MemoryBucket(env);
  const sdk = await loadSdk();
  const adapter = createE2BV2Adapter({
    sdk: sdk as E2BV2Module,
    connection: {
      ...(env.E2B_API_KEY === undefined ? {} : { apiKey: env.E2B_API_KEY }),
      ...(env.E2B_API_URL === undefined ? {} : { apiUrl: env.E2B_API_URL }),
      ...(env.E2B_SANDBOX_URL === undefined ? {} : { sandboxUrl: env.E2B_SANDBOX_URL }),
      ...(env.E2B_DOMAIN === undefined ? {} : { domain: env.E2B_DOMAIN }),
    },
    leaseMs,
    maxLifetimeMs,
    // SDK agent operations are unprivileged; the opt-in template launcher
    // separately starts trusted management workers as root through private Files API.
    user: "oma-worker",
    // Work finalization on ANY replica reads the exact sandbox without
    // connecting and refuses one E2B could implicitly resume (same contract
    // as CF Work). The adapter always attaches/resumes via explicit connect.
    managedBootstrap: env.OPENMA_WORK_RUNNER_COMMAND?.trim() ? { disableAutoResume: true } : {},
    setup: E2B_SANDBOX_DIRECTORIES,
    // The executor's s3fs mounts for Node's outputs and native Memory Store calls.
    ...(memoryBucket === undefined ? {} : { memoryBucket }),
  });
  const template = env.SANDBOX_IMAGE;
  return {
    adapter,
    ...(memoryBucket ? {nativeWorkBucket:memoryBucket} : {}),
    connectWorkReadonly: runtimeId => readNodeWorkRuntime(sdk as Parameters<typeof readNodeWorkRuntime>[0], {
      apiKey:env.E2B_API_KEY,apiUrl:env.E2B_API_URL,sandboxUrl:env.E2B_SANDBOX_URL,domain:env.E2B_DOMAIN,
      ...(memoryBucket ? {memoryBucket} : {}),
    },runtimeId),
    // An Environment-selected catalog image overrides the process default.
    image: (catalogImage) => catalogImage?.reference ?? template ?? "base",
    keepAliveMs: Math.floor(leaseMs / 3),
  };
}

function positiveMs(env: Readonly<Record<string, string | undefined>>, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new TypeError(`${name} must be a positive integer of milliseconds`);
  return ms;
}


/** Same GET-only contract as CF finalization. Inject the installed SDK at the
 * Node composition boundary; never call connect, even for a paused VM. */
export async function readNodeWorkRuntime(
  sdk: {
    ApiClient: new (config: unknown) => {api:{GET(path:"/sandboxes/{sandboxID}",input:{params:{path:{sandboxID:string}}}):Promise<{data?:{sandboxID:string;state?:string;lifecycle?:{autoResume?:boolean};envdVersion?:string;envdAccessToken?:string;domain?:string}|null;error?:{code?:number}|null}>}};
    ConnectionConfig: new (options: E2BSandboxOptions) => unknown;
    Sandbox: new (options: E2BSandboxOptions & {sandboxId:string;envdVersion:string;envdAccessToken:string;sandboxDomain?:string}) => E2BSandboxLike;
  },
  options: E2BSandboxOptions,
  runtimeId: string,
): Promise<E2BSandboxExecutor | "gone"> {
  const {data,error} = await new sdk.ApiClient(new sdk.ConnectionConfig(options)).api.GET("/sandboxes/{sandboxID}",{params:{path:{sandboxID:runtimeId}}});
  // Definitive absence uses the SDK's own rule for this endpoint (error code
  // 404 = SandboxNotFoundError). Any other read failure is not absence.
  if (error?.code === 404) return "gone";
  if (error || !data) throw new Error("Work finalization provider read unavailable");
  if (data.sandboxID !== runtimeId || data.state !== "running" || data.lifecycle?.autoResume !== false
    || !data.envdVersion || !data.envdAccessToken) throw new Error("Work finalization requires exact running sandbox with auto-resume disabled");
  const sandbox = new sdk.Sandbox({...options,sandboxId:data.sandboxID,envdVersion:data.envdVersion,envdAccessToken:data.envdAccessToken,...(data.domain?{sandboxDomain:data.domain}:{})});
  return new E2BSandboxExecutor({sandboxId:sandbox.sandboxId,
    files:{read:(path,opts)=>sandbox.files.read(path,opts),write:(path,bytes,opts)=>sandbox.files.write(path,bytes,opts)},
    commands:{run:(cmd,opts)=>sandbox.commands.run(cmd,opts)},
    kill:async()=>{throw new Error("Finalization cannot destroy a sandbox");},
  },{...options,user:"oma-worker",managedBootstrap:{disableAutoResume:true}});
}
