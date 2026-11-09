// The Session sandbox state machine (design §0.0b A.11), shared by the
// Cloudflare SessionDO and the Node runner.
//
// The record is a discriminated union, so an illegal combination cannot be
// written: only a running or paused sandbox has a handle, only a paused one a
// pause point, only a running one a run start.
//   none      nothing started yet
//   running   the Session's sandbox, running as far as this record knows
//   paused    stopped on purpose by the idle pause, kept at its pause point
//   lost      no sandbox: it failed, or could not be found; the next open
//             starts one from the latest snapshot
//   released  the Session ended; nothing opens again
// Next to the phase, the latest snapshot lives apart from the pause point
// (design §0.0b A.5: a pause in place is gone with the sandbox):
//   none      nothing was ever published or attempted: a fresh sandbox is fine
//   taken     a snapshot a new sandbox can start from
//   missing   the sandbox changed, its snapshot failed and there is no earlier
//             one: losing it is an error, never a silent empty sandbox
//
// Every transition is in SANDBOX_TRANSITIONS (action × phase → next record);
// anything else throws SessionSandboxTransitionError. transition() only
// computes the next record. Callers make the vendor calls, then publish the
// result as one compare-and-set on `version` (LiveSessionSandbox.apply).

import type { MemoryStoreBinding, ResumeRef, SandboxHandle } from "@open-managed-agents/sandbox";

/** A restore point stored apart from the sandbox: a new one can start from it. */
export type SnapshotRef = ResumeRef & { kind: "snapshot" };

export function isSnapshotRef(ref: ResumeRef): ref is SnapshotRef {
  return ref.kind === "snapshot";
}

export type LatestSnapshot =
  | { status: "none" }
  | { status: "taken"; ref: SnapshotRef }
  | { status: "missing" };

export type SandboxPhase =
  | { phase: "none" }
  | { phase: "running"; handle: SandboxHandle; runStartedAt: number; pauseRef?: ResumeRef }
  | { phase: "paused"; handle: SandboxHandle; pauseRef: ResumeRef }
  | { phase: "lost"; pauseRef?: ResumeRef }
  | { phase: "released" };

export type SandboxPhaseName = SandboxPhase["phase"];

/** The record a host persists: what a new owner of the Session needs to find
 * its sandbox. `version` is +1 per write (design §0.0b A.10). */
export type SessionSandboxState = SandboxPhase & {
  latestSnapshot: LatestSnapshot;
  /** What is attached; not lifecycle, so it changes with any write. */
  stores: MemoryStoreBinding[];
  outputs: boolean;
  version: number;
};

export type SandboxAction =
  /** A new sandbox with nothing to restore. */
  | { type: "acquire"; handle: SandboxHandle; at: number }
  /** The recorded sandbox found again; a paused one woke and starts a new run. */
  | { type: "attach"; handle: SandboxHandle; at: number }
  /** The lifetime refresh: the same sandbox, a new continuous run. */
  | { type: "renew"; handle: SandboxHandle; at: number }
  /** The idle pause. A pause ref of kind "snapshot" (no pause in place) is
   * also the latest snapshot. */
  | { type: "idlePause"; pauseRef: ResumeRef }
  /** Woken from the pause point. */
  | { type: "resume"; handle: SandboxHandle; at: number }
  /** A new sandbox started from a snapshot. */
  | { type: "restoreFromSnapshot"; handle: SandboxHandle; at: number; ref: SnapshotRef }
  /** A newer snapshot; the previous one is dropped. */
  | { type: "publishSnapshot"; ref: SnapshotRef }
  /** The sandbox changed, its snapshot failed, and there is no earlier one. */
  | { type: "snapshotFailed" }
  /** The sandbox failed or cannot be found; the latest snapshot stays. */
  | { type: "lose" }
  /** The Session ended. */
  | { type: "release" };

export type SandboxActionType = SandboxAction["type"];

/** The action is not legal in this phase (or its guard refused it). */
export class SessionSandboxTransitionError extends Error {
  override readonly name = "SessionSandboxTransitionError";
  constructor(readonly from: SandboxPhaseName, readonly action: SandboxActionType) {
    super(`The Session sandbox cannot ${action} from ${from}`);
  }
}

type Lifecycle = SandboxPhase & { latestSnapshot: LatestSnapshot };
type Rule<A> = (state: SessionSandboxState, action: A) => Lifecycle | null;
type Rules = { [T in SandboxActionType]: Partial<Record<SandboxPhaseName, Rule<Extract<SandboxAction, { type: T }>>>> };

