// One environment snapshot build (design §0.1 step 1): a throwaway build
// sandbox (same adapter and image as a Session sandbox; no Session inputs,
// Vault, Memory, outputs or egress token) has its egress restricted to public
// package sources, runs only the setup, the adapter snapshots it and the
// sandbox is released. Never rejects: every outcome is
// logged and returned, and the build sandbox is released on success, failure,
// deadline and shutdown alike. A failure records nothing, so the next Session
// tries again.

import type { Acquired, EnvironmentSnapshotRef, SandboxLifecyclePort, SandboxPlan } from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;

/** The cache's records (one workspace). */
export interface EnvironmentCacheStore {
  get(key: string): Promise<string | null>;
  /** One bounded page of retired-only keys; opaque cursor from the same store. */
  retiredKeys(prefix: string, cursor: string, limit: number): Promise<{ keys: string[]; cursor: string }>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomic exact-document CAS; null expected/value means absent/delete. */
  compareAndSwap(key: string, expected: string | null, value: string | null): Promise<boolean>;
}

export interface EnvironmentCacheLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface EnvironmentCacheEntry {
  state: "ready";
  snapshot: EnvironmentSnapshotRef;
  createdAtMs: number;
  lastUsedAtMs?: number;
  /** Expired or replaced snapshots whose delete failed (a provider may refuse
   * while sandboxes started from them still exist); retried, never dropped. */
  retired?: EnvironmentSnapshotRef[];
}

/** A record with no usable snapshot, kept only for its retired ones. */
export interface EnvironmentCacheRetiredRecord {
  state: "retired";
  retired: EnvironmentSnapshotRef[];
}

export interface EnvironmentSnapshotBuildContext<R, Q> {
  lifecycle: SandboxLifecyclePort<R>;
  /** Limit the build sandbox's egress to public package sources; a failure fails the build. */
  restrictEgress(runtime: R, setup: Q): Promise<void>;
  /** Run only the Environment setup on the build sandbox. */
  setup(runtime: R, setup: Q, input: { buildId: string }): Promise<void>;
  logger: EnvironmentCacheLogger;
  now(): number;
  errorText(error: unknown): string;
  buildTimeoutMs: number | undefined;
  /** In-flight builds by local key; dispose() aborts them. */
  aborts: Map<string, () => void>;
  /** Build sandboxes still being acquired (dispose() waits for them, bounded). */
  steps: Set<Promise<unknown>>;
  /** Delete an unpublished result or retain it in the existing retired record. */
  cleanup(store: EnvironmentCacheStore, storeKey: string, snapshot: EnvironmentSnapshotRef, fields: Record<string, unknown>): Promise<void>;
  /** The record's retired snapshots now, after a delete attempt; the build carries the survivors. */
  retired(store: EnvironmentCacheStore, storeKey: string): Promise<EnvironmentSnapshotRef[]>;
}

export type EnvironmentSnapshotBuildOutcome =
  | { outcome: "built" }
  | { outcome: "failed"; error: string }
  | { outcome: "aborted" };

class BuildAborted extends Error {}

