// Opening the Session's sandbox (design §0.1 steps 2-3, §0.0b A.4), lazily on
// first use or prepare(), single-flight:
//   1. attach the recorded handle (reuse; a paused one wakes); its
//      /tmp/.oma-warm marker is the generation (the private Memory runtime
//      generation and the recycle probe value);
//   2. otherwise mint a generation and plan, then: resume the pause point of a
//      paused sandbox -> start a new sandbox from the latest snapshot (the
//      host's published one, else the record's) -> with neither, typed failure
//      for a previous allocation; only a fresh Session may create initially.
//      A published snapshot that cannot
//      be started is a SandboxRestoreError, never a silent empty sandbox. A
//      "changes" handle is recorded before anything else, and only while this
//      owner holds the fence;
//   3. egress.attach, then storage.attach, then the marker for a new sandbox.
// Each record write is one transition of session-sandbox-state, a
// compare-and-set against the record this open read (design §0.0b A.10, A.11):
// when another writer won, this open's result is dropped, a sandbox it started
// is released (not one the record names) and SessionSandboxStateConflictError
// is thrown. A failed step rolls back what this open did (egress.revoke, the
// lose transition, release) and the error is thrown.
// warmSandbox (Session creation, design §0.0 rule 10): only step 2 plus the
// marker and the handle record; no egress token and no storage. The first
// open attaches it; a sandbox the provider reclaimed meanwhile is "gone"
// there and acquired again, so only the warm-up is lost.

import { parseExecResult, type Acquired, type ResumeRef, type SandboxHandle, type SandboxPlan } from "@open-managed-agents/sandbox";
import { SessionSandboxFenceLostError } from "./session-sandbox-fence";
import { disarmIdle } from "./session-sandbox-idle-pause";
import { errorText, mergeStores, sameHandle, SessionSandboxStateConflictError, type LiveSessionSandbox, type OpenSandbox } from "./session-sandbox-live";
import type { SessionSandboxExecutor } from "./session-sandbox-options";
import { isSnapshotRef, recordedHandle, SessionSandboxTransitionError, type SandboxAction, type SessionSandboxState } from "./session-sandbox-state";
import { attachEgress, attachStorage } from "./session-sandbox-storage-egress";

export const SANDBOX_GENERATION_MARKER = "/tmp/.oma-warm";

/** The Session's sandbox is gone and cannot be restored: its latest snapshot
 * failed to start, or something changed in it and no snapshot could be taken.
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

/** Undo an open: revoke egress, the lose transition when the record names this
 * sandbox, release it. A writer that changed the record meanwhile keeps it:
 * nothing is released. */
export async function rollbackOpen<R>(state: LiveSessionSandbox<R>, opened: Pick<OpenSandbox<R>, "runtime" | "handle">, record: SessionSandboxState, execution = state.execution(), allocatedHere = false): Promise<void> {
  state.current = null;
  const current = async () => {
    if (await state.isCurrent(execution)) return true;
    state.abandon();
    return false;
  };
  if (!await current()) return;
  const { ports } = await state.compose();
  const scope = state.scope();
  await ports.egress.revoke({ runtime: opened.runtime, scope, fence: state.fence(scope), reason: "failed" }).catch(() => undefined);
  if (!await current()) return;
  const saved = await state.load().catch(() => undefined);
  if (!await current()) return;
  // A matching handle is not ownership: another core can advance the same
  // runtime to a newer record while this open is awaiting a failing step.
  if (saved === undefined) return;
  if (saved.version !== record.version) {
    // Only this open can own a newly allocated, provider-assigned handle.
    // An adopted/attached runtime is never cleanup authority. Recheck the
    // durable reference and original execution again at the release boundary.
    if (allocatedHere && !sameHandle(recordedHandle(saved), opened.handle)) await state.releaseOwn(opened.handle, execution);
    return;
  }
  if (sameHandle(recordedHandle(record), opened.handle)) {
    if (await state.apply(record, { type: "lose" }).catch(() => null) === null) return;
  }
  if (!await current()) return;
  if (ports.sandbox.handle === "changes") await state.releaseOwn(opened.handle, execution);
  else await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
}

