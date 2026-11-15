import { expect, it, vi } from "vitest";
import type { SandboxHandle, SandboxPorts } from "@open-managed-agents/sandbox";
import { LiveSessionSandbox } from "../src/session-sandbox-live";
import { initialSandboxState, transition, type SandboxAction, type SessionSandboxState } from "../src/session-sandbox-state";

const old = { provider: "fake", runtimeId: "old" };
const winner = { provider: "fake", runtimeId: "winner" };
function fixture() {
  let record: SessionSandboxState = { ...initialSandboxState(), phase: "running", handle: winner, runStartedAt: 1, version: 2 };
  const released: string[] = [];
  let checks = 0;
  let onCheck = async (_n: number) => {};
  let onRelease = async (_handle: SandboxHandle) => {};
  const state = {
    load: async () => record,
    save: async (next: SessionSandboxState, version: number) => {
      if (record.version !== version) return false;
      record = structuredClone(next); return true;
    },
  };
  const core = () => new LiveSessionSandbox({
    compose: async () => ({ ports: { sandbox: { handle: "changes", maxLifetimeMs: null,
      release: async ({ handle }: { handle: SandboxHandle }) => { await onRelease(handle); released.push(handle.runtimeId); },
    } } as unknown as SandboxPorts<unknown> }),
    state, scope: () => ({ workspaceId: "w", environmentId: "e", sessionId: "s", workId: "s" }),
    isCurrent: async () => { await onCheck(++checks); return true; },
    executor: () => { throw Error("unused"); }, plan: async () => { throw Error("unused"); },
    resumeRef: async () => null, warn: () => {}, outputDurability: () => null, egressRenewMs: null,
  });
  return { core, state, released, get: () => record,
    check: (fn: typeof onCheck) => { onCheck = fn; }, release: (fn: typeof onRelease) => { onRelease = fn; } };
}

it("releaseOwn cannot destroy an allocation republished during its final asynchronous fence check", async () => {
  const f = fixture();
  f.check(async n => { if (n === 2) await f.core().apply(f.get(), { type: "acquire", handle: old, at: 2 }); });
  await f.core().releaseOwn(old);
  expect(f.released).toEqual([]);
  expect(f.get()).toMatchObject({ phase: "running", handle: old });
});

it("an atomic retirement claim prevents all legal publication paths from repointing the allocation", async () => {
  const f = fixture();
  f.release(async () => {
    for (const action of [
      { type: "acquire", handle: old, at: 2 }, { type: "attach", handle: old, at: 2 },
      { type: "renew", handle: old, at: 2 },
      { type: "restoreFromSnapshot", handle: old, at: 2, ref: { provider: "fake", ref: "snap", kind: "snapshot" } },
    ] as SandboxAction[]) expect(() => transition(f.get(), action)).toThrow();
    const paused: SessionSandboxState = { ...f.get(), phase: "paused", handle: winner, pauseRef: { provider: "fake", ref: "winner", kind: "self" } };
    expect(() => transition(paused, { type: "resume", handle: old, at: 2 })).toThrow();
  });
  await f.core().releaseOwn(old);
  expect(f.released).toEqual(["old"]);
  // The tombstone must remain even after vendor success: stale publishers can
  // replan using the latest record, not just their original stale version.
  expect(() => transition(f.get(), { type: "acquire", handle: old, at: 3 })).toThrow();
});

it("failed vendor release stays durable and is retried by a reconstructed owner", async () => {
  const f = fixture();
  f.release(async () => { throw Error("vendor unavailable"); });
  await f.core().releaseOwn(old);
  const persisted = structuredClone(f.get());
  expect(JSON.stringify(persisted)).toContain('"old"');
  f.release(async () => {});
  await f.core().retryReleases(f.get());
  expect(f.released).toEqual(["old"]);
  expect(() => transition(f.get(), { type: "acquire", handle: old, at: 3 })).toThrow();
});

