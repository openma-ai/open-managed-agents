import assert from 'node:assert/strict';
import { it } from 'vitest';
import { LiveSessionSandbox } from '../src/session-sandbox-live.ts';
import { takeSnapshot } from '../src/session-sandbox-snapshot.ts';
import { transition, initialSandboxState } from '../src/session-sandbox-state.ts';
import { failExecution } from '../src/session-sandbox-execution-end.ts';
import { PortsSessionSandbox } from '../src/ports-session-sandbox.ts';
const scope={workspaceId:'ws',environmentId:'env',sessionId:'s',workId:'w'};
const handle={provider:'fake',runtimeId:'r'};
const running=()=>({...initialSandboxState(),phase:'running',handle,runStartedAt:0,version:1,lifecycleRevision:1});
function stateFixture(overrides: any={}) {
 let saved: any=running();const trace: string[]=[];
 const ports={sandbox:{handle:'changes',discard:async({ref})=>trace.push('discard:'+ref.ref),release:async()=>{trace.push('release');throw new Error('temporary provider failure')},checkpoint:async()=>({provider:'fake',ref:'new',kind:'snapshot'}),...overrides.sandbox},egress:{revoke:async()=>{}},storage:{detach:async()=>{}}};
 const options={compose:async()=>({ports}),scope:()=>scope,execution:()=>undefined,isCurrent:async()=>true,state:{load:async()=>saved,save:async(next,version)=>{if(saved.version!==version)return false;saved=next;return true}},warn:()=>{},...overrides.options};
 const state=new LiveSessionSandbox(options as any);state.current={handle,runtime:{},plan:{outputs:null},runStartedAt:0} as any;
 return {state,ports,options,trace,get:()=>saved,set:x=>saved=x};
}
it('F3: rejected snapshot retains dirty changes for retry', async () => {
 const f=stateFixture();f.state.dirty=true;
 f.ports.sandbox.checkpoint=async()=>{f.set(transition(f.get(),{type:'retireHandle',handle:{provider:'fake',runtimeId:'old'}}));return {provider:'fake',ref:'new',kind:'snapshot'}};
 const first=await takeSnapshot(f.state,f.state.current,undefined);
 assert.equal(first,'conflict');assert.equal(f.state.dirty,true);
 f.ports.sandbox.checkpoint=async()=>({provider:'fake',ref:'retry',kind:'snapshot'});
 await takeSnapshot(f.state,f.state.current,undefined);
 assert.equal(f.get().latestSnapshot.ref.ref,'retry');assert.deepEqual(f.trace,['discard:new']);
});
it('F4: failed provider release retains durable cleanup ownership', async () => {
 const f=stateFixture();await failExecution(f.state);
 assert.equal(f.get().phase,'lost');assert.equal(f.state.current,null);assert.equal(f.get().retiredHandles[0].handle.runtimeId,'r');assert.equal(f.get().retiredHandles[0].released,false);
});
it('F2: terminal CAS precedes provider release and metadata races', async () => {
 const f=stateFixture();f.ports.sandbox.release=async()=>{f.trace.push('release');f.set(transition(f.get(),{type:'retireHandle',handle:{provider:'fake',runtimeId:'older-allocation'}}));};
 const core=new PortsSessionSandbox(f.options as any);await core.destroy();
 assert.equal(f.get().phase,'released');assert.ok(f.get().retiredHandles.some(x=>x.handle.runtimeId==='r'&&x.released));
});
it('F1: post-commit cleanup failure never discards the committed snapshot', async () => {
 const f=stateFixture();f.state.dirty=true;
 f.set({...running(),latestSnapshot:{status:'taken',ref:{provider:'fake',ref:'old',kind:'snapshot'}}});
 const save=f.options.state.save;let writes=0;
 f.options.state.save=async(next,expected)=>{if(++writes===2)throw new Error('DB failed while acknowledging old discard');return save(next,expected)};
 await takeSnapshot(f.state,f.state.current,undefined);
 assert.equal(f.get().latestSnapshot.ref.ref,'new');assert.ok(!f.trace.includes('discard:new'));
});
it('F5: slow successful cleanup is acknowledged without a second release', async () => {
 let now=0,calls=0;
 const f=stateFixture({options:{now:()=>now},sandbox:{release:async()=>{calls++;now+=1500}}});
 f.set({...running(),retiredHandles:[{handle:{provider:'fake',runtimeId:'old'},released:false}]});
 await f.state.retryReleases(f.get());await f.state.retryReleases(f.get());
 assert.equal(calls,1);assert.equal(f.get().retiredHandles[0].released,true);
});

it('F1: a lost save response reads back the committed snapshot before cleanup', async () => {
 const f=stateFixture();f.state.dirty=true;const save=f.options.state.save;
 let first=true;f.options.state.save=async(next,version)=>{const committed=await save(next,version);if(first){first=false;throw Error('response lost after commit');}return committed;};
 await takeSnapshot(f.state,f.state.current!,undefined);
 assert.equal(f.get().latestSnapshot.ref.ref,'new');assert.ok(!f.trace.includes('discard:new'));
});
it('F1: referenced snapshots cannot be queued or deleted by a stale cleanup candidate',async()=>{
 const f=stateFixture();const ref={provider:'fake',kind:'snapshot' as const,ref:'live'};
 f.set({...running(),latestSnapshot:{status:'taken',ref}});
 await f.state.discard(ref);assert.ok(!f.trace.includes('discard:live'));
});
it('F2: persistent terminal CAS conflict surfaces without physical deletion',async()=>{
 const f=stateFixture();f.options.state.save=async()=>false;
 await assert.rejects(new PortsSessionSandbox(f.options as any).destroy(),/terminal/);
 assert.equal(f.get().phase,'running');assert.deepEqual(f.trace,[]);
});
it('F4: restart retains the exact failed allocation for cleanup, not its successor',async()=>{
 const f=stateFixture();await failExecution(f.state);const old=f.get().retiredHandles[0].handle;
 f.ports.sandbox.release=async({handle}:any)=>{assert.deepEqual(handle,old);f.trace.push('recovered-release');};
 f.set({...f.get(),phase:'running',handle:{provider:'fake',runtimeId:'successor'}});
 const restarted=new LiveSessionSandbox(f.options as any);
 await restarted.retryReleases(f.get());assert.equal(f.get().retiredHandles[0].released,true);assert.equal(f.get().handle.runtimeId,'successor');
});
it('F5: actual fence loss during slow cleanup leaves acknowledgement for a new owner',async()=>{
 let current=true;const f=stateFixture({options:{isCurrent:async()=>current},sandbox:{release:async()=>{current=false;}}});
 f.set({...running(),retiredHandles:[{handle:{provider:'fake',runtimeId:'old'},released:false}]});
 await f.state.retryReleases(f.get());assert.equal(f.get().retiredHandles[0].released,false);
});
