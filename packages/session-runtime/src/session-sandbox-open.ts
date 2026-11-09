// Opening the Session's sandbox (design §0.1 steps 2-3, §0.0 rule 11),
// lazily on first use or prepare(), single-flight:
//   1. attach the saved handle (reuse; a paused one wakes); its
//      /tmp/.oma-warm marker is the generation (the private Memory runtime
//      generation and the recycle probe value);
//   2. otherwise mint a generation and plan, then: resume the pause point
//      (kind "self") -> start a new sandbox from the latest snapshot (the
//      host's published one, else the handle record's) -> with neither,
//      acquire a new sandbox only when nothing ever ran in this Session's
//      sandbox. A snapshot that cannot be started, or a Session that needs
//      one and has none, is a SandboxRestoreError, never a silent empty
//      sandbox. A "changes" handle is recorded before anything else, and
//      only while this owner holds the fence;
//   3. egress.attach, then storage.attach, then the marker for a new sandbox.
// Every record write is a compare-and-set against the version this open
// read (design §0.0b A.10): when another writer won, this open's result is
// dropped, a sandbox it started is released (not one the record names) and
// SessionSandboxStateConflictError is thrown. A failed step rolls back what
// this open did (egress.revoke, forget the handle, release) and the error
// is thrown.
// warmSandbox (Session creation, design §0.0 rule 10): only step 2 plus the
// marker and the handle record; no egress token and no storage. The first
// open attaches it; a sandbox the provider reclaimed meanwhile is "gone"
// there and acquired again, so only the warm-up is lost.

import { parseExecResult, type Acquired, type ResumeRef, type SandboxPlan } from "@open-managed-agents/sandbox";
import { SessionSandboxFenceLostError } from "./session-sandbox-fence";
import { disarmIdle } from "./session-sandbox-idle-pause";
import { mergeStores, restorePoints, sameHandle, sameRef, SessionSandboxStateConflictError, stateVersion, type LiveSessionSandbox, type OpenSandbox } from "./session-sandbox-live";
import type { SessionSandboxExecutor, SessionSandboxState } from "./session-sandbox-options";
import { attachEgress, attachStorage } from "./session-sandbox-storage-egress";

export const SANDBOX_GENERATION_MARKER = "/tmp/.oma-warm";

/** The Session's sandbox is gone and cannot be restored: its latest snapshot
 * failed to start, or something ran in it and there is no snapshot at all.
 * The execution fails; nothing starts empty in its place. */
export class SandboxRestoreError extends Error {
  override readonly name = "SandboxRestoreError";
}

/** The open sandbox; opens it (attach, else resume, else acquire) when there is none. */
export async function openSandbox<R>(state: LiveSessionSandbox<R>): Promise<OpenSandbox<R>> {
  await state.quiesce();
  // An execution takes the sandbox back from the idle window (design §0.0b A.10).
  if (state.execution() !== undefined && state.idleSince !== null) await disarmIdle(state);
  await state.warming?.catch(() => undefined);
  if (state.current !== null) return state.current;
  return state.opening ??= start(state).finally(() => { state.opening = null; });
}

/** Undo an open: revoke egress, forget the handle (and the pause point it
 * came from) when the record names it, release the sandbox. A writer that
 * changed the record meanwhile keeps it: nothing is released. */
export async function rollbackOpen<R>(state: LiveSessionSandbox<R>, opened: Pick<OpenSandbox<R>, "runtime" | "handle">): Promise<void> {
  state.current = null;
  const { ports } = await state.compose();
  const scope = state.scope();
  await ports.egress.revoke({ runtime: opened.runtime, scope, fence: state.fence(scope), reason: "failed" }).catch(() => undefined);
  const saved = await state.options.state.load().catch(() => undefined);
  if (saved !== undefined && sameHandle(saved.handle, opened.handle)) {
    const { handle: _forgotten, resumeRef: _gone, ...rest } = saved;
    if (!await state.commit(rest, stateVersion(saved)).catch(() => false)) return;
  }
  await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
}

function conflict(what: string): SessionSandboxStateConflictError {
  return new SessionSandboxStateConflictError(`Another writer changed the Session sandbox record while ${what}`);
}

