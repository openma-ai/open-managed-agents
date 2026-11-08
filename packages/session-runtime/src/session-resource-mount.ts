// Mounting Session resources into a prepared sandbox (design §0.7: Session
// inputs / resource mounting), one use case for the Cloudflare SessionDO and
// the Node runner. Hosts inject only Ports: where file bytes come from, how
// git reaches repositories, how Memory Stores attach (or that the sandbox
// storage Port already attached them), and sealed env values.
//
// Order: plan + preflight every resource (no side effect on a bad set), then
// mount in resource order: repository access is prepared before the first
// clone; env values are applied in one batched call at the end.

import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import {
  checkoutRepository,
  type RepositoryAccessPort,
  type RepositorySandbox,
} from "./session-resource-repository";
import {
  planSessionResourceMounts,
  type MemoryStoreMount,
  type RepositoryMount,
  type SessionResourceMount,
  type SessionResourceRecord,
} from "./session-resource-records";

export type SessionResourceSandbox = RepositorySandbox & Pick<SandboxExecutor, "writeFileBytes" | "mountMemoryStore" | "setEnvVars">;

export interface SessionResourceMountPorts {
  /** Session-scoped file bytes; absent when the host has no file source. */
  downloadFile?(fileId: string): Promise<Uint8Array>;
  repositories: RepositoryAccessPort;
  /** `native`: mount through SandboxPort.mountMemoryStore here (`lookupName`
   * resolves an undeclared store name). `storage`: the sandbox storage Port
   * attached them when the sandbox opened, so this use case skips them. */
  memoryStores:
    | { mode: "native"; lookupName?(storeId: string): Promise<string | null> }
    | { mode: "storage" };
  /** Sealed env resource values by resource id. */
  envSecrets?: ReadonlyMap<string, string>;
  /** After every repository is checked out (e.g. CLI tooling); best effort is the host's call. */
  afterRepositories?(): Promise<void>;
}

function preflight(sandbox: SessionResourceSandbox, mounts: readonly SessionResourceMount[], ports: SessionResourceMountPorts): void {
  for (const mount of mounts) {
    switch (mount.type) {
      case "file":
        if (ports.downloadFile === undefined) throw new Error("Session file resource requires a tenant-scoped file source");
        if (sandbox.writeFileBytes === undefined) throw new Error("Session file resource requires binary sandbox writes");
        break;
      case "memory_store":
        if (ports.memoryStores.mode === "native" && sandbox.mountMemoryStore === undefined) {
          throw new Error("Session Memory Store resource requires a sandbox memory mount Port");
        }
        break;
      case "env":
        if (!ports.envSecrets?.has(mount.id)) throw new Error("Session env resource requires its sealed secret value");
        if (sandbox.setEnvVars === undefined) throw new Error("Session env resource requires sandbox environment injection");
        break;
      case "github_repository":
        break;
    }
  }
}

async function mountMemoryStore(
  sandbox: SessionResourceSandbox,
  mount: MemoryStoreMount,
  lookupName: ((storeId: string) => Promise<string | null>) | undefined,
): Promise<void> {
  // The public contract mounts by store name, not id: a store mounted under
  // its id would sit at a path the prompt never declared.
  let storeName = mount.name;
  if (storeName === null) {
    if (lookupName === undefined) throw new Error(`Memory Store ${mount.storeId} requires a metadata lookup Port`);
    try {
      storeName = await lookupName(mount.storeId);
    } catch (err) {
      throw new Error(`Memory Store ${mount.storeId} metadata lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!storeName) throw new Error(`Memory Store ${mount.storeId} was not found`);
  }
  await sandbox.mountMemoryStore!({ storeName, storeId: mount.mountStoreId, readOnly: mount.readOnly });
  await sandbox.setEnvVars?.({
    OMA_MEMORY_DIR: "/mnt/memory",
    [`OMA_MEMORY_${storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]: mount.mountPath ?? `/mnt/memory/${storeName}`,
  });
}

export async function mountSessionResources(
  sandbox: SessionResourceSandbox,
  records: readonly SessionResourceRecord[],
  ports: SessionResourceMountPorts,
): Promise<void> {
  const mounts = planSessionResourceMounts(records);
  preflight(sandbox, mounts, ports);
  const repositories = mounts.filter((mount): mount is RepositoryMount => mount.type === "github_repository");
  if (repositories.length > 0) await ports.repositories.prepare(repositories);
  const env: Record<string, string> = {};
  for (const mount of mounts) {
    switch (mount.type) {
      case "file":
        await sandbox.writeFileBytes!(mount.mountPath, await ports.downloadFile!(mount.fileId));
        break;
      case "github_repository":
        await checkoutRepository(sandbox, mount);
        break;
      case "memory_store":
        if (ports.memoryStores.mode === "native") await mountMemoryStore(sandbox, mount, ports.memoryStores.lookupName);
        break;
      case "env":
        env[mount.name] = ports.envSecrets!.get(mount.id)!;
        break;
    }
  }
  if (Object.keys(env).length > 0) await sandbox.setEnvVars!(env);
  if (repositories.length > 0) await ports.afterRepositories?.();
}
