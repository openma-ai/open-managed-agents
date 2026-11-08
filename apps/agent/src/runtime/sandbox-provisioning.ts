import type {
  OmaMountBucketRequest,
  OmaProvisionResult,
  OmaSandboxDescription,
} from "../oma-sandbox";
import { memoryStoreMountTarget } from "./resource-mounter";

/** A sandbox whose container starts with its complete mount set.
 * Sandbox SDK 1.0 attaches mounts only while a container starts: a mount
 * after the catch-all outbound intercept never receives its traffic. */
export interface ProvisionableSandbox {
  describeSandbox(): Promise<OmaSandboxDescription>;
  provisionSandbox(input: {
    incarnation: string;
    mounts: OmaMountBucketRequest[];
    autoStart?: boolean;
  }): Promise<OmaProvisionResult>;
  sessionOutputsMount(opts: { tenantId: string; sessionId: string }): OmaMountBucketRequest | null;
  memoryStoreMount(opts: { storeName: string; storeId: string; readOnly: boolean }): OmaMountBucketRequest;
  destroy(): Promise<void>;
}

export function supportsSandboxProvisioning(sandbox: unknown): sandbox is ProvisionableSandbox {
  const candidate = sandbox as Partial<Record<keyof ProvisionableSandbox, unknown>> | null;
  return typeof candidate?.describeSandbox === "function"
    && typeof candidate.provisionSandbox === "function"
    && typeof candidate.sessionOutputsMount === "function"
    && typeof candidate.memoryStoreMount === "function"
    && typeof candidate.destroy === "function";
}

export interface ProvisionedSessionSandbox<Resources> {
  incarnation: string;
  /** true when this warmup started a new container. */
  started: boolean;
  resources: Resources | null;
  /** Memory mount paths the running container did not start with. */
  deferredMounts: string[];
}

export function newSandboxIncarnation(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * Describe → plan → provision. The incarnation is chosen before resources
 * load because a writable Memory Store mount is private to one container
 * incarnation (its prefix derives from it).
 */
export async function provisionSessionSandbox<
  Resources extends { resources: ReadonlyArray<Record<string, unknown>> },
>(input: {
  sandbox: ProvisionableSandbox;
  tenantId: string | null;
  sessionId: string | null;
  loadResources: ((runtimeGeneration: string) => Promise<Resources>) | null;
  mintIncarnation?: () => string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ProvisionedSessionSandbox<Resources>> {
  const mint = input.mintIncarnation ?? newSandboxIncarnation;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = input.attempts ?? 3;
  for (let round = 0; ; round += 1) {
    const description = await input.sandbox.describeSandbox();
    const incarnation = description.running && description.incarnation !== null
      ? description.incarnation
      : mint();
    const required: OmaMountBucketRequest[] = [];
    if (input.tenantId && input.sessionId) {
      const outputs = input.sandbox.sessionOutputsMount({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
      });
      if (outputs !== null) required.push(outputs);
    }
    const resources = input.loadResources === null ? null : await input.loadResources(incarnation);
    const memory: OmaMountBucketRequest[] = [];
    for (const resource of resources?.resources ?? []) {
      if (resource.type !== "memory_store") continue;
      const target = memoryStoreMountTarget(resource);
      // An unnamed store fails later with the resource mounter's own error.
      if (target !== null) memory.push(input.sandbox.memoryStoreMount(target));
    }
    const result = await provisionWithRetry(
      input.sandbox,
      { incarnation, mounts: [...required, ...memory] },
      attempts,
      sleep,
    );
    const missingRequired = required
      .filter((mount) => result.pendingMounts.includes(mount.mountPath))
      .map((mount) => mount.mountPath);
    const stale = result.incarnation !== incarnation;
    if ((missingRequired.length > 0 || stale) && round === 0) {
      // The running container lacks a mount this Session needs, or a new
      // container appeared since describe(); start over with a fresh one.
      if (missingRequired.length > 0) await input.sandbox.destroy();
      continue;
    }
    if (missingRequired.length > 0) {
      throw new Error(`Sandbox container started without required mounts: ${missingRequired.join(", ")}`);
    }
    if (stale) {
      throw new Error("Sandbox container changed while it was being provisioned");
    }
    return {
      incarnation: result.incarnation,
      started: result.started,
      resources,
      deferredMounts: result.pendingMounts,
    };
  }
}

async function provisionWithRetry(
  sandbox: ProvisionableSandbox,
  request: { incarnation: string; mounts: OmaMountBucketRequest[] },
  attempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<OmaProvisionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await sandbox.provisionSandbox(request);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(Math.min(1000 * 2 ** attempt, 5000));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Sandbox container failed to start after ${attempts} attempts. Last error: ${message}`);
}

/** Drops Memory Store resources whose mount the running container lacks:
 * Sandbox SDK 1.0 cannot add a mount to a running container. They mount
 * when the next container starts. */
export function withoutDeferredMemoryMounts<Resource extends Record<string, unknown>>(
  resources: readonly Resource[],
  deferredMounts: readonly string[],
): { resources: Resource[]; deferredStores: string[] } {
  if (deferredMounts.length === 0) return { resources: [...resources], deferredStores: [] };
  const kept: Resource[] = [];
  const deferredStores: string[] = [];
  for (const resource of resources) {
    const target = resource.type === "memory_store" ? memoryStoreMountTarget(resource) : null;
    if (target !== null && deferredMounts.includes(`/mnt/memory/${target.storeName}`)) {
      deferredStores.push(target.storeName);
      continue;
    }
    kept.push(resource);
  }
  return { resources: kept, deferredStores };
}
