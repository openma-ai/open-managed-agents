// Opening the Session's sandbox (design §0.1 steps 2-3), lazily on first
// use or prepare(), single-flight:
//   1. attach the saved handle; its /tmp/.oma-warm marker is the generation
//      (the private Memory runtime generation and the recycle probe value);
//   2. otherwise mint a generation, plan, resume from the recorded or the
//      latest published ref, else acquire; a "changes" handle is recorded
//      before anything else, and only while this owner holds the fence;
//   3. egress.attach, then storage.attach, then the marker for a new sandbox.
// A failed step rolls back what this open did (egress.revoke, release,
// forget the handle) and the error is thrown.

import { parseExecResult, type Acquired, type SandboxPlan } from "@open-managed-agents/sandbox";
import { SessionSandboxFenceLostError } from "./session-sandbox-fence";
import { mergeStores, type LiveSessionSandbox, type OpenSandbox } from "./session-sandbox-live";
import type { SessionSandboxExecutor } from "./session-sandbox-options";
import { attachEgress, attachStorage } from "./session-sandbox-storage-egress";

export const SANDBOX_GENERATION_MARKER = "/tmp/.oma-warm";

/** The open sandbox; opens it (attach, else resume, else acquire) when there is none. */
export async function openSandbox<R>(state: LiveSessionSandbox<R>): Promise<OpenSandbox<R>> {
  await state.quiesce();
  if (state.current !== null) return state.current;
  return state.opening ??= start(state).finally(() => { state.opening = null; });
}

/** Undo an open: revoke egress, release the sandbox, forget the handle. */
export async function rollbackOpen<R>(state: LiveSessionSandbox<R>, opened: Pick<OpenSandbox<R>, "runtime" | "handle">): Promise<void> {
  state.current = null;
  const { ports } = await state.compose();
  const scope = state.scope();
  await ports.egress.revoke({ runtime: opened.runtime, scope, fence: state.fence(scope), reason: "failed" }).catch(() => undefined);
  await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
  await state.options.state.clear().catch(() => undefined);
}

async function start<R>(state: LiveSessionSandbox<R>): Promise<OpenSandbox<R>> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const signal = new AbortController().signal;
  const saved = await state.options.state.load();
  if (saved !== undefined) {
    state.stores = mergeStores(saved.stores, state.stores);
    state.outputs ||= saved.outputs;
  }
  // Held by this open; released if a later step fails.
  let opened: Acquired<R> | "gone" = "gone";
  let generation = "";
  if (saved?.handle !== undefined) {
    opened = await ports.sandbox.attach({ scope, handle: saved.handle, signal });
    const marker = opened === "gone" ? null : await readMarker(state.options.executor(opened.runtime));
    if (marker === null) {
      opened = "gone";
      // A "fixed" handle is reused by the next acquire; a provider-assigned one would be orphaned.
      if (ports.sandbox.handle === "changes") await ports.sandbox.release({ scope, handle: saved.handle }).catch(() => undefined);
    } else {
      generation = marker;
    }
  }
  const reused = opened !== "gone";
  if (!reused) generation = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  // An attached sandbox may have kept running: keep the recorded start
  // (unknown = due); one the idle pause stopped wakes now. A resumed or
  // new one starts a run now.
  let runStartedAt = reused ? (saved?.paused === true ? state.now() : saved?.runStartedAt ?? 0) : 0;
  const execution = state.execution();
  let plan: SandboxPlan;
  try {
    plan = await state.options.plan({ scope, generation, stores: state.stores });
    state.stores = mergeStores(plan.stores, state.stores);
    if (opened === "gone") {
      const ref = saved?.resumeRef ?? await state.options.resumeRef();
      if (ref !== null) {
        const started = Date.now();
        opened = await ports.sandbox.resume({ scope, ref, plan, signal });
        state.options.warn(opened === "gone"
          ? `workspace_restore_failed backup_id=${ref.ref} elapsed_ms=${Date.now() - started} error=gone`
          : `workspace_restored backup_id=${ref.ref} elapsed_ms=${Date.now() - started}`);
      }
      if (opened === "gone") opened = await ports.sandbox.acquire({ scope, plan, signal });
      if (opened === "gone") throw new Error(`Sandbox source ${JSON.stringify(plan.from)} was not found`);
      runStartedAt = state.now();
      // A provider-assigned handle is recorded before the sandbox is used,
      // and only while this owner holds the fence: otherwise nobody would
      // know this sandbox, so it is released (design §0.1 step 2).
      if (ports.sandbox.handle === "changes") {
        if (!await state.isCurrent(execution)) {
          await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
          opened = "gone";
          state.abandon();
          throw new SessionSandboxFenceLostError("The Session execution fence was lost while its sandbox was opened");
        }
        await state.options.state.save({ handle: opened.handle, stores: state.stores, outputs: state.outputs, runStartedAt, ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }) });
      }
    }
  } catch (error) {
    if (opened !== "gone") await rollbackOpen(state, opened);
    throw error;
  }
  const open: OpenSandbox<R> = { ...opened, executor: state.options.executor(opened.runtime), generation, plan, runStartedAt };
  try {
    if (Object.keys(state.env).length > 0) await open.executor.setEnvVars(state.env);
    await attachEgress(state, open, plan.egress, state.now(), signal);
    await attachStorage(state, open, signal);
    state.storageSyncedAt = state.now();
    state.keptAliveAt = state.now();
    if (!reused) await writeMarker(open.executor, generation);
    await state.options.state.save({ handle: open.handle, stores: state.stores, outputs: state.outputs, runStartedAt, ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }) });
  } catch (error) {
    await rollbackOpen(state, open);
    throw error;
  }
  state.current = open;
  return open;
}

async function readMarker(executor: SessionSandboxExecutor): Promise<string | null> {
  try {
    const result = parseExecResult(await executor.exec(`cat ${SANDBOX_GENERATION_MARKER} 2>/dev/null`));
    const value = result.exitCode === 0 ? result.stdout.trim() : "";
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeMarker(executor: SessionSandboxExecutor, generation: string): Promise<void> {
  const out = await executor.exec(`echo ${generation} > ${SANDBOX_GENERATION_MARKER}`);
  if (parseExecResult(out).exitCode !== 0) throw new Error(`Writing ${SANDBOX_GENERATION_MARKER} failed: ${out.slice(0, 200)}`);
}
