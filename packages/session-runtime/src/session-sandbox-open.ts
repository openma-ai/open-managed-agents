import { traceSessionSandbox } from "./session-sandbox-tracing";
// Opening the Session's sandbox (design §0.1 steps 2-3, §0.0b A.4), lazily on
// first use or prepare(), single-flight:
//   1. attach the recorded handle (reuse; a paused one wakes); its
//      /tmp/.oma-warm marker is the generation (the private Memory runtime
//      generation and the recycle probe value);
//   2. otherwise mint a generation and plan, then: resume the pause point of a
//      paused sandbox -> start a new sandbox from the latest snapshot (the
//      host's published one, else the record's) -> with neither, a new sandbox
//      through the initial creation path when none was ever published (with a
//      persisted warning about lost changes). A published snapshot that cannot
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

import { RetryableSandboxError, parseExecResult, type Acquired, type ResumeRef, type SandboxHandle, type SandboxPlan } from "@open-managed-agents/sandbox";
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
  return traceSessionSandbox(state, "open", async span => {
    const opened = await (async () => {
      await state.quiesce();
      // An execution takes the sandbox back from the idle window (design §0.0b A.10).
      if (state.execution() !== undefined && state.idleSince !== null) await disarmIdle(state);
      await state.warming?.catch(() => undefined);
      if (state.current !== null) { span.setAttribute("sandbox.decision", "cached"); return state.current; }
      span.setAttribute("sandbox.decision", state.opening === null ? "start" : "join");
      return state.opening ??= start(state).finally(() => { state.opening = null; });
    })();
    span.setAttributes({ "sandbox.runtime_id": opened.handle.runtimeId, "sandbox.provider": opened.handle.provider, "sandbox.generation": opened.generation });
    return opened;
  });
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

/** Only idempotent handle reconnection/self-resume is retried. Unknown errors
 * are not absence; snapshot creation is deliberately not retried here. */
async function retryRecovery<R, T>(state: LiveSessionSandbox<R>, action: () => Promise<T>): Promise<T> {
  const execution = state.execution();
  for (let attempt = 0; ; attempt++) {
    if (!await state.isCurrent(execution)) throw new SessionSandboxFenceLostError("Session fence lost during sandbox recovery");
    try { return await action(); } catch (error) {
      if (!(error instanceof RetryableSandboxError) || attempt >= 2 || !Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 0 || error.retryAfterMs > 1_000) throw error;
      await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
    }
  }
}

function conflict(what: string): SessionSandboxStateConflictError {
  return new SessionSandboxStateConflictError(`Another writer changed the Session sandbox record while ${what}`);
}

