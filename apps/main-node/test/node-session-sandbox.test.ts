// The Node Session sandbox (packages/control-plane-node/src/lib/node-session-sandbox.ts):
// the shared core under the Node composition. Memory and outputs go through
// the storage Port, the idle pause runs on a process timer, and the execution
// fence decides what may be written back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { fromV1SandboxFactory } from "../../../packages/sandbox-port-kit/src/v1-bridge";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";

import {
  DEFAULT_SANDBOX_IDLE_PAUSE_MS,
  NodeSessionSandboxes,
  nodeCredentialEgress,
  sandboxIdlePauseMs,
  type NodeSessionSandboxOptions,
} from "../../../packages/control-plane-node/src/lib/node-session-sandbox.js";

const IDLE_MS = 60_000;
it("retries real Node managed cleanup after exit confirmation times out",async()=>{
 const root=await mkdtemp(join(process.cwd(),".node-cleanup-retry-"));const runtime=new LocalSubprocessSandbox({workdir:root});
 const handle=await runtime.startManagedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{}});
 const t=setup();t.box.sandbox.destroy=()=>runtime.destroy();const sandbox=t.sandboxes.build(context);await sandbox.open();
 const original=ChildProcess.prototype.kill;const blocked=vi.spyOn(ChildProcess.prototype,"kill").mockImplementation(function(this:ChildProcess,signal){return this.pid===handle.pid?true:original.call(this,signal);});
 try {
  await expect(sandbox.destroy()).rejects.toMatchObject({code:"MANAGED_PROCESS_CLEANUP_FAILED"});
  expect(t.sandboxes.get(context)).toBe(sandbox);expect(existsSync(root)).toBe(true);expect(()=>process.kill(handle.pid,0)).not.toThrow();
  blocked.mockRestore();await sandbox.destroy();
  expect(existsSync(root)).toBe(false);expect(()=>process.kill(handle.pid,0)).toThrow();expect(()=>t.sandboxes.get(context)).toThrow(/no sandbox/);
 }finally{blocked.mockRestore();await runtime.destroy();await rm(root,{recursive:true,force:true});}
},10_000);
it("keeps Node cleanup ownership and retries a managed release failure",async()=>{
 const t=setup();let attempts=0;let clean=false;
 const failure=Object.assign(new AggregateError([],"unconfirmed exit"),{code:"MANAGED_PROCESS_CLEANUP_FAILED"});
 t.box.sandbox.destroy=async()=>{attempts++;if(!clean)throw failure;};
 const sandbox=t.sandboxes.build(context);await sandbox.open();
 await expect(sandbox.destroy()).rejects.toBe(failure);
 expect(t.sandboxes.get(context)).toBe(sandbox);
 clean=true;await sandbox.destroy();expect(attempts).toBe(2);
 expect(()=>t.sandboxes.get(context)).toThrow(/no sandbox/);
});

it("keeps Node release ownership until Session-end cleanup succeeds",async()=>{
 const t=setup();let attempts=0;let clean=false;
 const failure=Object.assign(new AggregateError([],"unconfirmed exit"),{code:"MANAGED_PROCESS_CLEANUP_FAILED"});
 t.box.sandbox.destroy=async()=>{attempts++;if(!clean)throw failure;};
 const sandbox=t.sandboxes.build(context);await sandbox.open();
 await expect(sandbox.release()).rejects.toBe(failure);
 expect(t.sandboxes.get(context)).toBe(sandbox);
 clean=true;await sandbox.release();expect(attempts).toBe(2);
 expect(()=>t.sandboxes.get(context)).toThrow(/no sandbox/);
});
it("retains launch cleanup ownership when the post-launch Work lookup throws", async () => {
 const t=setup();let launched=false;let killed=0;
 Object.assign(t.box.sandbox,{startManagedProcess:async()=>{launched=true;return{id:"native",pid:1,getStatus:async()=>"running",kill:async()=>{killed++;}};}});
 const sandbox=t.sandboxes.build({...context,workAuthority:{
  attempt:{workspaceId:"ws_1",sessionId:"sess_1",executionId:"work",attemptId:"environment-work-claim:1",ownerId:"env_1",generation:1},
  isCurrent:async()=>{if(launched)throw new Error("lookup unavailable");return true;},token:async()=>"token",
 }});
 await sandbox.open();
 await expect(sandbox.startManagedProcess({command:"/bin/true",env:{}})).rejects.toThrow("lookup unavailable");
 expect(killed).toBe(1);
});