function conflict(what: string): SessionSandboxStateConflictError {
  return new SessionSandboxStateConflictError(`Another writer changed the Session sandbox record while ${what}`);
}

async function start<R>(state: LiveSessionSandbox<R>): Promise<OpenSandbox<R>> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const signal = new AbortController().signal;
  // The record every write of this open is a compare-and-set against.
  const execution = state.execution();
  const assertCurrent = async () => {
    if (await state.isCurrent(execution)) return;
    state.abandon();
    throw new SessionSandboxFenceLostError("The Session execution fence was lost while its sandbox was opened");
  };
  let record = await state.load();
  // The Session ended: nothing opens, before any provider call.
  if (record.phase === "released") throw new SessionSandboxTransitionError("released", "acquire");
  state.stores = mergeStores(record.stores, state.stores);
  state.outputs ||= record.outputs;
  const initialStores = state.stores;
  const recorded = recordedHandle(record);
  // Held by this open; released if a later step fails.
  let opened: Acquired<R> | "gone" = "gone";
  let generation = "";
  if (recorded !== undefined) {
    opened = await ports.sandbox.attach({ scope, handle: recorded, signal });
    const marker = opened === "gone" ? null : await readMarker(state.options.executor(opened.runtime));
    if (marker === null) {
      opened = "gone";
      // A "fixed" handle is reused by the next acquire; a provider-assigned one would be orphaned.
      if (ports.sandbox.handle === "changes") await ports.sandbox.release({ scope, handle: recorded }).catch(() => undefined);
    } else {
      generation = marker;
    }
  }
  let reused = opened !== "gone";
  if (!reused) generation = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  // An attached sandbox may have kept running: keep the recorded start; one
  // the idle pause stopped wakes now. A resumed or new one starts a run now.
  let runStartedAt = record.phase === "running" ? record.runStartedAt : state.now();
  // The transition this open still has to publish.
  let publish: (handle: SandboxHandle, at: number) => SandboxAction = (handle, at) => ({ type: "attach", handle, at });
  let plan: SandboxPlan;
  try {
    plan = await state.options.plan({ scope, generation, stores: state.stores });
    state.stores = mergeStores(plan.stores, state.stores);
    if (opened === "gone") {
      const started = await startNew(state, record, plan, signal);
      opened = started.opened;
      publish = started.publish;
      state.restored = started.restored;
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
        const next = await state.apply(record, publish(opened.handle, runStartedAt));
        if (next === null) {
          const lost = opened;
          opened = "gone";
          const cleanup = await state.releaseOwn(lost.handle);
          // Only the initial acquire can converge on a completed creation
          // warm-up. Attach once, never retry allocation or overwrite the
          // winner; all later transitions retain their ordinary CAS failure.
          const winner = await state.load();
          if (record.phase !== "none" || winner.phase !== "running" || cleanup === undefined
            || cleanup.before.version !== 1 || winner.version !== cleanup.after.version
            || winner.latestSnapshot.status !== "none" || !await state.isCurrent(execution)) {
            throw conflict("its sandbox was opened");
          }
          const attached = await ports.sandbox.attach({ scope, handle: winner.handle, signal });
          const marker = attached === "gone" ? null : await readMarker(state.options.executor(attached.runtime));
          if (attached === "gone" || marker === null) throw conflict("its sandbox was opened");
          // The winner can change during attach. Do not expose its runtime or
          // perform storage/egress side effects until its identity is stable.
          const confirmed = await state.load();
          if (confirmed.version !== winner.version || confirmed.phase !== "running"
            || !sameHandle(confirmed.handle, winner.handle) || !await state.isCurrent(execution)) {
            throw conflict("its sandbox was opened");
          }
          opened = attached;
          generation = marker;
          runStartedAt = winner.runStartedAt;
          reused = true;
          record = winner;
          // Discard the losing generation's materialized bindings. The
          // winner's persisted mounts and marker define the attach plan.
          state.stores = mergeStores(initialStores, winner.stores);
          state.outputs ||= winner.outputs;
          plan = await state.options.plan({ scope, generation, stores: state.stores });
          await assertCurrent();
          state.stores = mergeStores(plan.stores, winner.stores);
        } else record = next;
        publish = (handle, at) => ({ type: "attach", handle, at });
      }
    }
  } catch (error) {
    if (!await state.isCurrent(execution)) { state.abandon(); throw error; }
    if (opened !== "gone") await rollbackOpen(state, opened, record, execution, !reused);
    throw error;
  }
  const open: OpenSandbox<R> = { ...opened, executor: state.options.executor(opened.runtime), generation, plan, runStartedAt };
  try {
    await assertCurrent();
    if (Object.keys(state.env).length > 0) await open.executor.setEnvVars(state.env);
    await assertCurrent();
    await attachEgress(state, open, plan.egress, state.now(), signal);
    await assertCurrent();
    await attachStorage(state, open, signal);
    await assertCurrent();
    state.storageSyncedAt = state.now();
    state.keptAliveAt = state.now();
    // The tool-call-gap snapshot interval counts from the first open.
    if (state.snapshotAt === 0) state.snapshotAt = state.now();
    if (!reused) await writeMarker(open.executor, generation);
    await assertCurrent();
    let published = await state.apply(record, publish(open.handle, runStartedAt));
    if (published === null) {
      const fresh = await state.load();
      // A losing creation warmer may retire its OWN different handle while
      // our initial open installs storage. Rebase only a proven metadata-only
      // advance, never a same-handle lifecycle writer or an arbitrary version.
      const { version: oldVersion, retiredHandles: oldRetired, ...oldLifecycle } = record;
      const { version: freshVersion, retiredHandles: freshRetired, ...freshLifecycle } = fresh;
      if (record.lifecycleRevision !== undefined && fresh.lifecycleRevision === record.lifecycleRevision
        && freshVersion > oldVersion && JSON.stringify(oldRetired) !== JSON.stringify(freshRetired)
        && JSON.stringify(oldLifecycle) === JSON.stringify(freshLifecycle) && await state.isCurrent(execution)) {
        published = await state.apply(fresh, publish(open.handle, runStartedAt));
      }
    }
    if (published === null) throw conflict("its sandbox was opened");
    await assertCurrent();
  } catch (error) {
    if (!await state.isCurrent(execution)) { state.abandon(); throw error; }
    if (!(error instanceof SessionSandboxStateConflictError)) {
      await rollbackOpen(state, open, record, execution, !reused);
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

/** The handle is gone (design §0.0b A.4): the pause point, then the latest
 * snapshot, then a new sandbox if nothing needs restoring. Says which
 * transition publishes what it started. */
async function startNew<R>(
  state: LiveSessionSandbox<R>,
  record: SessionSandboxState,
  plan: SandboxPlan,
  signal: AbortSignal,
): Promise<{ opened: Acquired<R>; restored: boolean; publish(handle: SandboxHandle, at: number): SandboxAction }> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const tryResume = async (ref: ResumeRef): Promise<Acquired<R> | "gone"> => {
    const started = state.now();
    const opened = await ports.sandbox.resume({ scope, ref, plan, signal });
    if (opened !== "gone") state.options.warn(`workspace_restored ref=${ref.ref} kind=${ref.kind} elapsed_ms=${state.now() - started}`);
    else state.options.warn(`workspace_restore_failed ref=${ref.ref} kind=${ref.kind} elapsed_ms=${state.now() - started} error=gone`);
    return opened;
  };
  // The record no longer names a sandbox (only while this owner holds the Session).
  const giveUp = async () => {
    if (record.phase !== "running" && record.phase !== "paused") return;
    if (await state.isCurrent(state.execution()).catch(() => false)) await state.apply(record, { type: "lose" }).catch(() => null);
  };
  // A pause in place is gone with the sandbox; one that is a snapshot is the
  // latest snapshot (or older than the host's), tried below.
  if ("pauseRef" in record && record.pauseRef !== undefined && !isSnapshotRef(record.pauseRef)) {
    const resumed = await tryResume(record.pauseRef).catch((error) => {
      state.options.warn(`workspace_restore_failed ref=${record.pauseRef!.ref} kind=${record.pauseRef!.kind} error=${errorText(error)}`);
      return "gone" as const;
    });
    if (resumed !== "gone") return { opened: resumed, restored: false, publish: (handle, at) => ({ type: "resume", handle, at }) };
  }
  const snapshot = (await state.options.resumeRef()) ?? (record.latestSnapshot.status === "taken" ? record.latestSnapshot.ref : null);
  if (snapshot !== null) {
    const restored = await tryResume(snapshot).catch((error) => {
      throw new SandboxRestoreError(`The Session latest snapshot ${snapshot.ref} could not be started: ${errorText(error)}`, { cause: error });
    });
    if (restored !== "gone") return { opened: restored, restored: true, publish: (handle, at) => ({ type: "restoreFromSnapshot", handle, at, ref: snapshot }) };
    await giveUp();
    throw new SandboxRestoreError(`The Session's sandbox is gone and its latest snapshot ${snapshot.ref} could not be started`);
  }
  const acquired = await firstCreate(state, record, plan, signal);
  return { opened: acquired, restored: false, publish: (handle, at) => ({ type: "acquire", handle, at }) };
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
  const saved = await state.load();
  if (saved.phase === "released") return;
  const recorded = recordedHandle(saved);
  if (recorded !== undefined) {
    const attached = await ports.sandbox.attach({ scope, handle: recorded, signal });
    if (attached !== "gone" && await readMarker(state.options.executor(attached.runtime)) !== null) return;
  }
  // A sandbox that must be restored is left to the first open (startNew).
  if (saved.latestSnapshot.status !== "none") return;
  // The fence first (design §0.0 rule 10), then acquire and record the handle.
  if (!await state.isCurrent(state.execution())) return;
  const generation = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const plan = await state.options.plan({ scope, generation, stores: state.stores });
  const acquired = await firstCreate(state, saved, plan, signal);
  try {
    if (ports.sandbox.handle === "changes" && !await state.isCurrent(state.execution())) {
      throw new SessionSandboxFenceLostError("The Session execution fence was lost while its sandbox was warmed");
    }
    await writeMarker(state.options.executor(acquired.runtime), generation);
    state.stores = mergeStores(plan.stores, state.stores);
    if (await state.apply(saved, { type: "acquire", handle: acquired.handle, at: state.now() }) === null) {
      throw conflict("its sandbox was warmed");
    }
  } catch (error) {
    await state.releaseOwn(acquired.handle);
    throw error;
  }
}

async function readMarker(executor: SessionSandboxExecutor): Promise<string | null> {
  // A transport/exec exception is not evidence that the container is gone.
  const result = parseExecResult(await executor.exec(`cat ${SANDBOX_GENERATION_MARKER} 2>/dev/null`));
  const value = result.exitCode === 0 ? result.stdout.trim() : "";
  return value.length > 0 ? value : null;
}

async function writeMarker(executor: SessionSandboxExecutor, generation: string): Promise<void> {
  const out = await executor.exec(`echo ${generation} > ${SANDBOX_GENERATION_MARKER}`);
  if (parseExecResult(out).exitCode !== 0) throw new Error(`Writing ${SANDBOX_GENERATION_MARKER} failed: ${out.slice(0, 200)}`);
}

/** Initial open, warm and no-snapshot recovery share this creation boundary.
 * Environment cache integration wraps acquire here; it never enters latestSnapshot. */
async function firstCreate<R>(state: LiveSessionSandbox<R>, record: SessionSandboxState, plan: SandboxPlan, signal: AbortSignal): Promise<Acquired<R>> {
  if (record.phase !== "none") throw new SandboxRestoreError("The previous Session sandbox could not be recovered and no usable Session snapshot is available");
  const { ports } = await state.compose();
  const input = { scope: state.scope(), plan, signal };
  const acquired = await (state.options.environmentCache?.acquire(input) ?? ports.sandbox.acquire(input));
  if (acquired === "gone") throw new Error(`Sandbox source ${JSON.stringify(plan.from)} was not found`);
  return acquired;
}