export async function buildEnvironmentSnapshot<R, Q>(
  context: EnvironmentSnapshotBuildContext<R, Q>,
  input: { expected: string | null; store: EnvironmentCacheStore; storeKey: string; local: string; fields: Record<string, unknown>; scope: RuntimeResourceScope; plan: SandboxPlan; setup: Q },
): Promise<EnvironmentSnapshotBuildOutcome> {
  const { lifecycle, logger } = context;
  const startMs = context.now();
  const fields = input.fields;
  logger.info({ ...fields, path: "build_started" }, "Environment snapshot build started");
  const buildId = "env_snapshot_" + crypto.randomUUID();
  const scope: RuntimeResourceScope = { ...input.scope, sessionId: buildId, workId: buildId };
  const plan: SandboxPlan = {
    ...input.plan, egress: null, stores: [],
    outputs: { bindingId: "outputs:" + buildId, mountPath: "/mnt/session/outputs" },
    labels: { workspaceId: input.scope.workspaceId, sessionId: buildId },
  };
  const controller = new AbortController();
  let aborted: Error | undefined;
  let abortBuild!: (error: Error) => void;
  const abortedPromise = new Promise<never>((_, reject) => {
    abortBuild = (error) => { aborted ??= error; controller.abort(error); reject(error); };
  });
  void abortedPromise.catch(() => undefined);
  context.aborts.set(input.local, () => abortBuild(new BuildAborted("environment snapshot build aborted by shutdown")));
  const timeoutMs = context.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const timer = setTimeout(() => abortBuild(new Error("environment snapshot build exceeded its " + timeoutMs + " ms deadline")), timeoutMs);

  let builder: Acquired<R> | undefined;
  let unpublished: EnvironmentSnapshotRef | undefined;
  let publicationUncertain = false;
  const cleanup = async (snapshot: EnvironmentSnapshotRef, publicationUncertain = false) => {
    try {
      // Only a failed CAS response can mean a committed winner. A late result
      // or explicit CAS loser was never published: deletion needs no DB read.
      if (publicationUncertain) {
        const raw = await input.store.get(input.storeKey);
        if (raw !== null && (JSON.parse(raw) as EnvironmentCacheEntry).snapshot?.ref === snapshot.ref) return;
      }
      await context.cleanup(input.store, input.storeKey, snapshot, fields);
    } catch (error) {
      // Provider and DB cannot transact atomically. The E2B provider snapshot
      // name (oma-env-<builder runtime id>) and build labels remain the recovery
      // evidence if neither deletion nor persistence is available.
      logger.warn({ ...fields, path: "snapshot_cleanup_unrecorded", buildId, builder: builder?.handle.runtimeId, snapshotRef: snapshot.ref, error: context.errorText(error) }, "Snapshot cleanup could not be durably recorded; provider reconciliation is required");
    }
  };
  const release = async (target: Acquired<R>) => {
    await lifecycle.release({ scope, handle: target.handle }).catch((error: unknown) => {
      logger.warn({ ...fields, path: "build_cleanup_failed", error: context.errorText(error) }, "Releasing the environment snapshot build sandbox failed");
    });
  };
  // Only the acquire can outlive the race with nothing to release it;
  // dispose() waits for this phase (bounded), not for the whole setup.
  let acquireDone!: () => void;
  const acquiring = new Promise<void>((resolve) => { acquireDone = resolve; });
  context.steps.add(acquiring);
  void acquiring.finally(() => context.steps.delete(acquiring));
  const steps = (async (): Promise<EnvironmentSnapshotRef> => {
    let acquired: Acquired<R> | "gone";
    try {
      acquired = await lifecycle.acquire({ scope, plan, signal: controller.signal });
      if (acquired === "gone") throw new Error("Build sandbox source " + JSON.stringify(plan.from) + " was not found");
      if (aborted !== undefined) { await release(acquired); throw aborted; }
      builder = acquired;
    } finally {
      acquireDone();
    }
    await context.restrictEgress(acquired.runtime, input.setup);
    if (aborted !== undefined) throw aborted;
    await context.setup(acquired.runtime, input.setup, { buildId });
    if (aborted !== undefined) throw aborted;
    const snapshot = await lifecycle.snapshotEnvironment!({ runtime: acquired.runtime, handle: acquired.handle, signal: controller.signal });
    // Finished after the deadline or shutdown settled the build: nobody records it.
    if (aborted !== undefined) {
      await cleanup(snapshot);
      throw aborted;
    }
    return snapshot;
  })();
  void steps.catch(() => undefined);
  try {
    const snapshot = await Promise.race([steps, abortedPromise]);
    unpublished = snapshot;
    const retired = await context.retired(input.store, input.storeKey);
    const record = JSON.stringify({
      state: "ready", snapshot, createdAtMs: context.now(), ...(retired.length === 0 ? {} : { retired }),
    } satisfies EnvironmentCacheEntry);
    publicationUncertain = true;
    const published = await input.store.compareAndSwap(input.storeKey, input.expected, record);
    publicationUncertain = false;
    if (!published) {
      await cleanup(snapshot);
      unpublished = undefined;
      return { outcome: "aborted" };
    }
    unpublished = undefined;
    logger.info({ ...fields, path: "build_ok", snapshotRef: snapshot.ref, durationMs: context.now() - startMs }, "Environment snapshot built");
    return { outcome: "built" };
  } catch (error) {
    if (unpublished !== undefined) await cleanup(unpublished, publicationUncertain);
    const text = context.errorText(error);
    if (error instanceof BuildAborted) {
      logger.warn({ ...fields, path: "build_failed", reason: "shutdown", error: text, durationMs: context.now() - startMs }, "Environment snapshot build aborted by shutdown");
      return { outcome: "aborted" };
    }
    logger.warn({ ...fields, path: "build_failed", error: text, durationMs: context.now() - startMs }, "Building the environment snapshot failed");
    return { outcome: "failed", error: text };
  } finally {
    clearTimeout(timer);
    context.aborts.delete(input.local);
    if (builder !== undefined) await release(builder);
  }
}