it.each(["workspace", "session", "physical"] as const)("isolates pending management discovery by %s and reclaims it on settle", async dimension => {
 const states = new Map<string, import("@open-managed-agents/session-runtime").SessionSandboxState>();
 const records = {load:async(w:string,s:string)=>states.get(w+":"+s),save:async(w:string,s:string,state:import("@open-managed-agents/session-runtime").SessionSandboxState,expected:number)=>{if((states.get(w+":"+s)?.version??0)!==expected)return false;states.set(w+":"+s,state);return true;}};
 const t=setup({records});let inspected=0;let restored=0;let originalRestored=0;let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const authority=(c:typeof context)=>({attempt:{workspaceId:c.workspaceId,sessionId:c.session.id,executionId:"work",attemptId:"claim:2",ownerId:"owner",generation:2},isCurrent:async()=>true,token:async()=>"token"});
 const locator=(c:typeof context)=>({sandboxId:"physical",id:"old",epoch:"epoch",pid:1234,identity:{workspaceId:c.workspaceId,sessionId:c.session.id,workId:"work",attemptId:"claim:1"},status:"running" as const});
 const handle={id:"old",pid:1234,kill:async()=>{},getStatus:async()=>"running" as const};
 Object.assign(t.box.sandbox,{startManagedProcess:async()=>handle,inspectManagedProcessSlot:async()=>{inspected++;await gate;return locator(context);},restoreManagedProcess:async()=>{originalRestored++;return handle;}});
 const first=t.sandboxes.build({...context,workAuthority:authority(context)});await first.open();
 const pending=first.recoverManagedProcessSlot();
 while(inspected===0)await new Promise(resolve=>setTimeout(resolve,1));
 const other={...context,workspaceId:dimension==="workspace"?"ws_2":context.workspaceId,session:dimension==="session"?{...context.session,id:"sess_2"}:context.session};
 // Reuse the same physical handle for workspace/session cases. For physical,
 // let the existing lifecycle create a replacement from an absent record.
 const original=states.get("ws_1:sess_1")!;
 if(dimension==="physical")states.delete("ws_1:sess_1");else states.set(other.workspaceId+":"+other.session.id,original);
 const second=t.sandboxes.build({...other,workAuthority:authority(other)});await second.open();
 Object.assign(t.box.sandbox,{inspectManagedProcessSlot:async()=>{inspected++;return locator(other);},restoreManagedProcess:async()=>{restored++;return handle;}});
 try {
  await expect(second.recoverManagedProcessSlot()).resolves.toMatchObject({handle});
  expect(inspected).toBe(2);expect(restored).toBe(1);
  release();await expect(pending).resolves.toMatchObject({handle});
  expect(originalRestored,"pending discovery must retain its original launcher capability").toBe(1);
  await expect(second.recoverManagedProcessSlot()).resolves.toMatchObject({handle});
  expect(inspected).toBe(3);
 }finally{release();await pending.catch(()=>{});await second.destroy();}
});

it("does not transfer a settled discovery result to a different claim wrapper", async()=>{
 const states=new Map<string, import("@open-managed-agents/session-runtime").SessionSandboxState>();
 const t=setup({records:{load:async(w,s)=>states.get(w+":"+s),save:async(w,s,state)=>{states.set(w+":"+s,state);return true;}}});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let inspected=0;
 const handle={id:"old",pid:1234,kill:async()=>{},getStatus:async()=>"running" as const};
 Object.assign(t.box.sandbox,{startManagedProcess:async()=>handle,inspectManagedProcessSlot:async()=>{inspected++;await gate;return {identity:{workspaceId:"ws_1",sessionId:"sess_1"}};},restoreManagedProcess:async()=>handle});
 const authority={attempt:{workspaceId:"ws_1",sessionId:"sess_1",executionId:"work",attemptId:"claim:2",ownerId:"owner",generation:2},isCurrent:async()=>true,token:async()=>"token"};
 const first=t.sandboxes.build({...context,workAuthority:authority});await first.open();const pending=first.recoverManagedProcessSlot();
 while(inspected===0)await new Promise(resolve=>setTimeout(resolve,1));
 const second=t.sandboxes.build({...context,workAuthority:{...authority}});await second.open();
 const waiting=expect(second.recoverManagedProcessSlot()).rejects.toThrow(/current claim must rediscover/);
 await new Promise(resolve=>setTimeout(resolve,5));release();
 await pending;await waiting;expect(inspected).toBe(1);
 await second.recoverManagedProcessSlot();expect(inspected).toBe(2);await second.destroy();
});