const fresh: Rule<{ handle: SandboxHandle; at: number }> = (state, action) =>
  state.latestSnapshot.status === "none"
    ? { phase: "running", handle: action.handle, runStartedAt: action.at, latestSnapshot: state.latestSnapshot }
    : null;
const restored: Rule<{ handle: SandboxHandle; at: number; ref: SnapshotRef }> = (_state, action) =>
  ({ phase: "running", handle: action.handle, runStartedAt: action.at, latestSnapshot: { status: "taken", ref: action.ref } });
const started: Rule<{ handle: SandboxHandle; at: number }> = (state, action) =>
  ({ phase: "running", handle: action.handle, runStartedAt: action.at, latestSnapshot: state.latestSnapshot });
const lost: Rule<unknown> = (state) => ({ phase: "lost", latestSnapshot: state.latestSnapshot, ...("pauseRef" in state && state.pauseRef !== undefined ? { pauseRef: state.pauseRef } : {}) });
const released: Rule<unknown> = () => ({ phase: "released", latestSnapshot: { status: "none" } });

/** action × phase → next record. A missing entry is an illegal transition; a
 * rule returning null is one its guard refused. */
export const SANDBOX_TRANSITIONS: Rules = {
  acquire: { none: fresh, running: fresh, paused: fresh, lost: fresh },
  attach: {
    running: (state, action) => state.phase !== "running" ? null
      : { phase: "running", handle: action.handle, runStartedAt: state.runStartedAt, latestSnapshot: state.latestSnapshot },
    paused: started,
  },
  renew: { running: started },
  idlePause: {
    running: (state, action) => state.phase !== "running" ? null : {
      phase: "paused", handle: state.handle, pauseRef: action.pauseRef,
      latestSnapshot: isSnapshotRef(action.pauseRef) ? { status: "taken", ref: action.pauseRef } : state.latestSnapshot,
    },
  },
  resume: { paused: started, lost: started },
  restoreFromSnapshot: { none: restored, running: restored, paused: restored, lost: restored },
  publishSnapshot: {
    running: (state, action) => state.phase !== "running" ? null
      : { phase: "running", handle: state.handle, runStartedAt: state.runStartedAt, latestSnapshot: { status: "taken", ref: action.ref } },
  },
  snapshotFailed: {
    running: (state) => state.phase !== "running" || state.latestSnapshot.status !== "none" ? null
      : { phase: "running", handle: state.handle, runStartedAt: state.runStartedAt, latestSnapshot: { status: "missing" } },
  },
  lose: { running: lost, paused: lost },
  release: { none: released, running: released, paused: released, lost: released },
};

/** The next record, one version on. Pure; throws SessionSandboxTransitionError. */
export function transition(state: SessionSandboxState, action: SandboxAction): SessionSandboxState {
  const rule = SANDBOX_TRANSITIONS[action.type][state.phase] as Rule<SandboxAction> | undefined;
  const next = rule?.(state, action) ?? null;
  if (next === null) throw new SessionSandboxTransitionError(state.phase, action.type);
  return { ...next, stores: state.stores, outputs: state.outputs, version: state.version + 1 };
}

/** The record of a Session with no stored one. */
export function initialSandboxState(): SessionSandboxState {
  return { phase: "none", latestSnapshot: { status: "none" }, stores: [], outputs: false, version: 0 };
}

/** The sandbox this record names, if any. */
export function recordedHandle(state: SessionSandboxState): SandboxHandle | undefined {
  return state.phase === "running" || state.phase === "paused" ? state.handle : undefined;
}

/** The version a compare-and-set expects; no record = 0. */
export function stateVersion(saved: SessionSandboxState | undefined): number {
  return saved?.version ?? 0;
}

export function sameRef(a: ResumeRef | undefined, b: ResumeRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.ref === b.ref;
}

/** Stored snapshots `before` references and `after` no longer does: nothing
 * can reach them once `after` is published, so they are discarded. */
export function droppedSnapshots(before: SessionSandboxState, after: SessionSandboxState): SnapshotRef[] {
  const kept = heldSnapshots(after);
  const dropped: SnapshotRef[] = [];
  for (const ref of heldSnapshots(before)) {
    if (!kept.some((other) => sameRef(other, ref)) && !dropped.some((other) => sameRef(other, ref))) dropped.push(ref);
  }
  return dropped;
}

function heldSnapshots(state: SessionSandboxState): SnapshotRef[] {
  return [
    ...(state.phase === "paused" && isSnapshotRef(state.pauseRef) ? [state.pauseRef] : []),
    ...(state.latestSnapshot.status === "taken" ? [state.latestSnapshot.ref] : []),
  ];
}
