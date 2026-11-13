import { createSandboxSessionMemoryFilePort } from "../../../packages/managed-runtime-sandbox/src/session-memory-workspace";
/** Explicit owned E2B diagnostic; no inference calls, no existing VM edits.
 * Run with approved E2B_API_KEY, OMA_E2B_TEMPLATE, OMA_E2B_OUTPUT_RECEIPT.
 * Temporary state stays under TMPDIR. Does not publish a template or deploy.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiHarness, registerHarness } from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";
const key=process.env.E2B_API_KEY,template=process.env.OMA_E2B_TEMPLATE,output=process.env.OMA_E2B_OUTPUT_RECEIPT;
if(!key||!template||!output)throw Error("E2B_API_KEY, OMA_E2B_TEMPLATE, OMA_E2B_OUTPUT_RECEIPT required");
const dir=mkdtempSync(join(tmpdir(),"pr545-output-")),marker="pr545-output-"+crypto.randomUUID();
const receipt:any={kind:"owned actual E2B default Node provisioning/Pi continuation and runtime checkpoint diagnostic; NOT formal acceptance or native R2 certification",template,dir,marker,startedAt:new Date().toISOString(),allocations:[]};
const save=()=>writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");save();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const until=async(check:()=>Promise<boolean>,label:string)=>{for(let i=0;i<600;i++){if(await check())return;await sleep(200);}throw Error("bounded wait failed: "+label);};
const faux=fauxProvider({tokensPerSecond:100000});let observed:any[]=[];
const recovery="set -eu; id; stat -c '%u:%g:%a %n' /workspace /mnt/session /mnt/session/outputs /mnt/memory; printf RECOVERED > /mnt/session/outputs/continued.txt; printf WORKSPACE > /workspace/kept.txt; printf MEMORY > /mnt/memory/kept.txt; test ! -r /opt/oma-managed/installation.json; cat /mnt/session/outputs/continued.txt";
faux.setResponses([
 fauxAssistantMessage([fauxToolCall("bash",{command:`printf STARTED > /tmp/${marker}; sleep 60; printf SHOULD_NOT_FINISH`},{id:"original"})],{stopReason:"toolUse"}),
 ctx=>{observed=structuredClone(ctx.messages);return fauxAssistantMessage([fauxToolCall("bash",{command:recovery},{id:"distinct-recovery"})],{stopReason:"toolUse"});},
 ctx=>{receipt.finalModelHistory=structuredClone(ctx.messages);save();const result=ctx.messages.find((m:any)=>m.role==="toolResult"&&m.toolCallId==="distinct-recovery");assert.ok(JSON.stringify(result).includes("RECOVERED"),"model must see actual successful recovery bytes");return fauxAssistantMessage("normal completion");},
]);
const models=createModels();models.setProvider(faux.provider);const harness=marker;
registerHarness(harness,()=>({async run(ctx){await new PiHarness().run({...ctx,pi:{models,model:faux.getModel(),thinkingLevel:"off",speed:"standard"}});}}));
const storageEnv=Object.fromEntries(Object.entries(process.env).filter(([name,value])=>/^(FILES|MEMORY)_S3_/.test(name)&&value!==undefined));
const config=loadNodeConfig({...storageEnv,NODE_ENV:"test",AUTH_DISABLED:"1",PLATFORM_ROOT_SECRET:"isolated-output-ownership-test-root-secret",SANDBOX_PROVIDER:"e2b",E2B_API_KEY:key,SANDBOX_IMAGE:template,E2B_MAX_LIFETIME_MS:"3600000",MEMORY_QUEUE:"disabled",DATABASE_PATH:join(dir,"oma.db"),AUTH_DATABASE_PATH:join(dir,"auth.db"),SANDBOX_WORKDIR:join(dir,"sandboxes"),MEMORY_BLOB_DIR:join(dir,"memories"),FILES_BLOB_DIR:join(dir,"files"),SESSION_OUTPUTS_DIR:join(dir,"outputs")});
const components=await nodeDefaults(config);const lifecycle=components.sessionSandboxAdapter!.adapter.lifecycle;
const owned=new Map<string,any>();
for(const method of ["acquire","resume"] as const){const original=lifecycle[method].bind(lifecycle);(lifecycle as any)[method]=async(input:any)=>{const got=await original(input);if(got!=="gone"){owned.set(got.handle.runtimeId,got.runtime);receipt.allocations.push({method,id:got.handle.runtimeId,at:new Date().toISOString()});save();}return got;};}
const cp=await createNodeControlPlane(components);let eventsPath:string|undefined;
const request=async(path:string,body?:unknown)=>{const res=await cp.fetch(new Request("http://localhost"+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));const data=await res.json() as any;assert.ok(res.ok,JSON.stringify(data));return data;};
const history=async()=>eventsPath?(await request(eventsPath+"?limit=1000&order=asc")).data:[];
try{
 await cp.start();
 await request("/v1/oma/model_cards",{provider:"ant",model_id:marker,api_key:"test",base_url:"http://unused.invalid"});
 const agent=await request("/v1/agents",{name:marker,model:marker,system:"test",_oma:{harness},tools:[{type:"agent_toolset_20260401"}]});
 const environment=await request("/v1/environments",{name:marker,config:{type:"cloud"}});
 const session=await request("/v1/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id});receipt.sessionId=session.id;eventsPath=`/v1/sessions/${session.id}/events`;save();
 await request(eventsPath,{events:[{type:"user.message",content:[{type:"text",text:"owned provider diagnostic"}]}]});
 let killed:string|undefined;
 await until(async()=>{const rows=await history();if(rows.some((e:any)=>e.type==="session.status_idle"))throw Error("turn ended before fault entry: "+JSON.stringify(rows.filter((e:any)=>e.type==="session.error")));for(const [id,runtime] of owned){try{if(await runtime.readFile('/tmp/'+marker)!=="STARTED")continue;}catch{continue;}receipt.beforeLoss=await runtime.run("id; stat -c '%u:%g:%a %n' /workspace /mnt/session /mnt/session/outputs /mnt/memory");receipt.kill={id,markerRead:true,at:new Date().toISOString()};save();await runtime.destroy();receipt.kill.accepted=true;killed=id;save();return true;}return false;},"actual first effect before killing only owned allocation");
 await until(async()=> (await history()).some((e:any)=>e.type==="session.status_idle"),"turn completion");
 receipt.events=await history();receipt.observed=observed;receipt.modelCalls=faux.state.callCount;save();
 assert.deepEqual(receipt.events.filter((e:any)=>e.type==="session.status_idle").map((e:any)=>e.stop_reason.type),["end_turn"]);
 assert.equal(faux.state.callCount,3);
 assert.equal(receipt.events.filter((e:any)=>e.type==='agent.tool_use'&&e.id==='original').length,1);
 assert.equal(receipt.events.filter((e:any)=>e.type==='agent.tool_use'&&e.id==='distinct-recovery').length,1);
 assert.equal(receipt.events.filter((e:any)=>e.type==="agent.tool_result"&&e.tool_use_id==="original"&&e.is_error).length,1);
 assert.equal(observed.filter((m:any)=>m.role==="toolResult"&&m.toolCallId==="original"&&m.isError).length,1);
 const open=new Set<string>();for(const m of observed){if(m.role==="assistant"){assert.equal(open.size,0);for(const b of m.content)if(b.type==="toolCall")open.add(b.id);}if(m.role==="toolResult")assert.ok(open.delete(m.toolCallId));}assert.equal(open.size,0);
 assert.equal(receipt.events.some((e:any)=>e.id?.startsWith("retry:")),false);
 const entries=[...owned].filter(([id])=>id!==killed);assert.equal(entries.length,1);const [id,runtime]=entries[0];
 await createSandboxSessionMemoryFilePort(runtime).replace('/mnt/memory/readonly',new Map([['note','PROTECTED']]),new AbortController().signal,{readOnly:true});
 const denied=await runtime.run('printf forbidden > /mnt/memory/readonly/note');assert.notEqual(denied.exitCode,0);receipt.readonlyMaterializer=denied;
 const probe=async(r:any)=>{const result=await r.run("set -eu; id; cat /mnt/session/outputs/continued.txt /workspace/kept.txt /mnt/memory/kept.txt; test ! -w /mnt/memory/readonly/note; test ! -r /opt/oma-managed/installation.json");assert.equal(result.exitCode,0);assert.ok(result.stdout.includes("RECOVEREDWORKSPACEMEMORY"));return result;};
 receipt.afterReplacement=await probe(runtime);save();
 // Runtime filesystem checkpoint is a private owned restore point, NOT an
 // official template publication or replacement of an existing template.
 const signal=new AbortController().signal;const handle={provider:"e2b",runtimeId:id};const context={runtime,handle,signal,scope:{workspaceId:"default",sessionId:session.id}} as any;
 const snapshot=await lifecycle.checkpoint(context);receipt.snapshot=snapshot;save();
 const self=await lifecycle.pause(context);receipt.pause=self;save();
 const plan={from:{image:template},idleMs:300000,labels:{task:"pr545-task-e2e4t-20261112",purpose:"output-ownership-diagnostic"}};
 const resumed=await lifecycle.resume({...context,ref:self,plan} as any);assert.notEqual(resumed,"gone");if(resumed==="gone")throw Error("same ID resume gone");assert.equal(resumed.handle.runtimeId,id);receipt.afterPauseResume=await probe(resumed.runtime);save();
 const restored=await lifecycle.resume({...context,ref:snapshot,plan} as any);assert.notEqual(restored,"gone");if(restored==="gone")throw Error("snapshot restore gone");assert.notEqual(restored.handle.runtimeId,id);receipt.afterSnapshotRestore=await probe(restored.runtime);save();
 receipt.status="PASS_OWNED_PROVIDER_DEFAULT_NODE_OUTPUT_CONTINUATION_AND_RESTORE";
}catch(error){receipt.status="FAIL";receipt.error={name:(error as Error).name,message:String((error as Error).message).split(key).join("[REDACTED]")};receipt.events=await history().catch(()=>[]);receipt.observed=observed;receipt.modelCalls=faux.state.callCount;process.exitCode=1;}
finally{receipt.paused=[];for(const [id,runtime] of owned){if(id===receipt.kill?.id)continue;try{await runtime.suspend({kind:"memory"});receipt.paused.push(id);}catch{receipt.paused.push({id,state:"pause failed; inspect owned allocation"});}}await cp.stop().catch(()=>{});receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:receipt.status,session:receipt.sessionId,allocations:receipt.allocations,paused:receipt.paused}));}