it.each(["inspect", "restore"] as const)("separates fixed-handle physical incarnations while old %s remains pending", async phase => {
 const states=new Map<string,import("@open-managed-agents/session-runtime").SessionSandboxState>();
 const records={load:async(w:string,s:string)=>states.get(w+":"+s),save:async(w:string,s:string,next:import("@open-managed-agents/session-runtime").SessionSandboxState,version:number)=>{if((states.get(w+":"+s)?.version??0)!==version)return false;states.set(w+":"+s,next);return true;}};
 const old=fakeSandbox(),fresh=fakeSandbox();let runtime=old.sandbox;let oldCurrent=true;let oldInspects=0,newInspects=0,oldRestores=0,newRestores=0;
 let releaseOld!:()=>void,releaseNew!:()=>void;
 const oldGate=new Promise<void>(resolve=>{releaseOld=resolve;}),newGate=new Promise<void>(resolve=>{releaseNew=resolve;});
 const locator={sandboxId:"physical",id:"old",epoch:"epoch",pid:123,identity:{workspaceId:"ws_1",sessionId:"sess_1",workId:"work",attemptId:"claim:1"},status:"running" as const};
 const handle={id:"old",pid:123,kill:async()=>{},getStatus:async()=>"running" as const};
 Object.assign(old.sandbox,{startManagedProcess:async()=>handle,inspectManagedProcessSlot:async()=>{oldInspects++;if(phase==="inspect")await oldGate;return locator;},restoreManagedProcess:async()=>{oldRestores++;if(phase==="restore")await oldGate;return handle;}});
 Object.assign(fresh.sandbox,{startManagedProcess:async()=>handle,inspectManagedProcessSlot:async()=>{newInspects++;await newGate;return locator;},restoreManagedProcess:async()=>{newRestores++;return handle;}});
 const adapter=fromV1SandboxFactory({name:"fixed-test",create:async()=>runtime});const fixed={provider:"fixed-test",runtimeId:"logical-session"};
 Object.assign(adapter.lifecycle,{handle:"fixed",acquire:async()=>({runtime,handle:fixed}),attach:async()=>({runtime,handle:fixed}),release:async()=>{}});
 const t=setup({records,adapter:{adapter,image:()=>"image",keepAliveMs:60_000},storage:{attach:async()=>{},synchronize:async()=>{}}});
 const authority=(current:()=>boolean)=>({attempt:{workspaceId:"ws_1",sessionId:"sess_1",executionId:"work",attemptId:"claim:2",ownerId:"owner",generation:2},isCurrent:async()=>current(),token:async()=>"token"});
 const first=t.sandboxes.build({...context,workAuthority:authority(()=>oldCurrent)});await first.open();
 const marker1=await old.sandbox.readFile("/tmp/.oma-warm");expect(marker1).not.toBe("");
 const pending=first.recoverManagedProcessSlot().then(value=>({value}),error=>({error}));
 while((phase==="inspect"?oldInspects:oldRestores)===0)await new Promise(resolve=>setTimeout(resolve,1));
 runtime=fresh.sandbox;oldCurrent=false;
 const second=t.sandboxes.build({...context,workAuthority:authority(()=>true)});await second.open();
 const marker2=await fresh.sandbox.readFile("/tmp/.oma-warm");expect(marker2).not.toBe(marker1);
 expect(states.get("ws_1:sess_1")).toMatchObject({handle:fixed});
 const next=second.recoverManagedProcessSlot().then(value=>({value}),error=>({error}));
 try {
  for(let i=0;i<100&&newInspects===0;i++)await new Promise(resolve=>setTimeout(resolve,2));
  expect(newInspects,"fresh marker must not join old physical discovery").toBe(1);
  releaseOld();expect(await pending).toHaveProperty("error");expect(oldRestores).toBe(phase==="restore"?1:0);
  // Settling the old incarnation must not remove the new incarnation's entry.
  const joining=second.recoverManagedProcessSlot().then(value=>({value}),error=>({error}));
  await new Promise(resolve=>setTimeout(resolve,20));expect(newInspects).toBe(1);
  releaseNew();expect(await next).toHaveProperty("value.handle",handle);expect(await joining).toHaveProperty("value.handle",handle);expect(newRestores).toBe(1);
  await second.recoverManagedProcessSlot();expect(newInspects).toBe(2);
 }finally{releaseOld();releaseNew();await pending;await next;await second.destroy();}
});

