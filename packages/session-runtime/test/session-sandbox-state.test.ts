import { describe, expect, it } from "vitest";
import {
  droppedSnapshots,
  initialSandboxState,
  recordedHandle,
  SANDBOX_TRANSITIONS,
  SessionSandboxTransitionError,
  transition,
  type LatestSnapshot,
  type SandboxAction,
  type SandboxActionType,
  type SandboxPhaseName,
  type SessionSandboxState,
  type SnapshotRef,
} from "../src/session-sandbox-state";

// The Session sandbox state machine (design §0.0b A.11): the table is the
// spec. One test per legal transition, one per illegal one, and the guards.

const handle = { provider: "fake", runtimeId: "r1" };
const other = { provider: "fake", runtimeId: "r2" };
const snap = (ref: string): SnapshotRef => ({ provider: "fake", ref, kind: "snapshot" });
const self = { provider: "fake", ref: "r1", kind: "self" as const };
const none: LatestSnapshot = { status: "none" };
const taken = (ref: string): LatestSnapshot => ({ status: "taken", ref: snap(ref) });
const missing: LatestSnapshot = { status: "missing" };
const shared = { stores: [], outputs: true, version: 7 };

const inPhase: Record<SandboxPhaseName, (latestSnapshot: LatestSnapshot) => SessionSandboxState> = {
  none: (latestSnapshot) => ({ phase: "none", latestSnapshot, ...shared }),
  running: (latestSnapshot) => ({ phase: "running", handle, runStartedAt: 100, latestSnapshot, ...shared }),
  paused: (latestSnapshot) => ({ phase: "paused", handle, pauseRef: self, latestSnapshot, ...shared }),
  lost: (latestSnapshot) => ({ phase: "lost", latestSnapshot, ...shared }),
  released: (latestSnapshot) => ({ phase: "released", latestSnapshot, ...shared }),
};

const actions: Record<SandboxActionType, SandboxAction> = {
  acquire: { type: "acquire", handle: other, at: 500 },
  attach: { type: "attach", handle: other, at: 500 },
  renew: { type: "renew", handle: other, at: 500 },
  idlePause: { type: "idlePause", pauseRef: self },
  resume: { type: "resume", handle: other, at: 500 },
  restoreFromSnapshot: { type: "restoreFromSnapshot", handle: other, at: 500, ref: snap("s9") },
  publishSnapshot: { type: "publishSnapshot", ref: snap("s9") },
  snapshotFailed: { type: "snapshotFailed" },
  lose: { type: "lose" },
  release: { type: "release" },
};

const running = (latestSnapshot: LatestSnapshot, runStartedAt = 500) => ({ phase: "running", handle: other, runStartedAt, latestSnapshot });

/** action × phase → next lifecycle, starting from `from`'s latest snapshot. */
const legal: Array<{ action: SandboxActionType; from: SandboxPhaseName; snapshot?: LatestSnapshot; to: object }> = [
  { action: "acquire", from: "none", to: running(none) },
  { action: "acquire", from: "running", to: running(none) },
  { action: "acquire", from: "paused", to: running(none) },
  { action: "acquire", from: "lost", to: running(none) },
  { action: "attach", from: "running", snapshot: taken("s1"), to: running(taken("s1"), 100) },
  { action: "attach", from: "paused", snapshot: taken("s1"), to: running(taken("s1")) },
  { action: "renew", from: "running", snapshot: missing, to: running(missing) },
  { action: "idlePause", from: "running", snapshot: taken("s1"), to: { phase: "paused", handle, pauseRef: self, latestSnapshot: taken("s1") } },
  { action: "resume", from: "paused", snapshot: taken("s1"), to: running(taken("s1")) },
  { action: "restoreFromSnapshot", from: "none", to: running(taken("s9")) },
  { action: "restoreFromSnapshot", from: "running", snapshot: taken("s1"), to: running(taken("s9")) },
  { action: "restoreFromSnapshot", from: "paused", snapshot: taken("s1"), to: running(taken("s9")) },
  { action: "restoreFromSnapshot", from: "lost", snapshot: missing, to: running(taken("s9")) },
  { action: "publishSnapshot", from: "running", snapshot: taken("s1"), to: { phase: "running", handle, runStartedAt: 100, latestSnapshot: taken("s9") } },
  { action: "snapshotFailed", from: "running", to: { phase: "running", handle, runStartedAt: 100, latestSnapshot: missing } },
  { action: "lose", from: "running", snapshot: taken("s1"), to: { phase: "lost", latestSnapshot: taken("s1") } },
  { action: "lose", from: "paused", snapshot: taken("s1"), to: { phase: "lost", latestSnapshot: taken("s1") } },
  { action: "release", from: "none", to: { phase: "released", latestSnapshot: none } },
  { action: "release", from: "running", snapshot: taken("s1"), to: { phase: "released", latestSnapshot: none } },
  { action: "release", from: "paused", snapshot: taken("s1"), to: { phase: "released", latestSnapshot: none } },
  { action: "release", from: "lost", snapshot: taken("s1"), to: { phase: "released", latestSnapshot: none } },
];

