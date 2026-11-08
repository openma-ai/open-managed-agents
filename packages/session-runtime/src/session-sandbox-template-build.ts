// One template build (design §0.1 step 1): a throwaway builder sandbox
// (same provider, image and scope as a Session sandbox; no Session inputs,
// Vault, Memory or outputs) runs only the setup and the provider snapshots
// it. Never rejects: every outcome is recorded and logged, and the builder
// is destroyed on success, failure, deadline and shutdown alike.

import type { TemplateEntry, TemplateHandle, TemplateLogger } from "./session-sandbox-template-cache";

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;

/** The template store (one workspace). */
export interface TemplateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What the host does for a build. */
export interface TemplateBuilder<S, H extends TemplateHandle> {
  /** Create the builder sandbox; `scope` is the request's builderScope. */
  create(scope: unknown): Promise<S>;
  /** Run only the setup, then (unless `aborted()` by then) snapshot it into
   * a template named for (workspaceId, key). */
  capture(sandbox: S, request: unknown, input: { workspaceId: string; key: string; aborted(): boolean }): Promise<H>;
  destroy(sandbox: S): Promise<void>;
}

export interface TemplateBuildContext<S, H extends TemplateHandle> {
  builder: TemplateBuilder<S, H>;
  logger: TemplateLogger;
  now(): number;
  errorText(error: unknown): string;
  write(store: TemplateStore, key: string, entry: TemplateEntry<H>, fields: Record<string, unknown>): Promise<void>;
  buildTimeoutMs: number | undefined;
  /** In-flight builds by local key; dispose() aborts them. */
  aborts: Map<string, (reason: "shutdown") => void>;
  /** Builder creations still pending (dispose() waits for them, bounded). */
  steps: Set<Promise<unknown>>;
}

class BuildAborted extends Error {}

export async function buildTemplate<S, H extends TemplateHandle>(
  context: TemplateBuildContext<S, H>,
  input: { store: TemplateStore; storeKey: string; local: string; key: string; fields: Record<string, unknown>; workspaceId: string; request: { builderScope: unknown } },
): Promise<"built" | "failed" | "aborted"> {
  const startMs = context.now();
  const fields = { ...input.fields, key: input.key };
  let builder: S | undefined;
  let aborted: Error | undefined;
  let abortBuild!: (error: Error) => void;
  const abortedPromise = new Promise<never>((_, reject) => {
    abortBuild = (error) => {
      aborted ??= error;
      reject(error);
    };
  });
  void abortedPromise.catch(() => undefined);
  context.aborts.set(input.local, () => abortBuild(new BuildAborted("prepared-base build aborted by shutdown")));
  const timeoutMs = context.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const timer = setTimeout(() => abortBuild(new Error(`prepared-base build exceeded its ${timeoutMs} ms deadline`)), timeoutMs);
  const destroy = async (sandbox: S) => {
    await Promise.resolve()
      .then(() => context.builder.destroy(sandbox))
      .catch((error: unknown) => {
        context.logger.warn({ ...fields, path: "build_cleanup_failed", error: context.errorText(error) }, "Destroying the prepared-base builder sandbox failed");
      });
  };
  // Only the builder creation can outlive the race with nothing to destroy
  // it; dispose() waits for this phase (bounded), not for the whole setup.
  let creationDone!: () => void;
  const creation = new Promise<void>((resolve) => { creationDone = resolve; });
  context.steps.add(creation);
  void creation.finally(() => context.steps.delete(creation));
  const steps = (async () => {
    let created: S;
    try {
      created = await context.builder.create(input.request.builderScope);
      if (aborted !== undefined) {
        // Created after the deadline/shutdown already settled the build.
        await destroy(created);
        throw aborted;
      }
      builder = created;
    } finally {
      creationDone();
    }
    return context.builder.capture(created, input.request, { workspaceId: input.workspaceId, key: input.key, aborted: () => aborted !== undefined });
  })();
  void steps.catch(() => undefined);
  try {
    const handle = await Promise.race([steps, abortedPromise]);
    await input.store.put(input.storeKey, JSON.stringify({ state: "ready", handle, createdAtMs: context.now() } satisfies TemplateEntry<H>));
    context.logger.info({ ...fields, path: "build_ok", baseId: handle.id, durationMs: context.now() - startMs }, "Prepared sandbox base built");
    return "built";
  } catch (error) {
    const text = context.errorText(error);
    if (error instanceof BuildAborted) {
      // Shutdown is not a setup failure: nothing is recorded for other replicas.
      context.logger.warn({ ...fields, path: "build_failed", reason: "shutdown", error: text, durationMs: context.now() - startMs }, "Prepared sandbox base build aborted by shutdown");
      return "aborted";
    }
    context.logger.warn({ ...fields, path: "build_failed", error: text, durationMs: context.now() - startMs }, "Building the prepared sandbox base failed");
    await context.write(input.store, input.storeKey, { state: "failed", error: text, failedAtMs: context.now() }, fields);
    return "failed";
  } finally {
    clearTimeout(timer);
    context.aborts.delete(input.local);
    if (builder !== undefined) await destroy(builder);
  }
}
