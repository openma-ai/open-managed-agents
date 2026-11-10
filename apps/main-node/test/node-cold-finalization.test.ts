import { expect, it } from "vitest";
import { coldFixture } from "./node-cold-finalization.fixture.js";
import { nodeDefaults } from "../src/components.js";
import { createNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-runtime.js";
import { Disposables } from "../../../packages/control-plane-node/src/lifecycle.js";

// A reconnectable directory is NOT evidence of the management process identity.
it("cold LocalSubprocess explicitly refuses unprovable process identity without creating a sandbox", async () => {
  const f = await coldFixture();
  const disposables = new Disposables();
  try {
    const b = await createNodeRuntime(await nodeDefaults(f.config), disposables, {current:null});
    const scope = {claim:f.claim, turnId:f.turnId, revision:f.revision, isCurrent:async()=>true};
    await expect(b.workFinalizationHost.prepare(scope)).rejects.toThrow(/Trusted Work process reconnect unsupported/);
    expect(await f.checkpoint()).toBeNull();
    expect(await f.sandbox.exec("printf original")).toBe("original");
  } finally { await disposables.dispose(); }
});

import { coldProvider } from "./node-cold-finalization-provider.fixture.js";
import { serve } from "@hono/node-server";
import { mountNodeHttp } from "../../../packages/control-plane-node/src/modules/node-http.js";

async function peer(f: Awaited<ReturnType<typeof coldFixture>>, provider: Awaited<ReturnType<typeof coldProvider>>) {
 const disposables=new Disposables();
 const b=await createNodeRuntime(await nodeDefaults({...f.config,execution:{...f.config.execution,ownerId:"cold-node-B"}}, {sessionSandboxAdapter:provider.adapter}),disposables,{current:null});
 const app=await mountNodeHttp(b,disposables,b.workFinalizationHost);
 const server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});if(!server.listening)await new Promise<void>(r=>server.once("listening",r));
 const request=(action:string,body:object={})=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}${f.path}/work-${action}`,{method:"POST",headers:{authorization:"Bearer "+f.token,"content-type":"application/json"},body:JSON.stringify({turnId:f.turnId,...(action==="recovery"?{}:{revision:f.revision}),...body})});
 return {b,request,close:async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await disposables.dispose();}};
}

it("independent Node B attaches exact E2B port, archives real bytes and publishes terminal without allocation/model replay",async()=>{
 const f=await coldFixture();await f.sandbox.writeFile("proof.txt","original runtime data");
 const provider=await coldProvider(f);const p=await peer(f,provider);
 try {
   const result=await p.request("finalize",{stopReason:{type:"end_turn"}});
   expect(result.status,await result.clone().text()).toBe(200);
   const done=await result.json() as any;
   expect(await f.checkpoint()).not.toBeNull();
   expect((await p.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId})).status).toBe(200);
   expect((await p.request("recovery")).status).toBe(200);
   expect(provider.operations).not.toContain("create");
   expect((await f.sql.prepare("SELECT COUNT(*) n FROM managed_session_events WHERE type='span.model_request_start'").first())!.n).toBe(0);
   expect((await f.sql.prepare("SELECT COUNT(*) n FROM managed_session_events WHERE type='session.status_idle'").first())!.n).toBe(1);
 }finally{await p.close();await provider.close();}
});

it("same-generation rotated holder cannot publish old process even after terminal",async()=>{
 const f=await coldFixture();const done=await (await f.request("finalize",{stopReason:{type:"end_turn"}})).json() as any;
 const provider=await coldProvider(f);const p=await peer(f,provider);
 try {
   await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:"f".repeat(64),s:"all"}]),f.claim.workId).run();
   expect((await p.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId})).status).toBe(502);
 }finally{await p.close();await provider.close();}
});

import { environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index.js";
it("Work dispatcher restore uses the canonical checkpoint bytes including native state; corrupt archives fail closed",async()=>{
 const f=await coldFixture();
 await f.sandbox.writeFile("proof.txt","checkpoint before crash");
 await f.sandbox.writeFile("/oma/harness-state/native.json",'{"session":"completed-native"}');
 expect((await f.request("checkpoint")).status).toBe(200);
 await f.sandbox.writeFile("proof.txt","uncommitted data");
 await f.sandbox.writeFile("/oma/harness-state/native.json","lost");
 // Explicit fresh allocation seam; restore must never be run on an attached
 // live Work process. The dispatcher checks this before calling the seam.
 const saved=JSON.parse((await f.checkpoint())!.candidate_json);
 const key=saved.metadata["openma.workspace.blob-key.v1"];
 const blob=(await f.runtime.filesBlob.get(key))!;
 const bytes=new Uint8Array(await new Response(blob.body).arrayBuffer());
 await f.runtime.filesBlob.delete(key);
 await expect(f.runtime.sessionSandboxes.restoreWorkCheckpoint(f.sandbox,environmentWorkSandboxTokenRef(f.claim))).rejects.toThrow(/missing/);
 await f.runtime.filesBlob.put(key,bytes);
 await f.runtime.sessionSandboxes.restoreWorkCheckpoint(f.sandbox,environmentWorkSandboxTokenRef(f.claim));
 expect(await f.sandbox.readFile("proof.txt")).toBe("checkpoint before crash");
 expect(await f.sandbox.readFile("/oma/harness-state/native.json")).toBe('{"session":"completed-native"}');
});

it.each(["work","epoch","holder","runtime","expired","generation"])("cold host refuses %s mismatch without checkpoint or runtime replacement",async kind=>{
 const f=await coldFixture();const provider=await coldProvider(f);const p=await peer(f,provider);
 try {
   if(kind==="work")provider.locator.identity.workId="unrelated-work";
   if(kind==="holder")provider.locator.holderHash="e".repeat(64);
   if(kind==="runtime")provider.locator.sandboxId="wrong-runtime";
   if(kind==="epoch")provider.locator.epoch="";
   if(kind==="expired")await f.sql.prepare("UPDATE managed_environment_work SET claim_at=0 WHERE id=?").bind(f.claim.workId).run();
   if(kind==="generation")await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=2 WHERE id=?").bind(f.claim.workId).run();
   const response=await p.request("checkpoint");expect(response.status).toBeGreaterThanOrEqual(400);
   expect(await f.checkpoint()).toBeNull();expect(provider.operations).not.toContain("create");
   expect(await f.sandbox.exec("printf alive")).toBe("alive");
 }finally{await p.close();await provider.close();}
});

it("cleanup owner generation is separate from immutable terminal source; running old source cannot be adopted",async()=>{
 const f=await coldFixture();const done=await (await f.request("finalize",{stopReason:{type:"end_turn"}})).json() as any;
 const provider=await coldProvider(f);const p=await peer(f,provider);
 try {
   const terminalBefore=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(done.terminal.eventId).first();
   await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=2,claim_worker_id='cleanup-B',sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:"f".repeat(64),s:"all"}]),f.claim.workId).run();
   const {WorkFinalizationApplication}=await import("@open-managed-agents/managed-agents-application");
   const {SqlWorkFinalization}=await import("@open-managed-agents/managed-agents-adapters-sql");
   const app=new WorkFinalizationApplication({persistence:new SqlWorkFinalization(p.b.sql),host:p.b.workFinalizationHost});
   const input={claim:{...f.claim,generation:2,holder:"cleanup-B"},turnId:f.turnId,revision:done.revision,terminalEventId:done.terminal.eventId};
   expect(await app.publish(input)).toMatchObject({type:"failed"});
   provider.locator.status="exited";
   expect(await app.publish(input)).toMatchObject({type:"published",terminal:{generation:1,eventId:done.terminal.eventId}});
   expect(await app.recover(input)).toMatchObject({type:"committed",terminal:{generation:1}});
   expect((await f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId})).status).toBe(401);
   expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(done.terminal.eventId).first()).toEqual(terminalBefore);
   expect(provider.operations).not.toContain("create");
 }finally{await p.close();await provider.close();}
});

import { createNodeEnvironmentWorkWorker } from "../../../packages/control-plane-node/src/lib/node-environment-work-worker.js";
import { managedAgentsPortTokens } from "../../../packages/managed-agents-app/src/managed-agents.js";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";

it.each([false,true])("actual Node dispatcher restores before management launch (missing blob=%s)",async missing=>{
 const f=await coldFixture();await f.sandbox.writeFile("proof.txt","strict-before-launch");
 await f.sandbox.writeFile("/oma/harness-state/native.json","native-completed");
 expect((await f.request("checkpoint")).status).toBe(200);
 if(missing){const c=JSON.parse((await f.checkpoint())!.candidate_json);await f.runtime.filesBlob.delete(c.metadata["openma.workspace.blob-key.v1"]);}
 // Simulate physical loss, not an attach to a still-running process.
 f.lose();await f.sandbox.destroy();
 await f.sql.prepare('DELETE FROM kv_entries WHERE tenant_id=? AND "key"=?').bind("default","session_sandbox_state:"+f.session.id).run();
 await rm(join(f.root,"sandbox",f.session.id),{recursive:true,force:true});
 await f.sql.prepare("UPDATE managed_environment_work SET state='queued',claim_at=NULL,claim_worker_id=NULL,sandbox_token_hashes=NULL WHERE id=?").bind(f.claim.workId).run();
 let errors=0;
 const worker=createNodeEnvironmentWorkWorker({sql:f.sql,work:f.runtime.managedEnvironmentWorkStore,sandboxes:f.runtime.sessionSandboxes,capabilities:f.runtime.managedAcpCapabilities,
   config:{...f.config,http:{...f.config.http,publicBaseUrl:f.base},sandbox:{...f.config.sandbox,environment:{...f.config.sandbox.environment,OPENMA_WORK_RUNNER_COMMAND:"/bin/sh",OPENMA_WORK_RUNNER_ARGS:JSON.stringify(["-c","cat proof.txt > launched-proof.txt && cat .mnt/oma/harness-state/native.json > launched-native.txt"])}}},
   application:workspaceId=>f.runtime.managedPlatform.app({workspaceId}).port(managedAgentsPortTokens.environmentWork),onError:()=>{errors++;}});
 try {
   await worker.start();
   const path=join(f.root,"sandbox",f.session.id,"launched-proof.txt");
   if(missing){expect(errors).toBeGreaterThan(0);await expect(readFile(path,"utf8")).rejects.toThrow();
     const record=await f.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?').bind("default","session_sandbox_state:"+f.session.id).first<{value:string}>();
     expect(JSON.parse(record!.value).phase).not.toBe("running");
   }
   else {await vi.waitFor(async()=>{expect(await readFile(path,"utf8")).toBe("strict-before-launch");expect(await readFile(join(f.root,"sandbox",f.session.id,"launched-native.txt"),"utf8")).toBe("native-completed");});expect(errors).toBe(0);}
 }finally{await worker.stop();const sandbox=f.runtime.sessionSandboxes.get({workspaceId:"default",session:f.session});await sandbox.destroy();}
});

it("restore is consumed once per new physical allocation and never rewinds a live Work",async()=>{
 const f=await coldFixture();await f.sandbox.writeFile("proof.txt","checkpoint");
 expect((await f.request("checkpoint")).status).toBe(200);
 await f.runtime.sessionSandboxes.restoreWorkCheckpoint(f.sandbox,environmentWorkSandboxTokenRef(f.claim));
 await f.sandbox.writeFile("proof.txt","new live work");
 await f.runtime.sessionSandboxes.restoreWorkCheckpoint(f.sandbox,environmentWorkSandboxTokenRef(f.claim));
 expect(await f.sandbox.readFile("proof.txt")).toBe("new live work");
});

it("cold publication reads persisted OpenAI mapping and publishes real artifacts idempotently",async()=>{
 const f=await coldFixture();const {encodeResourceMetadata}=await import("../../../packages/openai-agents-compat/src/resource-metadata.js");
 f.session.metadata=encodeResourceMetadata({},"session",{sealed:await f.runtime.openAIAgentsSecrets.seal(JSON.stringify({agent:{},environment:{type:"openai_hosted"},environmentId:f.environment.id}))});
 await f.sql.prepare("UPDATE managed_sessions SET document=? WHERE id=?").bind(JSON.stringify(f.session),f.session.id).run();
 await f.sandbox.writeFile("outputs/report.txt","cold artifact bytes");
 const done=await (await f.request("finalize",{stopReason:{type:"end_turn"}})).json() as any;
 const provider=await coldProvider(f);const p=await peer(f,provider);
 try {
   for(let n=0;n<2;n++){const r=await p.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId});expect(r.status,await r.clone().text()).toBe(200);}
   const files=await p.b.managedPlatform.app({workspaceId:"default"}).port(managedAgentsPortTokens.files).listFiles({scopeId:f.session.id,pageSize:100});
   expect(files).toMatchObject({type:"page"});if(files.type!=="page")throw Error("no files");expect(files.page.files).toHaveLength(1);
   expect(files.page.files[0]!.origin).toMatchObject({sessionId:f.session.id,path:"/workspace/outputs/report.txt"});
   const bytes=await p.b.managedPlatform.app({workspaceId:"default"}).port(managedAgentsPortTokens.files).downloadFile({fileId:files.page.files[0]!.id});
   expect(bytes.type).toBe("found");if(bytes.type==="found")expect(new TextDecoder().decode(bytes.file.content)).toBe("cold artifact bytes");
 }finally{await p.close();await provider.close();}
});

it("holder rotation during cold archive IO cannot win checkpoint CAS or touch the successor",async()=>{
 const f=await coldFixture();const provider=await coldProvider(f);const p=await peer(f,provider);
 try {
   const put=p.b.filesBlob.put.bind(p.b.filesBlob);
   p.b.filesBlob.put=async(...args)=>{const result=await put(...args);await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:"d".repeat(64),s:"all"}]),f.claim.workId).run();return result;};
   expect((await p.request("checkpoint")).status).toBe(502);expect(await f.checkpoint()).toBeNull();
   expect(await f.sandbox.exec("printf successor-alive")).toBe("successor-alive");
 }finally{await p.close();await provider.close();}
});

it("an existing attached physical runtime is never rewound from the canonical checkpoint",async()=>{
 const f=await coldFixture();await f.sandbox.writeFile("proof.txt","saved");expect((await f.request("checkpoint")).status).toBe(200);
 await f.sandbox.writeFile("proof.txt","live-retained");
 const physical=await f.sandbox.captureWork(environmentWorkSandboxTokenRef(f.claim));
 const attached=f.runtime.sessionSandboxes.build({workspaceId:f.claim.workspaceId,session:f.session,environment:f.environment,
   workAuthority:{attempt:environmentWorkSandboxTokenRef(f.claim),isCurrent:async()=>true,holderHash:()=>physical.workAuthority.holderHash,token:physical=>f.runtime.managedAcpCapabilities.issueWork(f.claim,f.session.agent.openma?.harness,physical)}});
 try {await attached.open();await f.runtime.sessionSandboxes.restoreWorkCheckpoint(attached,environmentWorkSandboxTokenRef(f.claim));expect(await attached.readFile("proof.txt")).toBe("live-retained");}
 finally{await attached.destroy();}
});

it("restore refuses a replaced physical record even if the old in-memory authority callback says current",async()=>{
 const f=await coldFixture();await f.sandbox.writeFile("proof.txt","saved");expect((await f.request("checkpoint")).status).toBe(200);
 await f.sandbox.writeFile("proof.txt","do not rewind");
 const key="session_sandbox_state:"+f.session.id;
 const row=(await f.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?').bind("default",key).first<{value:string}>())!;
 const state=JSON.parse(row.value);state.handle.runtimeId="successor-runtime";state.version++;
 await f.sql.prepare('UPDATE kv_entries SET value=? WHERE tenant_id=? AND "key"=?').bind(JSON.stringify(state),"default",key).run();
 await expect(f.runtime.sessionSandboxes.restoreWorkCheckpoint(f.sandbox,environmentWorkSandboxTokenRef(f.claim))).rejects.toThrow(/physical|authority/);
 expect(await f.sandbox.readFile("proof.txt")).toBe("do not rewind");
});
it("cold prepare requires its exact source process still running",async()=>{
 const f=await coldFixture();const provider=await coldProvider(f);const p=await peer(f,provider);
 try{provider.locator.status="exited";expect((await p.request("checkpoint")).status).toBe(502);expect(await f.checkpoint()).toBeNull();expect(provider.operations).not.toContain("connect");}
 finally{await p.close();await provider.close();}
});
