import { describe, expect, it } from "vitest";
import type { SandboxPorts, SandboxPlan } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";
import { LIFETIME_REFRESH_MARGIN_MS, MAX_TOOL_CALL_MS } from "../src/session-sandbox-lifetime";
import { SessionSandboxStateConflictError } from "../src/session-sandbox-live";
import type { SessionSandboxExecution, SessionSandboxExecutor } from "../src/session-sandbox-options";
import { initialSandboxState, recordedHandle, type LatestSnapshot, type SessionSandboxState, type SnapshotRef } from "../src/session-sandbox-state";

// Design §0.0b A.10: every write of the Session sandbox record is a
// compare-and-set on its version, +1 per write. Of two writers that read the
// same version only one wins; the loser drops its result and cleans up what
// it produced (a sandbox it started is released, a snapshot it took is
// discarded) without touching the winner's record.

const HOUR = 60 * 60_000;
const THRESHOLD = HOUR - MAX_TOOL_CALL_MS - LIFETIME_REFRESH_MARGIN_MS;
const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
const attempt: SessionSandboxExecution = { executionId: "exec_1", attemptId: "att_1", ownerId: "owner_1", generation: 1 };
const fake = (runtimeId: string) => ({ provider: "fake", runtimeId });
const taken = (ref: SnapshotRef): LatestSnapshot => ({ status: "taken", ref });
const latestRef = (state: SessionSandboxState | undefined): SnapshotRef => {
  if (state?.latestSnapshot.status !== "taken") throw new Error("no latest snapshot");
  return state.latestSnapshot.ref;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** One record shared by every writer; `intrude` lets a competing writer that
 * read the same version write first, right before the matching save. */
function versionedStore(initial?: SessionSandboxState) {
  let stored = initial;
  const writes: string[] = [];
  let intruder: { when: (state: SessionSandboxState) => boolean; winner: SessionSandboxState } | null = null;
  const state = {
    load: async () => stored,
    save: async (next: SessionSandboxState, expected: number): Promise<boolean> => {
      const competing = intruder;
      if (competing !== null && competing.when(next)) {
        intruder = null;
        // The competitor read the same version and gets there first.
        await state.save({ ...competing.winner, version: expected + 1 }, expected);
      }
      if ((stored?.version ?? 0) !== expected) { writes.push(`lost@v${expected}`); return false; }
      stored = next;
      writes.push(`won@v${expected}`);
      return true;
    },
  };
  return {
    state, writes, get: () => stored,
    intrude: (winner: SessionSandboxState, when: (state: SessionSandboxState) => boolean = () => true) => { intruder = { when, winner }; },
  };
}

function world(initial?: SessionSandboxState, gone: string[] = []) {
  const log: string[] = [];
  const markers = new Map<string, string>();
  const named = initial === undefined ? undefined : recordedHandle(initial);
  if (named !== undefined) markers.set(named.runtimeId, "gen0");
  const clock = { now: 1_000_000 };
  const store = versionedStore(initial);
  let n = 0;
  const gates: { pause?: Promise<void>; attachAfterPause?: Promise<void>; acquire?: Promise<void>; acquiring?: () => void; onAttach?: () => Promise<void>; onStorage?: (input: { stores: SandboxPlan["stores"] }) => Promise<void>; generationStores?: boolean; onRevoke?: () => Promise<void>; onRelease?: () => Promise<void>; onPlan?: () => Promise<void> } = {};
  const ports = (gated: "pause" | "attachAfterPause" | "acquire" | null) => {
    let paused = false;
    return {
      sandbox: {
        handle: "changes",
        maxLifetimeMs: HOUR,
        async attach({ handle }: { handle: { runtimeId: string } }) {
          log.push(`attach:${handle.runtimeId}`);
          await gates.onAttach?.();
          if (paused && gated === "attachAfterPause" && gates.attachAfterPause) await gates.attachAfterPause;
          paused = false;
          return gone.includes(handle.runtimeId) ? "gone" : { runtime: { id: handle.runtimeId }, handle: fake(handle.runtimeId) };
        },
        async resume({ ref }: { ref: { ref: string } }) {
          const id = `from-${ref.ref}`;
          log.push(`resume:${ref.ref}`);
          return { runtime: { id }, handle: fake(id) };
        },
        async acquire() { const id = `r${++n}`; log.push(`acquire:${id}`); if (gated === "acquire") { gates.acquiring?.(); await gates.acquire; } return { runtime: { id }, handle: fake(id) }; },
        async checkpoint() { n += 1; log.push(`checkpoint:snap-${n}`); return { provider: "fake", ref: `snap-${n}`, kind: "snapshot" }; },
        async pause({ handle }: { handle: { runtimeId: string } }) {
          log.push(`pause:${handle.runtimeId}`);
          if (gated === "pause" && gates.pause) await gates.pause;
          paused = true;
          return { provider: "fake", ref: `pause-${handle.runtimeId}`, kind: "self" };
        },
        async release({ handle }: { handle: { runtimeId: string } }) { await gates.onRelease?.(); log.push(`release:${handle.runtimeId}`); },
        async discard({ ref }: { ref: { ref: string } }) { log.push(`discard:${ref.ref}`); },
        async keepAlive() { return "alive"; },
      },
      storage: { async attach(input: { stores: SandboxPlan["stores"] }) { await gates.onStorage?.(input); }, async sync() {}, async detach() {} },
      egress: { async attach() {}, async update() {}, async revoke() { await gates.onRevoke?.(); } },
    } as unknown as SandboxPorts<{ id: string }>;
  };
  const executor = (id: string) => ({
    async exec(command: string) {
      const written = /^echo (\S+) > /.exec(command);
      if (written) { markers.set(id, written[1]!); return "exit=0\n"; }
      if (command.startsWith("cat ")) return markers.has(id) ? `exit=0\n${markers.get(id)}\n` : "exit=1\n";
      log.push(`exec:${command}@${id}`);
      return "exit=0\n";
    },
    async setEnvVars() {},
  }) as unknown as SessionSandboxExecutor;
  const core = (opts: { execution?: SessionSandboxExecution; gated?: "pause" | "attachAfterPause" | "acquire" } = {}) => {
    let execution = opts.execution;
    const composed = ports(opts.gated ?? null);
    const sandbox = new PortsSessionSandbox<{ id: string }>({
      compose: async () => ({ ports: composed }),
      executor: (runtime) => executor(runtime.id),
      state: store.state,
      scope: () => scope,
      plan: async ({ stores, generation }) => { await gates.onPlan?.(); return ({
        from: { image: "img" }, egress: null, stores: gates.generationStores ? [{bindingId:"memory",storeName:"notes",storeId:generation,mountPath:"/mnt/memory/notes",access:"read_write"}] : stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" }, idleMs: 1_000, labels: { workspaceId: "ws", sessionId: "sess" },
      }); },
      resumeRef: async () => null,
      // Only execution-end and idle-pause snapshots here: deterministic writes.
      snapshotIntervalMs: 1_000 * HOUR,
      warn: () => undefined,
      outputDurability: () => null,
      egressRenewMs: null,
      now: () => clock.now,
      execution: () => execution,
      isCurrent: async captured => captured === execution,
      idle: { pauseMs: 1_000, schedule: () => undefined, cancel: () => undefined },
    });
    return { sandbox, setExecution: (next: SessionSandboxExecution | undefined) => { execution = next; } };
  };
  return { log, store, clock, gates, core };
}

/** The record of a writer that got there first: its sandbox is running. */
const winner = (runtimeId: string, latestSnapshot: LatestSnapshot = { status: "none" }): SessionSandboxState =>
  ({ ...initialSandboxState(), phase: "running", handle: fake(runtimeId), runStartedAt: 1, latestSnapshot });
/** ...or it paused the sandbox. */
const pausedWinner = (runtimeId: string): SessionSandboxState =>
  ({ ...initialSandboxState(), phase: "paused", handle: fake(runtimeId), pauseRef: { provider: "fake", ref: `pause-${runtimeId}`, kind: "self" } });

describe("Session sandbox record compare-and-set (design §0.0b A.10)", () => {
  it("normal open never runs stale work because an old cleanup acknowledged a competing handle", async()=>{
    const w=world({...winner("r0"),version:1,retiredHandles:[{handle:fake("old"),released:false}]});
    const a=w.core({execution:attempt});
    w.gates.onRelease=async()=>{const saved=w.store.get()!;await w.store.state.save({...saved,phase:"running",handle:fake("other"),version:saved.version+1},saved.version);};
    await a.sandbox.exec("WORK");
    // No old provider cleanup inside lifecycle publication or before exec.
    expect(w.log).toContain("exec:WORK@r0");
    expect(w.log).not.toContain("release:old");
    expect(w.store.get()).toMatchObject({handle:fake("r0")});
  });
  it("acquire: the loser releases the sandbox it started; the winner's record stays", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    w.store.intrude(winner("theirs"));
    await expect(a.sandbox.exec("x")).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    expect(w.store.writes).toEqual(["won@v0", "lost@v0", "won@v1", "won@v2"]);
    // One attach probes the winner; without its completed warm marker it
    // must still fail, without allocating again or touching that runtime.
    expect(w.log).toEqual(["acquire:r1", "release:r1", "attach:theirs"]);
    expect(w.store.get()).toEqual({ ...winner("theirs"), version: 3, retiredHandles: [{ handle: fake("r1"), released: true }] });
  });

  it("failed startup cleanup without an acquired sandbox leaves the other writer's runtime intact", async () => {
    const w = world({ ...winner("warm-owner"), version: 1 });
    const execution = w.core({ execution: attempt });
    await execution.sandbox.failExecution();
    expect(w.log).toEqual([]);
    expect(w.store.writes).toEqual([]);
    expect(w.store.get()).toMatchObject({ phase: "running", handle: fake("warm-owner"), version: 1 });
  });

  it("acquire loser followed by failed startup cleanup releases only its own allocation once", async () => {
    const w = world();
    const execution = w.core({ execution: attempt });
    w.store.intrude(winner("warm-owner"));
    await expect(execution.sandbox.exec("x")).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    await execution.sandbox.failExecution();
    await execution.sandbox.failExecution();
    expect(w.log).toEqual(["acquire:r1", "release:r1", "attach:warm-owner"]);
    expect(w.store.writes).toEqual(["won@v0", "lost@v0", "won@v1", "won@v2"]);
    expect(w.store.get()).toMatchObject({ phase: "running", handle: fake("warm-owner"), version: 3 });
  });

  it("a losing warmer retirement cannot invalidate the winner's final open publication", async () => {
    const w=world();const execution=w.core({execution:attempt});
    w.gates.onStorage=async()=>{
      const saved=w.store.get()!;
      await w.store.state.save({...saved,version:saved.version+1,retiredHandles:[{handle:fake("losing-warmer"),released:false}]},saved.version);
    };
    await expect(execution.sandbox.mountSessionOutputs()).resolves.toBeUndefined();
    await expect(execution.sandbox.exec("WORK")).resolves.toBe("exit=0\n");
    expect(w.log).toContain("exec:WORK@r1");
    expect(w.store.get()).toMatchObject({handle:fake("r1"),retiredHandles:[{handle:fake("losing-warmer"),released:false}]});
  });

  it("a first acquire loser adopts the completed warmer even when retired allocation deletion fails", async () => {
    const w=world();const ready=deferred(),finish=deferred();w.gates.acquiring=ready.resolve;w.gates.acquire=finish.promise;
    const a=w.core({execution:attempt,gated:"acquire"});const opening=a.sandbox.exec("WORK");
    await ready.promise;await w.core().sandbox.warm();
    w.gates.onRelease=async()=>{throw Error("old allocation deletion unavailable");};
    finish.resolve();await expect(opening).resolves.toBe("exit=0\n");
    expect(w.log).toContain("exec:WORK@r2");
    expect(w.store.get()).toMatchObject({handle:fake("r2"),retiredHandles:[{handle:fake("r1"),released:false}]});
  });
  it("a first acquire loser attaches the completed warm winner without another allocation or execution failure", async () => {
    const w = world();
    const acquiring = deferred(), finishAcquire = deferred();
    w.gates.acquiring = acquiring.resolve;
    w.gates.acquire = finishAcquire.promise;
    const execution = w.core({ execution: attempt, gated: "acquire" });
    const opening = execution.sandbox.exec("work");
    await acquiring.promise;
    const warmer = w.core();
    await warmer.sandbox.warm();
    const warmRecord = w.store.get();
    expect(warmRecord).toMatchObject({ phase: "running", handle: fake("r2"), version: 1 });
    finishAcquire.resolve();
    await expect(opening).resolves.toBe("exit=0\n");
    expect(w.log.filter(entry=>entry.startsWith("acquire:"))).toEqual(["acquire:r1", "acquire:r2"]);
    expect(w.log.filter(entry=>entry.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.log).toContain("attach:r2");
    expect(w.log.at(-1)).toBe("exec:work@r2");
    expect(w.store.get()).toMatchObject({ phase: "running", handle: fake("r2"), version: 4 });
  });

  it.each(["advanced", "released", "gone", "fence-lost"])("initial acquire convergence refuses an unsafe winner: %s", async mode => {
    const w = world(undefined, mode === "gone" ? ["r2"] : []);
    const acquiring = deferred(), finishAcquire = deferred();
    w.gates.acquiring = acquiring.resolve;
    w.gates.acquire = finishAcquire.promise;
    const execution = w.core({ execution: attempt, gated: "acquire" });
    const opening = execution.sandbox.exec("must-not-run");
    await acquiring.promise;
    await w.core().sandbox.warm();
    if(mode === "advanced") await w.store.state.save({...w.store.get()!,version:2},1);
    if(mode === "released") await w.store.state.save({...initialSandboxState(),phase:"released",version:2},1);
    if(mode === "fence-lost") execution.setExecution(undefined);
    finishAcquire.resolve();
    await expect(opening).rejects.toBeInstanceOf(Error);
    await execution.sandbox.failExecution();
    expect(w.log.filter(entry=>entry.startsWith("acquire:"))).toEqual(["acquire:r1","acquire:r2"]);
    expect(w.log.filter(entry=>entry.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.log.some(entry=>entry.startsWith("exec:"))).toBe(false);
    expect(w.store.get()?.version).toBe(mode === "fence-lost" ? 1 : mode === "advanced" || mode === "released" ? 4 : 3);
  });

  it("does not adopt or release a warm winner changed while attaching", async () => {
    const w = world();
    const acquiring = deferred(), finishAcquire = deferred();
    w.gates.acquiring = acquiring.resolve;
    w.gates.acquire = finishAcquire.promise;
    const execution = w.core({ execution: attempt, gated: "acquire" });
    const opening = execution.sandbox.exec("must-not-run");
    await acquiring.promise;
    await w.core().sandbox.warm();
    w.gates.onAttach = async () => { const saved=w.store.get()!; await w.store.state.save({...saved,version:saved.version+1},saved.version); };
    finishAcquire.resolve();
    await expect(opening).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    await execution.sandbox.failExecution();
    expect(w.log.filter(entry=>entry.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.log.some(entry=>entry.startsWith("exec:"))).toBe(false);
    expect(w.store.get()).toMatchObject({phase:"running",handle:fake("r2"),version:4});
  });

  it.each([false, true])("adoption storage fence loss cannot execute or release the winner (throws=%s)", async throws => {
    const w = world(); w.gates.generationStores = true;
    const ready=deferred(), release=deferred();
    w.gates.acquiring=ready.resolve; w.gates.acquire=release.promise;
    const a=w.core({execution:attempt,gated:"acquire"});
    const pending=a.sandbox.exec("STALE_WORK");
    await ready.promise; await w.core().sandbox.warm();
    const saved=w.store.get();
    w.gates.onStorage=async()=>{a.setExecution(undefined);if(throws)throw Error("storage failed after fence loss");};
    release.resolve();
    await expect(pending).rejects.toBeInstanceOf(Error);
    await a.sandbox.failExecution();
    expect(w.log.filter(x=>x.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.log.some(x=>x.startsWith("exec:STALE_WORK"))).toBe(false);
    expect(w.store.get()).toEqual({ ...saved, version: saved!.version + 2, retiredHandles: [{ handle: fake("r1"), released: true }] });
  });

  it.each([false, true])("adoption restores winner memory bindings and generation plan (winnerOnly=%s)", async winnerOnly => {
    const w=world(); w.gates.generationStores=!winnerOnly;
    const ready=deferred(),release=deferred();
    w.gates.acquiring=ready.resolve;w.gates.acquire=release.promise;
    const a=w.core({execution:attempt,gated:"acquire"});const pending=a.sandbox.exec("work");
    await ready.promise;w.gates.generationStores=true;await w.core().sandbox.warm();
    const saved=w.store.get()!;w.gates.generationStores=!winnerOnly;
    let mounted: SandboxPlan["stores"] | undefined;
    w.gates.onStorage=async input=>{mounted=input.stores;};
    release.resolve();await pending;
    expect(mounted).toEqual(saved.stores);
    expect(w.store.get()!.stores).toEqual(saved.stores);
  });

  it("rollback stops if the adopted execution fence changes while egress is revoked", async () => {
    const w=world();w.gates.generationStores=true;
    const ready=deferred(),release=deferred();w.gates.acquiring=ready.resolve;w.gates.acquire=release.promise;
    const a=w.core({execution:attempt,gated:"acquire"});const pending=a.sandbox.exec("must-not-run");
    await ready.promise;await w.core().sandbox.warm();const saved=w.store.get();
    w.gates.onStorage=async()=>{throw Error("storage failed");};
    w.gates.onRevoke=async()=>{a.setExecution(undefined);};
    release.resolve();await expect(pending).rejects.toThrow();
    expect(w.log.filter(x=>x.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.store.get()).toEqual({ ...saved, version: saved!.version + 2, retiredHandles: [{ handle: fake("r1"), released: true }] });
  });

  it.each([false,true])("adoption cannot roll back a same-handle newer record during replan (throws=%s)", async throws => {
    const w=world();
    const ready=deferred(),release=deferred();
    w.gates.acquiring=ready.resolve;w.gates.acquire=release.promise;
    const a=w.core({execution:attempt,gated:"acquire"});
    const pending=a.sandbox.exec("must-not-run");
    await ready.promise;await w.core().sandbox.warm();
    let competing: SessionSandboxState | undefined;
    w.gates.onPlan=async()=>{
      const saved=w.store.get()!;
      competing={...pausedWinner("r2"),version:saved.version+1};
      await w.store.state.save(competing,saved.version);
      if(throws)throw Error("plan failed after competing pause");
    };
    release.resolve();await expect(pending).rejects.toThrow();
    await a.sandbox.failExecution();
    expect(w.log.filter(x=>x.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.store.get()).toEqual(competing);
    expect(w.log.some(x=>x.startsWith("exec:must-not-run"))).toBe(false);
  });

  it("mount CAS conflict abandons cached runtime before the next call", async()=>{
    const w=world();const a=w.core({execution:attempt});await a.sandbox.exec("before");
    w.store.intrude(pausedWinner("r1"));
    await expect(a.sandbox.mountSessionOutputs()).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    const at=w.log.length;await a.sandbox.exec("after");
    expect(w.log.slice(at)).toContain("attach:r1");
    expect(w.log.filter(x=>x.startsWith("release:"))).toEqual([]);
  });
  it("failed fresh allocation is cleaned when a newer record names another runtime",async()=>{
    const w=world();w.gates.generationStores=true;const a=w.core({execution:attempt});
    w.gates.onStorage=async()=>{const saved=w.store.get()!;await w.store.state.save({...winner("other"),version:saved.version+1},saved.version);throw Error("storage");};
    await expect(a.sandbox.exec("NO")).rejects.toThrow();await a.sandbox.failExecution();
    expect(w.log.filter(x=>x.startsWith("release:"))).toEqual(["release:r1"]);
    expect(w.store.get()).toMatchObject({handle:fake("other")});
  });
  it("warm acquire: the loser releases the sandbox it warmed", async () => {
    const w = world();
    const a = w.core();
    w.store.intrude(winner("theirs"));
    await expect(a.sandbox.warm()).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    expect(w.store.writes).toEqual(["won@v0", "lost@v0", "won@v1", "won@v2"]);
    expect(w.log).toEqual(["acquire:r1", "release:r1"]);
    expect(w.store.get()).toMatchObject({ handle: fake("theirs") });
  });

  it("resume / new from the latest snapshot: the loser releases the sandbox it started, the snapshot is kept", async () => {
    const snapshotRef = { provider: "fake", ref: "snap-0", kind: "snapshot" as const };
    const w = world({ ...winner("r0", taken(snapshotRef)), version: 3 }, ["r0"]);
    const a = w.core({ execution: attempt });
    w.store.intrude(winner("theirs", taken(snapshotRef)));
    await expect(a.sandbox.exec("x")).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    expect(w.store.writes).toEqual(["won@v3", "lost@v3", "won@v4", "won@v5"]);
    expect(w.log).toEqual(["attach:r0", "release:r0", "resume:snap-0", "release:from-snap-0"]);
    expect(w.log).not.toContain("discard:snap-0");
    expect(w.store.get()).toMatchObject({ handle: fake("theirs"), latestSnapshot: taken(snapshotRef), version: 6 });
  });

  it("publishing a snapshot: the loser discards only the snapshot it took; the previous one is not discarded", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("write-1");
    await a.sandbox.endExecution();
    const previous = latestRef(w.store.get());
    expect(previous.ref).toBe("snap-2");
    a.setExecution({ ...attempt, attemptId: "att_2" });
    await a.sandbox.exec("write-2");
    const before = w.store.writes.length;
    w.store.intrude(winner("r1", taken(previous)), (state) => state.latestSnapshot.status === "taken" && state.latestSnapshot.ref.ref !== previous.ref);
    w.log.length = 0;
    await a.sandbox.endExecution();
    // record (won), then the snapshot publish against the same version: one won, one lost.
    expect(w.store.writes.slice(before)).toEqual(["won@v4", "won@v5", "lost@v5", "won@v6", "won@v7"]);
    expect(w.log).toEqual(["checkpoint:snap-3", "discard:snap-3"]);
    expect(w.store.get()).toMatchObject({ latestSnapshot: taken(previous), version: 8 });
  });

  it("publishing a snapshot that wins discards the previous one only after the write", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("write-1");
    await a.sandbox.endExecution();
    a.setExecution({ ...attempt, attemptId: "att_2" });
    await a.sandbox.exec("write-2");
    w.log.length = 0;
    await a.sandbox.endExecution();
    expect(w.log).toEqual(["checkpoint:snap-3", "discard:snap-2"]);
    expect(latestRef(w.store.get()).ref).toBe("snap-3");
  });

  it("idle pause: the loser discards its pause ref and leaves the winner's record", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("x");
    await a.sandbox.endExecution();
    a.setExecution(undefined);
    w.clock.now += 1_000;
    w.log.length = 0;
    w.store.intrude(winner("theirs"), (state) => state.phase === "paused");
    expect(await a.sandbox.idlePause()).toBe("skipped");
    expect(w.log).toEqual(["pause:r1", "discard:pause-r1"]);
    expect(w.store.get()).toMatchObject({ phase: "running", handle: fake("theirs") });
  });

  it("lifetime refresh (pause → resume): the loser releases the sandbox it resumed when the winner names another", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("x");
    w.clock.now += THRESHOLD + 1;
    w.log.length = 0;
    w.store.intrude(winner("theirs"));
    await expect(a.sandbox.exec("y")).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    expect(w.log).toEqual(["pause:r1", "attach:r1", "release:r1"]);
    expect(w.store.get()).toMatchObject({ handle: fake("theirs") });
  });

  it("lifetime refresh: a sandbox the winner's record names is not released", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("x");
    w.clock.now += THRESHOLD + 1;
    w.log.length = 0;
    w.store.intrude(pausedWinner("r1"));
    await expect(a.sandbox.exec("y")).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
    expect(w.log).toEqual(["pause:r1", "attach:r1"]);
    expect(w.store.get()).toMatchObject({ phase: "paused", handle: fake("r1") });
  });

  it("release (failed execution): the loser keeps a sandbox the winner's record names", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("x");
    w.log.length = 0;
    w.store.intrude(pausedWinner("r1"));
    await a.sandbox.failExecution();
    expect(w.log).not.toContain("release:r1");
    expect(w.store.get()).toMatchObject({ phase: "paused", handle: fake("r1") });
  });

  it("release (failed execution): the loser releases its own sandbox the winner's record does not name", async () => {
    const w = world();
    const a = w.core({ execution: attempt });
    await a.sandbox.exec("x");
    w.log.length = 0;
    w.store.intrude(winner("theirs"));
    await a.sandbox.failExecution();
    expect(w.log).toEqual(["release:r1"]);
    expect(w.store.get()).toMatchObject({ handle: fake("theirs") });
  });

  describe("lifetime refresh vs idle pause, both from the same version", () => {
    it("the refresh writes first: the idle pause loses and discards its ref", async () => {
      const w = world();
      const a = w.core({ execution: attempt });
      await a.sandbox.exec("x");
      const b = w.core({ gated: "pause" }); // another host instance, no execution
      const openPause = deferred();
      w.gates.pause = openPause.promise;
      w.clock.now += THRESHOLD + 1;
      const pausing = b.sandbox.idlePause(); // read the version, now held in pause
      await new Promise((r) => setTimeout(r, 0));
      const version = w.store.get()!.version;
      await a.sandbox.exec("y"); // refresh: pause → attach → recorded
      openPause.resolve();
      expect(await pausing).toBe("skipped");
      expect(w.store.writes.slice(-2)).toEqual([`won@v${version}`, `lost@v${version}`]);
      expect(w.log).toContain("discard:pause-r1");
      expect(w.store.get()).toMatchObject({ phase: "running", handle: fake("r1"), runStartedAt: w.clock.now, version: version + 1 });
    });

    it("the idle pause writes first: the refresh loses, keeps the sandbox the pause recorded, and the next call reopens it", async () => {
      const w = world();
      const a = w.core({ execution: attempt, gated: "attachAfterPause" });
      await a.sandbox.exec("x");
      const b = w.core();
      const openAttach = deferred();
      w.gates.attachAfterPause = openAttach.promise;
      w.clock.now += THRESHOLD + 1;
      const version = w.store.get()!.version;
      const refreshing = a.sandbox.exec("y"); // refresh: read the version, paused, attach held
      await new Promise((r) => setTimeout(r, 0));
      expect(await b.sandbox.idlePause()).toBe("paused");
      openAttach.resolve();
      await expect(refreshing).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
      expect(w.store.writes.slice(-2)).toEqual([`won@v${version}`, `lost@v${version}`]);
      expect(w.log.filter((entry) => entry.startsWith("release:"))).toEqual([]);
      expect(w.store.get()).toMatchObject({ phase: "paused", handle: fake("r1"), version: version + 1 });
      // The next call opens the recorded (paused) sandbox again.
      expect(await a.sandbox.exec("z")).toBe("exit=0\n");
      expect(w.log.at(-1)).toBe("exec:z@r1");
    });
  });
});