const context = {
  workspaceId: "ws_1",
  session: { id: "sess_1", resources: [], vaultIds: [], agent: { id: "agent", version: 1 } },
  environment: { id: "env_1", config: { type: "cloud", networking: { type: "unrestricted" } } },
} as unknown as Parameters<NodeSessionSandboxes["build"]>[0];

function fence(attemptId: string): SessionExecutionFence {
  return {
    executionId: `exe_${attemptId}`, workspaceId: "ws_1", sessionId: "sess_1",
    attemptId, ownerId: "owner_1", generation: 1, expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

/** A v1 sandbox that keeps its warm marker, like a real one. */
function fakeSandbox() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  let destroyed = 0;
  const sandbox: SandboxPort = {
    async exec(command) {
      commands.push(command);
      const marker = /^echo (\S+) > \/tmp\/\.oma-warm$/.exec(command);
      if (marker !== null) { files.set("/tmp/.oma-warm", marker[1]!); return "exit=0\n"; }
      if (command.startsWith("cat /tmp/.oma-warm")) {
        const value = files.get("/tmp/.oma-warm");
        return value === undefined ? "exit=1\n" : `exit=0\n${value}\n`;
      }
      return "exit=0\nok";
    },
    async readFile(path) { return files.get(path) ?? ""; },
    async writeFile(path, content) { files.set(path, content); return "ok"; },
    async setEnvVars() {},
    async destroy() { destroyed += 1; },
  };
  return { sandbox, commands, destroyed: () => destroyed, markerReads: () => commands.filter((c) => c.startsWith("cat /tmp/.oma-warm")).length };
}

function setup(overrides: Partial<NodeSessionSandboxOptions> = {}) {
  const box = fakeSandbox();
  const created: string[] = [];
  const attached: Array<{ runtimeGeneration: string; attemptId: string | undefined }> = [];
  const synchronized: Array<{ attemptId: string; runtimeGeneration: string }> = [];
  const warnings: string[] = [];
  let fenceActive = true;
  const options: NodeSessionSandboxOptions = {
    createV1: async () => { created.push("v1"); return box.sandbox; },
    storage: {
      async attach(input) {
        expect(input.sandbox).toBe(box.sandbox);
        attached.push({ runtimeGeneration: input.runtimeGeneration, attemptId: input.executionFence?.attemptId });
      },
      async synchronize(input) {
        expect(input.sandbox).toBe(box.sandbox);
        synchronized.push({ attemptId: input.executionFence.attemptId, runtimeGeneration: input.runtimeGeneration });
      },
    },
    substitutions: async () => [],
    token: async () => "test-token",
    relay: () => null,
    isFenceActive: async () => fenceActive,
    idlePauseMs: IDLE_MS,
    warn: (message) => { warnings.push(message); },
    ...overrides,
  };
  const sandboxes = new NodeSessionSandboxes(options);
  return { box, created, attached, synchronized, warnings, sandboxes, loseFence: () => { fenceActive = false; } };
}

describe("Node Session sandbox", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("attaches Memory and outputs through the storage Port on open and writes them back at execution end under the fence", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    expect(t.sandboxes.get(context)).toBe(sandbox);

    await sandbox.open();
    expect(t.created).toEqual(["v1"]);
    expect(t.attached).toEqual([{ runtimeGeneration: "rt_1", attemptId: "a1" }]);

    await expect(sandbox.exec("echo hi")).resolves.toContain("ok");
    await sandbox.endExecution();
    expect(t.synchronized).toEqual([{ attemptId: "a1", runtimeGeneration: "rt_1" }]);
  });

  it("pauses idlePauseMs after the execution ended; the next execution attaches the same sandbox again", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    await sandbox.endExecution();
    const readsBefore = t.box.markerReads();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    sandbox.bind({ context, executionFence: fence("a2") });
    await sandbox.exec("true");
    // Not paused yet: the running sandbox served the call directly.
    expect(t.box.markerReads()).toBe(readsBefore);

    await sandbox.endExecution();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    sandbox.bind({ context, executionFence: fence("a3") });
    await sandbox.exec("true");
    // Paused, then attached (its warm marker read back), never created again.
    expect(t.box.markerReads()).toBe(readsBefore + 1);
    expect(t.created).toEqual(["v1"]);
    expect(t.attached.map((a) => a.attemptId)).toEqual(["a1", "a3"]);
    // The bare v1 factory has no snapshots: every snapshot attempt says so.
    expect(new Set(t.warnings)).toEqual(new Set(["sandbox_snapshot_unsupported provider=node: the adapter's checkpoint returned the sandbox itself"]));
  });

  it("an execution running when the idle timer fires is not paused", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    await sandbox.endExecution();
    sandbox.bind({ context, executionFence: fence("a2") });

    await expect(sandbox.idlePause()).resolves.toBe("skipped");
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    await sandbox.exec("true");
    expect(t.attached).toHaveLength(1);
  });

  it("a lost fence ends the execution without writing back", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    t.loseFence();

    await sandbox.endExecution();
    expect(t.synchronized).toEqual([]);
    // The new owner attaches the same sandbox: nothing was released.
    expect(t.box.destroyed()).toBe(0);
  });

  it("a failed execution publishes nothing and releases the sandbox", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();

    await sandbox.failExecution();
    expect(t.synchronized).toEqual([]);
    expect(t.box.destroyed()).toBe(1);
  });

  it("destroy forgets the Session's sandbox", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1" });
    await sandbox.open();
    await sandbox.destroy();
    expect(t.box.destroyed()).toBe(1);
    expect(() => t.sandboxes.get(context)).toThrow(/has no sandbox/);
  });
});