const phases = Object.keys(inPhase) as SandboxPhaseName[];
const actionTypes = Object.keys(actions) as SandboxActionType[];
const isLegal = (action: SandboxActionType, from: SandboxPhaseName) => legal.some((entry) => entry.action === action && entry.from === from);

describe("Session sandbox transitions: every legal one", () => {
  for (const { action, from, snapshot, to } of legal) {
    it(`${from} × ${action}`, () => {
      const next = transition(inPhase[from](snapshot ?? none), actions[action]);
      expect(next).toEqual({ ...to, ...shared, version: 8 });
    });
  }
});

describe("Session sandbox transitions: every illegal one", () => {
  for (const action of actionTypes) {
    for (const from of phases) {
      if (isLegal(action, from)) continue;
      it(`${from} × ${action} throws`, () => {
        const state = inPhase[from](none);
        expect(() => transition(state, actions[action])).toThrow(SessionSandboxTransitionError);
        expect(() => transition(state, actions[action])).toThrow(`cannot ${action} from ${from}`);
      });
    }
  }

  it("the table and this test agree on what is legal", () => {
    for (const action of actionTypes) {
      for (const from of phases) expect(SANDBOX_TRANSITIONS[action][from] !== undefined, `${from} × ${action}`).toBe(isLegal(action, from));
    }
  });
});

describe("Session sandbox transition guards", () => {
  it("acquire is refused while something needs restoring: never a silent empty sandbox (A.4)", () => {
    for (const from of ["none", "running", "paused", "lost"] as const) {
      for (const snapshot of [taken("s1"), missing]) {
        expect(() => transition(inPhase[from](snapshot), actions.acquire)).toThrow(SessionSandboxTransitionError);
      }
    }
  });

  it("snapshotFailed only marks a record with no snapshot: an earlier one can still restore", () => {
    for (const snapshot of [taken("s1"), missing]) {
      expect(() => transition(inPhase.running(snapshot), actions.snapshotFailed)).toThrow(SessionSandboxTransitionError);
    }
  });

  it("a pause that is a snapshot (no pause in place) is also the latest snapshot (A.3)", () => {
    const next = transition(inPhase.running(taken("s1")), { type: "idlePause", pauseRef: snap("s2") });
    expect(next).toMatchObject({ phase: "paused", pauseRef: snap("s2"), latestSnapshot: taken("s2") });
  });

  it("a pause in place stays apart from the latest snapshot (A.5)", () => {
    const next = transition(inPhase.running(taken("s1")), actions.idlePause);
    expect(next).toMatchObject({ phase: "paused", pauseRef: self, latestSnapshot: taken("s1") });
  });

  it("every transition is one version on and only computes: the input is untouched (A.11)", () => {
    const state = inPhase.running(none);
    const copy = structuredClone(state);
    expect(transition(state, actions.lose).version).toBe(state.version + 1);
    expect(state).toEqual(copy);
  });
});

describe("Session sandbox record helpers", () => {
  it("a Session with no record starts in none at version 0", () => {
    expect(initialSandboxState()).toEqual({ phase: "none", latestSnapshot: none, stores: [], outputs: false, version: 0 });
  });

  it("only running and paused name a sandbox", () => {
    expect(phases.map((phase) => recordedHandle(inPhase[phase](none)))).toEqual([undefined, handle, handle, undefined, undefined]);
  });

  it("droppedSnapshots: a replaced snapshot goes; the one still held stays (A.2)", () => {
    const before = inPhase.running(taken("s1"));
    expect(droppedSnapshots(before, transition(before, { type: "publishSnapshot", ref: snap("s2") }))).toEqual([snap("s1")]);
    expect(droppedSnapshots(before, transition(before, { type: "publishSnapshot", ref: snap("s1") }))).toEqual([]);
    expect(droppedSnapshots(before, transition(before, actions.lose))).toEqual([]);
    expect(droppedSnapshots(before, transition(before, actions.release))).toEqual([snap("s1")]);
  });

  it("droppedSnapshots: a snapshot pause that replaced the latest drops the old one, not itself", () => {
    const before = inPhase.running(taken("s1"));
    const paused = transition(before, { type: "idlePause", pauseRef: snap("s2") });
    expect(droppedSnapshots(before, paused)).toEqual([snap("s1")]);
    expect(droppedSnapshots(paused, transition(paused, actions.lose))).toEqual([]);
  });

  it("droppedSnapshots: a pause in place is never a snapshot to discard", () => {
    const paused = inPhase.paused(none);
    expect(droppedSnapshots(paused, transition(paused, actions.release))).toEqual([]);
  });
});