it("ordinary rollback retires its recorded allocation before any asynchronous release boundary", async () => {
  const { rollbackOpen } = await import("../src/session-sandbox-open");
  const f=fixture();const core=f.core();
  Object.assign((await core.compose()).ports,{egress:{revoke:async()=>{}}});
  const record=f.get();
  f.release(async () => {
    expect(() => transition(f.get(),{type:"acquire",handle:winner,at:3})).toThrow();
  });
  await rollbackOpen(core,{runtime:{},handle:winner},record,undefined,true);
  expect(f.released).toEqual(["winner"]);
  expect(f.get()).toMatchObject({phase:"lost"});
});

it("retirement CAS loses safely to a legal republisher", async () => {
  const f=fixture();const save=f.state.save;let race=true;
  f.state.save=async(next,version)=>{
    if(race){race=false;await f.core().apply(f.get(),{type:"acquire",handle:old,at:2});}
    return save(next,version);
  };
  await f.core().releaseOwn(old);
  expect(f.released).toEqual([]);
  expect(f.get()).toMatchObject({phase:"running",handle:old});
});
it("fence loss after retirement leaves durable cleanup for a later owner", async () => {
  const f=fixture();const core=f.core();let checks=0;
  core.options.isCurrent=async()=>++checks<3;
  await core.releaseOwn(old);
  expect(f.released).toEqual([]);
  expect(f.get()).toMatchObject({retiredHandles:[{handle:old,released:false}]});
  await f.core().retryReleases(f.get());
  expect(f.released).toEqual(["old"]);
});

it("lifecycle publication is independent of a hung old release", async () => {
  const f=fixture();f.release(async()=>{throw Error("down");});await f.core().releaseOwn(old);
  let finish!:()=>void;const blocked=new Promise<void>(r=>{finish=r;});f.release(()=>blocked);
  const core=f.core();let settled=false;
  const apply=core.apply(f.get(),{type:"attach",handle:winner,at:3}).then(result=>{settled=true;return result;});
  await new Promise(r=>setTimeout(r,30));const observed=settled;finish();await apply;
  expect(observed).toBe(true);
});
it("release acknowledgement cannot replace the lifecycle publication with another writer", async () => {
  const f=fixture();f.release(async()=>{throw Error("down");});await f.core().releaseOwn(old);
  f.release(async()=>{const saved=f.get();await f.state.save(transition(saved,{type:"acquire",handle:{provider:"fake",runtimeId:"other"},at:4}),saved.version);});
  const result=await f.core().apply(f.get(),{type:"attach",handle:winner,at:3});
  expect(result===null||(result.phase==="running"&&result.handle.runtimeId==="winner")).toBe(true);
});
it("retirement contention is bounded", async()=>{
  const f=fixture();const save=f.state.save;let tries=0;f.state.save=async(next,v)=>{if(++tries<26)return false;return save(next,v);};
  await expect(f.core().releaseOwn(old)).rejects.toThrow("CAS conflicted three times");expect(tries).toBe(3);
});
it("a fence lost during release cannot acknowledge cleanup", async()=>{
  const f=fixture();const core=f.core();let current=true,saves=0;core.options.isCurrent=async()=>current;
  const save=f.state.save;f.release(async()=>{current=false;f.state.save=async(next,v)=>{saves++;return save(next,v);};});
  await core.releaseOwn(old);expect(saves).toBe(0);expect(f.get()).toMatchObject({retiredHandles:[{handle:old,released:false}]});
});

it("maintenance times out a hung provider and coalesces concurrent callers", async()=>{
  vi.useFakeTimers();
  try {
    const f=fixture();f.release(async()=>{throw Error("down");});await f.core().releaseOwn(old);
    let calls=0;f.release(()=>{calls++;return new Promise<void>(()=>{});});
    const core=f.core();const first=core.retryReleases(f.get()),second=core.retryReleases(f.get());
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(1000);await first;
    expect(calls).toBe(1);
    expect(f.get()).toMatchObject({retiredHandles:[{handle:old,released:false}]});
  } finally {vi.useRealTimers();}
});
it("cleanup acknowledgement contention stops after three CAS attempts with pending retained", async()=>{
  const f=fixture();const core=f.core();let tries=0;
  f.release(async()=>{f.state.save=async()=>{tries++;return false;};});
  await core.releaseOwn(old);
  expect(tries).toBe(3);expect(f.get()).toMatchObject({retiredHandles:[{handle:old,released:false}]});
});
