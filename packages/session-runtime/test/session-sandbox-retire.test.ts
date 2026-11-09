import { expect, it } from "vitest";
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
  await f.core().apply(f.get(), { type: "attach", handle: winner, at: 2 });
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
  await f.core().apply(f.get(),{type:"attach",handle:winner,at:2});
  expect(f.released).toEqual(["old"]);
});
