import { e2bNativeMountCommand } from "../../../../sandbox-adapter-e2b/src/native-mount.js";
import { executionIdentity } from "../../../../sandbox-adapter-e2b/src/execution-identity.js";
import { e2bNativeDrainCommand, e2bMountControlDirectory } from "../../../../sandbox-adapter-e2b/src/native-drain.js";
import type { E2BSandboxOptions } from "../../../../sandbox-adapter-e2b/src/e2b.js";
import type { NodeWorkStorageInput } from "../node-session-sandbox.js";
import type { SandboxPort, SandboxSessionOutputMountPort } from "@open-managed-agents/sandbox";

export type NodeNativeBucket = NonNullable<E2BSandboxOptions["memoryBucket"]>;
/** outputs=false: Session outputs are shared (not natively mounted); drain Memory only. */
export interface NodeNativeDrainOptions { outputs: boolean }
type NativeRuntime = SandboxPort & {
  run(command:string, options:{user?:string;sessionEnv:boolean;timeoutMs?:number;envs?:Record<string,string>}):Promise<{stdout:string;stderr:string;exitCode:number}>;
  runtimeHandle():{provider:string;runtimeId:string};
  drainNodeWorkStorage?(input:NodeWorkStorageInput, options?:NodeNativeDrainOptions):Promise<void>;
};
const quote = (s:string) => "'"+s.replaceAll("'","'\\''")+"'";

/** Node-owned replacement for the legacy s3fs mount path. Reuses the CF
 * root-only RC protocol without changing the shared adapter. Credentials stay
 * in management env, never argv or agent Session env. */
export function configureNodeNativeStorage(sandbox: SandboxPort, bucket: NodeNativeBucket): void {
  const runtime = sandbox as NativeRuntime;
  if (runtime.runtimeHandle?.().provider !== "e2b" || typeof runtime.run !== "function") throw new Error("Native Node rclone management unavailable");
  const mounts = new Map<string,string>();
  const run = async (command:string,envs?:Record<string,string>) => {
    const result = await runtime.run(command,{user:"root",sessionEnv:false,timeoutMs:60_000,...(envs?{envs}:{})});
    if (result.exitCode !== 0) throw new Error("Native Node storage capability failed: "+result.stderr.slice(0,500));
    return result.stdout;
  };
  const mount = async (target:string,prefix:string,readOnly:boolean) => {
    const control=e2bMountControlDirectory(target);
    const remote=`:s3:${bucket.bucketName}/${prefix.replace(/\/$/,"")}`;
    const prior=mounts.get(target);
    if (prior===remote) return;
    // A retained mount is verified through the SAME exact daemon/endpoint RC
    // protocol. Never remount it over queued writes; legacy s3fs fails closed.
    const existing = await run(`if mountpoint -q ${quote(target)}; then printf retained; fi`);
    if (existing.trim() === "retained") {
      const receipt=JSON.parse(await run(e2bNativeDrainCommand([{target,remote,endpoint:bucket.endpoint}])));
      if (receipt?.type!=="drained" || receipt.version!==1) throw new Error("Retained native mount is not drained");
      mounts.set(target,remote);
      return;
    }
    const owner = await executionIdentity(runtime);
    await run(`if mountpoint -q ${quote(target)}; then echo 'existing native mount needs verified recovery' >&2; exit 90; fi; `+
      `test ! -L ${quote(target)} || { echo 'legacy native symlink unsupported' >&2; exit 90; }; `+
      `command -v rclone >/dev/null && install -d -m 700 /run/oma-rclone ${quote(control)} && mkdir -p ${quote(target)} || exit 90; `+
      e2bNativeMountCommand(`rclone mount ${quote(remote)} ${quote(target)} --rc --rc-no-auth ${quote('--rc-addr=unix://'+control+'/rc.sock')} --s3-no-check-bucket --allow-other --allow-non-empty --uid=${owner.uid} --gid=${owner.gid} --vfs-cache-mode=writes ${readOnly?'--read-only':''}`,target,control),{
        RCLONE_S3_PROVIDER:"Other",RCLONE_S3_ENDPOINT:bucket.endpoint,RCLONE_S3_REGION:"auto",
        RCLONE_S3_ACCESS_KEY_ID:bucket.accessKey,RCLONE_S3_SECRET_ACCESS_KEY:bucket.secretKey,
        RCLONE_S3_FORCE_PATH_STYLE:bucket.usePathRequestStyle===false?"false":"true",
      });
    await run(`mountpoint -q ${quote(target)} && ls -A ${quote(target)} >/dev/null`);
    mounts.set(target,remote);
  };
  sandbox.mountMemoryStore = i => mount(`/mnt/memory/${i.storeName}`,i.storeId,i.readOnly);
  (sandbox as SandboxPort & SandboxSessionOutputMountPort).mountSessionOutputs = i => mount("/mnt/session/outputs",`session-outputs/${i.tenantId}/${i.sessionId}`,false);
  runtime.drainNodeWorkStorage = async (input, options = { outputs: true }) => {
    const writable=input.session.resources.filter(r=>r.type==="memory_store" && r.access==="read_write");
    const expected=[...(options.outputs ? [{target:"/mnt/session/outputs",remote:`:s3:${bucket.bucketName}/session-outputs/${input.workspaceId}/${input.session.id}`}] : []),
      ...writable.map(r=>{if(r.type!=="memory_store")throw Error("invalid Memory resource");return {
        target:`/mnt/memory/${r.name??r.memoryStoreId}`,
        remote:`:s3:${bucket.bucketName}/.openma-managed-memory-workspaces/${encodeURIComponent(input.workspaceId)}/${encodeURIComponent(input.session.id)}/${encodeURIComponent(input.runtimeGeneration)}/${encodeURIComponent(r.memoryStoreId)}/data`,
      };})].map(m=>({...m,endpoint:bucket.endpoint}));
    if (!await input.workAuthority.isCurrent()) throw new Error("Work native drain authority lost");
    const receipt=JSON.parse(await run(e2bNativeDrainCommand(expected)));
    if (receipt?.type!=="drained" || receipt.version!==1) throw new Error("Native Node drain did not acknowledge uploads");
    if (!await input.workAuthority.isCurrent()) throw new Error("Work native drain authority lost");
  };
}

export async function drainNodeNativeWorkStorage(input: NodeWorkStorageInput, options: NodeNativeDrainOptions = { outputs: true }): Promise<void> {
  const runtime=input.sandbox as Partial<NativeRuntime>;
  // LocalSubprocess mounts are synchronous host filesystem mounts, not VFS.
  if (runtime.runtimeHandle?.().provider !== "e2b") return;
  if (!runtime.drainNodeWorkStorage) throw new Error("Native Node upload drain is not configured; legacy mount cannot acknowledge durability");
  await runtime.drainNodeWorkStorage(input, options);
}