async function start<R>(state: LiveSessionSandbox<R>): Promise<OpenSandbox<R>> {
  return traceSessionSandbox(state, "start", async span => {
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
    let record = await traceSessionSandbox(state, "lookup", async () => state.load());
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
      opened = await retryRecovery(state, () => traceSessionSandbox(state, "attach", async span => {
        span.setAttributes({"sandbox.provider": recorded.provider, "sandbox.runtime_id": recorded.runtimeId});
        const result = await ports.sandbox.attach({ scope, handle: recorded, signal });
        span.setAttribute("sandbox.alive", result !== "gone"); return result;
      }));
      const marker = opened === "gone" ? null : await traceSessionSandbox(state, "liveness", async () => readMarker(state.options.executor((opened as Acquired<R>).runtime)));
      if (marker === null) {
        opened = "gone";
        // A "fixed" handle is reused by the next acquire; a provider-assigned one would be orphaned.
        if (ports.sandbox.handle === "changes") await ports.sandbox.release({ scope, handle: recorded }).catch(() => undefined);
      } else {
        generation = marker;
      }
    }
    let reused = opened !== "gone";
    span.setAttribute("sandbox.decision", reused ? "reuse" : "new");
    if (!reused) generation = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    // An attached sandbox may have kept running: keep the recorded start; one
    // the idle pause stopped wakes now. A resumed or new one starts a run now.
    let runStartedAt = record.phase === "running" ? record.runStartedAt : state.now();
    // The transition this open still has to publish.
    let publish: (handle: SandboxHandle, at: number) => SandboxAction = (handle, at) => ({ type: "attach", handle, at });
    let plan: SandboxPlan;
    try {
      plan = await traceSessionSandbox(state, "plan", async () => state.options.plan({ scope, generation, stores: state.stores }));
      // The plan resolved these paths for this physical generation. Retired
      // bindings must not override its prefixes or access modes.
      state.stores = mergeStores(state.stores, plan.stores);
      if (opened === "gone") {
        const started = await traceSessionSandbox(state, "startNew", async () => startNew(state, record, plan, signal));
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
            const attached = await traceSessionSandbox(state, "attachWinner", async () => ports.sandbox.attach({ scope, handle: winner.handle, signal }));
            const marker = attached === "gone" ? null : await traceSessionSandbox(state, "liveness", async () => readMarker(state.options.executor(attached.runtime)));
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
            plan = await traceSessionSandbox(state, "plan", async () => state.options.plan({ scope, generation, stores: state.stores }));
            await assertCurrent();
            state.stores = mergeStores(winner.stores, plan.stores);
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
  });
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
    const resume = () => traceSessionSandbox(state, ref.kind === "snapshot" ? "restoreFromSnapshot" : "resume", async span => {
      span.setAttribute("sandbox.provider", ref.provider);
      const result = await ports.sandbox.resume({ scope, ref, plan, signal });
      span.setAttribute("sandbox.alive", result !== "gone"); return result;
    });
    const opened = ref.kind === "self" ? await retryRecovery(state, resume) : await resume();
    if (opened !== "gone") state.options.warn(`workspace_restored ref=${ref.ref} kind=${ref.kind} elapsed_ms=${state.now() - started}`);
    else state.options.warn(`workspace_restore_failed ref=${ref.ref} kind=${ref.kind} elapsed_ms=${state.now() - started} error=gone`);
    return opened;
  };
  // A pause in place is gone with the sandbox; one that is a snapshot is the
  // latest snapshot (or older than the host's), tried below.
  if ("pauseRef" in record && record.pauseRef !== undefined && !isSnapshotRef(record.pauseRef)) {
    const resumed = await tryResume(record.pauseRef);
    if (resumed !== "gone") return { opened: resumed, restored: false, publish: (handle, at) => ({ type: "resume", handle, at }) };
  }
  const snapshot = (await state.options.resumeRef()) ?? (record.latestSnapshot.status === "taken" ? record.latestSnapshot.ref : null);
  if (snapshot !== null) {
    const restored = await tryResume(snapshot).catch((error) => {
      throw new SandboxRestoreError(`The Session latest snapshot ${snapshot.ref} could not be started: ${errorText(error)}`, { cause: error });
    });
    if (restored !== "gone") return { opened: restored, restored: true, publish: (handle, at) => ({ type: "restoreFromSnapshot", handle, at, ref: snapshot }) };
    await state.options.warn(`workspace_restore_fallback ref=${snapshot.ref} kind=snapshot: Session snapshot unavailable; restoring prepared Environment; Session workspace changes may be lost`);
  }
  const acquired = await firstCreate(state, record, plan, signal);
  return { opened: acquired, restored: false, publish: (handle, at) => ({ type: "acquire", handle, at, ...(snapshot === null ? {} : {preparedFallback: true as const}) }) };
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
    // The plan resolved these paths for this physical generation. Retired
    // bindings must not override its prefixes or access modes.
    state.stores = mergeStores(state.stores, plan.stores);
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
  if (record.phase !== "none") await state.options.warn("sandbox_recreated: no Session snapshot was ever published; changes since its creation were lost; recreating from the initial environment and rerunning Session setup and mounts");
  const { ports } = await state.compose();
  const input = { scope: state.scope(), plan, signal };
  const acquired = await traceSessionSandbox(state, "acquire", async () => state.options.environmentCache === undefined
    ? ports.sandbox.acquire(input)
    : traceSessionSandbox(state, "environment.prepare", async () => state.options.environmentCache!.acquire(input)));
  if (acquired === "gone") throw new Error(`Sandbox source ${JSON.stringify(plan.from)} was not found`);
  return acquired;
}