describe("Node Session sandbox warm-up at Session creation", () => {
  it("acquires before the first execution, which then attaches the same sandbox", async () => {
    const t = setup();
    await t.sandboxes.warm(context);
    expect(t.created).toEqual(["v1"]);
    expect(t.attached).toEqual([]);
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    expect(t.created).toEqual(["v1"]);
    expect(t.attached).toEqual([{ runtimeGeneration: "rt_1", attemptId: "a1" }]);
  });

  it("warms from sessionStarted only when enabled and the Session has a sandbox", async () => {
    const started: string[] = [];
    const runtime = { sessionStarted: async () => { started.push("start"); }, sessionStopped: async () => { started.push("stop"); } };
    const off = setup();
    expect(off.sandboxes.warmingLifecycle(runtime, async () => "sandbox")).toBe(runtime);
    const on = setup({ warmAtCreate: true });
    const lifecycle = on.sandboxes.warmingLifecycle(runtime, async (session) => session.id === "sess_none" ? "none" : "sandbox");
    await lifecycle.sessionStarted({ ...context, sessionId: "sess_none", session: { ...context.session, id: "sess_none" }, initialEvents: [] } as never);
    await vi.waitFor(() => expect(started).toEqual(["start"]));
    expect(on.created).toEqual([]);
    await lifecycle.sessionStarted({ ...context, sessionId: "sess_1", initialEvents: [] } as never);
    await vi.waitFor(() => expect(on.created).toEqual(["v1"]));
    await lifecycle.sessionStopped({ workspaceId: "ws_1", sessionId: "sess_1", session: { ...context.session, environmentId: "env_1" }, reason: "deleted" } as never);
    expect(started).toEqual(["start", "start", "stop"]);
    expect(on.box.destroyed()).toBe(1);
  });

  it("a first execution that starts while the warm-up is in flight adopts it instead of racing it", async () => {
    const t = setup();
    const warming = t.sandboxes.warm(context);
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await Promise.all([warming, sandbox.open()]);
    expect(t.created).toEqual(["v1"]);
    expect(t.box.destroyed()).toBe(0);
    expect(t.attached).toEqual([{ runtimeGeneration: "rt_1", attemptId: "a1" }]);
  });

  it("releases the warmed sandbox when the Session ends before its first execution", async () => {
    const t = setup();
    await t.sandboxes.warm(context);
    await t.sandboxes.releaseSession(context);
    expect(t.box.destroyed()).toBe(1);
    await t.sandboxes.releaseSession(context);
    expect(t.box.destroyed()).toBe(1);
  });
});

