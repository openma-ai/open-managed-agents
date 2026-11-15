import { describe, expect, it } from "vitest";
import type { SandboxPorts, SandboxPlan } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";
import { LIFETIME_REFRESH_MARGIN_MS, MAX_TOOL_CALL_MS } from "../src/session-sandbox-lifetime";
import { SessionSandboxStateConflictError } from "../src/session-sandbox-live";
import type { SessionSandboxExecution, SessionSandboxExecutor } from "../src/session-sandbox-options";
import { initialSandboxState, transition, recordedHandle, type LatestSnapshot, type SessionSandboxState, type SnapshotRef } from "../src/session-sandbox-state";

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
  return { log, store, clock, gates, core, markers };
}

/** The record of a writer that got there first: its sandbox is running. */
const winner = (runtimeId: string, latestSnapshot: LatestSnapshot = { status: "none" }): SessionSandboxState =>
  ({ ...initialSandboxState(), phase: "running", handle: fake(runtimeId), runStartedAt: 1, latestSnapshot });
/** ...or it paused the sandbox. */
const pausedWinner = (runtimeId: string): SessionSandboxState =>
  ({ ...initialSandboxState(), phase: "paused", handle: fake(runtimeId), pauseRef: { provider: "fake", ref: `pause-${runtimeId}`, kind: "self" } });


it('metadata rebase cannot accept intervening same-handle lifecycle ABA',async()=>{const w=world();const a=w.core({execution:attempt});let once=true;w.gates.onStorage=async()=>{if(!once)return;once=false;const saved=w.store.get()!;let next=transition(saved,{type:'idlePause',pauseRef:{provider:'fake',ref:'r1',kind:'self'}});await w.store.state.save(next,saved.version);let current=w.store.get()!;next=transition(current,{type:'attach',handle:fake('r1'),at:saved.runStartedAt});await w.store.state.save(next,current.version);current=w.store.get()!;next=transition(current,{type:'retireHandle',handle:fake('loser')});await w.store.state.save(next,current.version)};await expect(a.sandbox.mountSessionOutputs()).rejects.toBeInstanceOf(SessionSandboxStateConflictError);expect(w.log.some(x=>x.startsWith('exec:STALE'))).toBe(false)});
it('metadata rebase still rejects different runtime winner',async()=>{const w=world();const a=w.core({execution:attempt});w.gates.onStorage=async()=>{const saved=w.store.get()!;await w.store.state.save({...winner('other'),version:saved.version+1,retiredHandles:[{handle:fake('loser'),released:false}]},saved.version)};await expect(a.sandbox.mountSessionOutputs()).rejects.toBeInstanceOf(SessionSandboxStateConflictError);expect(w.log).not.toContain('release:other')});

it('metadata rebase must not expose executor from before resumed generation',async()=>{const w=world();const a=w.core({execution:attempt});let once=true;w.gates.onStorage=async()=>{if(!once)return;once=false;const saved=w.store.get()!;let next=transition(saved,{type:'idlePause',pauseRef:{provider:'fake',ref:'r1',kind:'self'}});await w.store.state.save(next,saved.version);w.markers.set('r1','NEW_GENERATION');let current=w.store.get()!;next=transition(current,{type:'attach',handle:fake('r1'),at:saved.runStartedAt});await w.store.state.save(next,current.version);current=w.store.get()!;next=transition(current,{type:'retireHandle',handle:fake('loser')});await w.store.state.save(next,current.version)};const result=await (async()=>{await a.sandbox.mountSessionOutputs();return a.sandbox.exec('STALE')})().catch(e=>e);expect(w.log).not.toContain('exec:STALE@r1')});

it("legacy record without a lifecycle witness cannot rebase even metadata-only advancement",async()=>{
 const w=world({...winner("r1"),version:4});const a=w.core({execution:attempt});
 w.gates.onStorage=async()=>{const saved=w.store.get()!;const next=transition(saved,{type:"retireHandle",handle:fake("legacy-loser")});expect(next.lifecycleRevision).toBeUndefined();await w.store.state.save(next,saved.version)};
 await expect(a.sandbox.mountSessionOutputs()).rejects.toBeInstanceOf(SessionSandboxStateConflictError);
});
it("a stale CAS cannot publish its old lifecycle revision after a persisted ABA",async()=>{
 const initial={...winner("r1"),version:1,lifecycleRevision:9};const store=versionedStore(initial);
 const paused=transition(initial,{type:"idlePause",pauseRef:{provider:"fake",ref:"r1",kind:"self"}});await store.state.save(paused,1);
 const resumed=transition(JSON.parse(JSON.stringify(store.get())),{type:"attach",handle:fake("r1"),at:1});await store.state.save(resumed,2);
 expect(await store.state.save(transition(initial,{type:"attach",handle:fake("r1"),at:1}),1)).toBe(false);
 expect(store.get()).toMatchObject({version:3,lifecycleRevision:11});
});