async function start<R>(state: LiveSessionSandbox<R>): Promise<OpenSandbox<R>> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const signal = new AbortController().signal;
  const saved = await state.options.state.load();
  // The version every write of this open compares against.
  let version = stateVersion(saved);
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
  // The restore points the new record keeps; a pause point that was not the
  // one resumed names a sandbox that is gone.
  let points = restorePoints(saved);
  let plan: SandboxPlan;
  try {
    plan = await state.options.plan({ scope, generation, stores: state.stores });
    state.stores = mergeStores(plan.stores, state.stores);
    if (opened === "gone") {
      const restored = await restore(state, saved, plan, signal);
      if (restored.from === undefined || !sameRef(restored.from, saved?.resumeRef)) {
        const { resumeRef: _stale, ...rest } = points;
        points = rest;
      }
      opened = restored.opened;
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
        if (!await state.commit({ handle: opened.handle, stores: state.stores, outputs: state.outputs, runStartedAt, ...points }, version)) {
          const lost = opened;
          opened = "gone";
          await state.releaseOwn(lost.handle);
          throw conflict("its sandbox was opened");
        }
        version += 1;
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
    // The tool-call-gap snapshot interval counts from the first open.
    if (state.snapshotAt === 0) state.snapshotAt = state.now();
    if (!reused) await writeMarker(open.executor, generation);
    if (!await state.commit({ handle: open.handle, stores: state.stores, outputs: state.outputs, runStartedAt, ...points }, version)) {
      throw conflict("its sandbox was opened");
    }
  } catch (error) {
    if (!(error instanceof SessionSandboxStateConflictError)) {
      await rollbackOpen(state, open);
      throw error;
    }
    // Lost the record: drop this open; a sandbox it started is cleaned up.
    state.current = null;
    await ports.egress.revoke({ runtime: open.runtime, scope, fence: state.fence(scope), reason: "failed" }).catch(() => undefined);
    if (!reused) await state.releaseOwn(open.handle);
    throw error;
  }
  state.current = open;
  return open;
}

/** The handle is gone (design §0.0 rule 11): the pause point, then the
 * latest snapshot. { opened: "gone" } = nothing to restore from and nothing
 * that needs it: the caller acquires a new sandbox. */
async function restore<R>(
  state: LiveSessionSandbox<R>,
  saved: SessionSandboxState | undefined,
  plan: SandboxPlan,
  signal: AbortSignal,
): Promise<{ opened: Acquired<R> | "gone"; from?: ResumeRef }> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const snapshot = (await state.options.resumeRef()) ?? saved?.snapshotRef;
  const candidates: ResumeRef[] = [];
  if (saved?.resumeRef !== undefined) candidates.push(saved.resumeRef);
  if (snapshot !== undefined && !sameRef(snapshot, saved?.resumeRef)) candidates.push(snapshot);
  for (const ref of candidates) {
    const started = state.now();
    const opened = await ports.sandbox.resume({ scope, ref, plan, signal });
    if (opened !== "gone") {
      state.options.warn(`workspace_restored ref=${ref.ref} kind=${ref.kind} elapsed_ms=${state.now() - started}`);
      return { opened, from: ref };
    }
    state.options.warn(`workspace_restore_failed ref=${ref.ref} kind=${ref.kind} elapsed_ms=${state.now() - started} error=gone`);
  }
  const tried = candidates.find((ref) => ref.kind === "snapshot");
  if (tried !== undefined) {
    throw new SandboxRestoreError(`The Session's sandbox is gone and its latest snapshot ${tried.ref} could not be started`);
  }
  if (saved?.restoreRequired === true) {
    throw new SandboxRestoreError("The Session's sandbox is gone and there is no snapshot to start it from");
  }
  return { opened: "gone" };
}

/** Acquire the Session's sandbox ahead of its first execution, once. A
 * recorded sandbox that is still there is kept; nothing is opened. */
export function warmSandbox<R>(state: LiveSessionSandbox<R>): Promise<void> {
  if (state.current !== null || state.opening !== null) return Promise.resolve();
  return state.warming ??= warm(state).finally(() => { state.warming = null; });
}

async function warm<R>(state: LiveSessionSandbox<R>): Promise<void> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const signal = new AbortController().signal;
  const saved = await state.options.state.load();
  const version = stateVersion(saved);
  if (saved?.handle !== undefined) {
    const attached = await ports.sandbox.attach({ scope, handle: saved.handle, signal });
    if (attached !== "gone" && await readMarker(state.options.executor(attached.runtime)) !== null) return;
  }
  // A sandbox that must be restored is left to the first open (restore).
  if (saved?.restoreRequired === true || saved?.snapshotRef !== undefined) return;
  // The fence first (design §0.0 rule 10), then acquire and record the handle.
  if (!await state.isCurrent(state.execution())) return;
  const generation = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const plan = await state.options.plan({ scope, generation, stores: state.stores });
  const acquired = await ports.sandbox.acquire({ scope, plan, signal });
  if (acquired === "gone") throw new Error(`Sandbox source ${JSON.stringify(plan.from)} was not found`);
  try {
    if (ports.sandbox.handle === "changes" && !await state.isCurrent(state.execution())) {
      throw new SessionSandboxFenceLostError("The Session execution fence was lost while its sandbox was warmed");
    }
    await writeMarker(state.options.executor(acquired.runtime), generation);
    if (!await state.commit({ handle: acquired.handle, stores: mergeStores(plan.stores, state.stores), outputs: state.outputs, runStartedAt: state.now() }, version)) {
      throw conflict("its sandbox was warmed");
    }
  } catch (error) {
    await state.releaseOwn(acquired.handle);
    throw error;
  }
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
