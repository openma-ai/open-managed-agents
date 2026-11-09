import { expect, it, vi, afterEach } from "vitest";
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

afterEach(()=>vi.useRealTimers());
it('independent apply does not invoke or await old provider cleanup',async()=>{const f=fixture();f.release(async()=>{throw Error('down')});await f.core().releaseOwn(old);let called=0;f.release(()=>{called++;return new Promise(()=>{})});const result=await f.core().apply(f.get(),{type:'attach',handle:winner,at:3});expect(called).toBe(0);expect(result).toMatchObject({handle:winner})});
it('independent claim contention stops after three CAS attempts',async()=>{const f=fixture();let saves=0;f.state.save=async()=>{saves++;return false};await expect(f.core().releaseOwn(old)).rejects.toThrow('three');expect(saves).toBe(3);expect(f.released).toEqual([])});
it('independent lost fence cannot acknowledge provider success',async()=>{const f=fixture();const core=f.core();let current=true;core.options.isCurrent=async()=>current;f.release(async()=>{current=false});await core.releaseOwn(old);expect(f.get().retiredHandles?.[0].released).toBe(false)});
it('maintenance must eventually attempt later retired handles when first permanently fails',async()=>{const f=fixture();f.release(async h=>{if(h.runtimeId==='old')throw Error('permanently missing or denied')});const core=f.core();await core.releaseOwn(old);await core.releaseOwn({provider:'fake',runtimeId:'later'});for(let i=0;i<5;i++)await core.retryReleases(f.get());expect(f.released).toContain('later')});
it('provider timeout must not permit overlapping releases on later ticks',async()=>{vi.useFakeTimers();const f=fixture();f.release(async()=>{throw Error('seed')});const core=f.core();await core.releaseOwn(old);let active=0,max=0;const finish:Array<()=>void>=[];f.release(()=>{active++;max=Math.max(max,active);return new Promise<void>(r=>finish.push(()=>{active--;r()}))});for(let i=0;i<3;i++){const pending=core.retryReleases(f.get());await vi.advanceTimersByTimeAsync(1001);await pending}for(const end of finish)end();expect(max).toBe(1)});

it('maintenance database acknowledgement hang must not block bounded tick',async()=>{vi.useFakeTimers();const f=fixture();f.release(async()=>{throw Error('seed')});const core=f.core();await core.releaseOwn(old);const save=f.state.save;let finish!:()=>void;f.release(async()=>{f.state.save=(next,v)=>new Promise<boolean>(r=>finish=()=>{void save(next,v).then(r)})});let done=false;const pending=core.retryReleases(f.get()).then(()=>done=true);await vi.advanceTimersByTimeAsync(60000);const observed=done;finish();await pending;expect(observed).toBe(true)});

it("a maintenance read resolving after its deadline cannot initiate an acknowledgement", async () => {
  vi.useFakeTimers(); const f=fixture(),core=f.core();
  f.release(async()=>{throw Error("seed")}); await core.releaseOwn(old);
  let finish!:()=>void, saves=0; const load=f.state.load;
  f.release(async()=>{f.state.load=()=>new Promise(r=>finish=()=>{void load().then(r)});});
  const save=f.state.save; f.state.save=async(next,v)=>{saves++;return save(next,v)};
  const tick=core.retryReleases(f.get()); await vi.advanceTimersByTimeAsync(1001); await tick;
  finish(); await vi.advanceTimersByTimeAsync(0); expect(saves).toBe(0);
});
it("cleanup acknowledgement advances an already armed idle version without delaying its deadline", async () => {
  const f=fixture(),core=f.core();f.release(async()=>{throw Error("seed")});await core.releaseOwn(old);
  core.idleVersion=f.get().version;core.idleSince=100;core.options.now=()=>400;
  const scheduled:Array<[number,number|undefined]>=[];
  core.options.idle={pauseMs:1000,schedule:async(delay,v)=>{scheduled.push([delay,v])},cancel:async()=>{}};
  f.release(async()=>{});await core.retryReleases(f.get());
  expect(scheduled).toEqual([[700,f.get().version]]);
});