describe("Node Session sandbox whose mounts are fixed when its box is created (LiteBox)", () => {
  /** LiteBox: the first exec creates the box; a new mount after that throws. */
  function fixedMountSandbox() {
    const box = fakeSandbox();
    const mounts = new Set<string>();
    let created = false;
    const exec = box.sandbox.exec.bind(box.sandbox);
    const sandbox: SandboxPort = {
      ...box.sandbox,
      async exec(command, timeout) { created = true; return exec(command, timeout); },
      sessionOutputMountCapabilities: () => ({ durability: "durable" }),
      async mountSessionOutputs({ tenantId, sessionId }) {
        const key = `${tenantId}/${sessionId}`;
        if (mounts.has(key)) return;
        if (created) throw new Error("LiteBoxSandbox.mountSessionOutputs: box already created");
        mounts.add(key);
      },
    };
    return { sandbox, mounts };
  }
  const storage: NodeSessionSandboxOptions["storage"] = {
    async attach(input) { await input.sandbox.mountSessionOutputs({ tenantId: input.workspaceId, sessionId: input.session.id }); },
    async synchronize() {},
  };

  it.each([
    { name: "a first execution", warm: false },
    { name: "a first execution after the warm-up at Session creation", warm: true },
  ])("mounts the outputs before the sandbox's first exec on $name", async ({ warm }) => {
    const box = fixedMountSandbox();
    const t = setup({ createV1: async () => box.sandbox, storage, mountOutputsAtCreate: true });
    if (warm) await t.sandboxes.warm(context);
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    expect([...box.mounts]).toEqual(["ws_1/sess_1"]);
    await expect(sandbox.exec("echo hi")).resolves.toContain("ok");
  });

  it("without mountOutputsAtCreate the egress step's exec creates the box before storage attaches", async () => {
    const box = fixedMountSandbox();
    const t = setup({ createV1: async () => box.sandbox, storage });
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await expect(sandbox.open()).rejects.toThrow(/box already created/u);
  });
});

describe("Vault credential egress guard", () => {
  const issue = async () => "pass";
  const vaultContext = { ...context, session: { ...context.session, vaultIds: ["vlt_1"] } } as typeof context;
  const substitution = { credentialId: "vault:OMA_SECRET", envName: "OMA_SECRET", placeholder: "oma_vault_x", hosts: [], inject: { header: true, body: false } };

  it("has an egress path only with the relay signer and an HTTPS origin", () => {
    expect(nodeCredentialEgress(null)).toBe(false);
    expect(nodeCredentialEgress({ issue, endpoint: "http://localhost:8787" })).toBe(false);
    expect(nodeCredentialEgress({ issue, endpoint: "https://oma.example" })).toBe(true);
    expect(new NodeSessionSandboxes({ relay: () => null } as unknown as NodeSessionSandboxOptions).credentialEgress()).toBe(false);
    expect(new NodeSessionSandboxes({ relay: () => ({ issue, endpoint: "https://oma.example" }) } as unknown as NodeSessionSandboxOptions).credentialEgress()).toBe(true);
  });

  it.each([
    { name: "no relay", relay: () => null },
    { name: "a plain-HTTP origin", relay: () => ({ issue, endpoint: "http://localhost:8787" }) },
  ])("never opens a sandbox with sandbox credentials over $name", async ({ relay }) => {
    const t = setup({ relay, substitutions: async () => [substitution] });
    const sandbox = t.sandboxes.build({ ...vaultContext, executionFence: fence("att_1") });
    await expect(sandbox.open()).rejects.toThrow(/Vault credential egress requires/u);
    expect(t.created).toEqual([]);
  });
});

describe("SANDBOX_IDLE_PAUSE_MS", () => {
  it("defaults to five minutes and rejects anything but a positive integer", () => {
    expect(sandboxIdlePauseMs(undefined)).toBe(DEFAULT_SANDBOX_IDLE_PAUSE_MS);
    expect(DEFAULT_SANDBOX_IDLE_PAUSE_MS).toBe(300_000);
    expect(sandboxIdlePauseMs("90000")).toBe(90_000);
    expect(() => sandboxIdlePauseMs("0")).toThrow(/positive integer/);
    expect(() => sandboxIdlePauseMs("5m")).toThrow(/positive integer/);
  });
});
