/** Opt-in real-model, real business side effect + owner SIGKILL acceptance.
 * Hooks operate ONLY operator-owned isolated processes. No provider/model substitutes. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.OMA_LIVE_LLM,"1","Explicit OMA_LIVE_LLM=1 required");
const required=(name:string)=>{const value=process.env[name];assert(value,name+" required");return value;};
const bases=required("OMA_LIVE_BASE_URLS").split(",");assert.equal(bases.length,2,"two independent owners required");
const key=required("OMA_API_KEY"), model=required("OMA_LIVE_MODEL"), deployedHead=required("OMA_LIVE_DEPLOYED_HEAD");
const trimSlash=(value:string)=>value.endsWith("/")?value.slice(0,-1):value;
const counter=trimSlash(required("OMA_LIVE_EFFECT_URL")), countBase=trimSlash(process.env.OMA_LIVE_EFFECT_READ_URL??counter);
const fault=resolve(required("OMA_LIVE_FAULT_SCRIPT")), restart=resolve(required("OMA_LIVE_RESTART_SCRIPT"));
const allowedPids=required("OMA_LIVE_OWNED_PIDS").split(",").map(Number);
assert(allowedPids.length===2&&allowedPids.every(pid=>Number.isSafeInteger(pid)&&pid>1));
const output=resolve(required("OMA_LIVE_EVIDENCE_DIR"));await mkdir(output,{recursive:true});
const timeout=Number(process.env.OMA_LIVE_TIMEOUT_MS??300000);assert(Number.isSafeInteger(timeout)&&timeout>=180000&&timeout<=600000);
const head=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const diff=execFileSync("git",["diff","HEAD"],{encoding:"utf8"});assert.equal(diff,"","deploy a fixed clean SHA before acceptance");assert.equal(head,deployedHead);
const save=async(name:string,data:unknown)=>writeFile(resolve(output,name+".json"),JSON.stringify(data,null,2));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait<T>(read:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T>{const end=Date.now()+timeout;do{const value=await read();if(accept(value))return value;await sleep(500);}while(Date.now()<end);throw Error("bounded durable-state wait expired");}
async function api(owner:number,path:string,body?:unknown){const response=await fetch(bases[owner]+path,{method:body===undefined?"GET":"POST",headers:{"x-api-key":key,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});assert(response.ok,"HTTP "+response.status+" "+path.split("?")[0]);return response.json() as Promise<any>;}
async function events(sid:string,owner:number){const rows:any[]=[];let page:string|undefined;do{const result=await api(owner,"/v1/sessions/"+sid+"/events?limit=100"+(page?"&page="+encodeURIComponent(page):""));rows.push(...result.data);page=result.next_page;}while(page);return rows;}
async function count(token:string){const response=await fetch(countBase+"/count/"+token,{signal:AbortSignal.timeout(10000)});assert(response.ok);const value=await response.json() as {count:number};assert(Number.isSafeInteger(value.count));return value.count;}
const token=randomBytes(12).toString("hex");
const effectOrigin=new URL(counter);
assert(effectOrigin.protocol==="https:"&&effectOrigin.origin===counter&&!effectOrigin.username&&!effectOrigin.password,"effect URL must be an HTTPS origin");
let sid:string|undefined;const startedAt=new Date().toISOString();
await save("fingerprint",{head,deployedHead,startedAt,bases,sourceSha256:createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),model,topology:"two independent Node owners / shared PostgreSQL / real provider / no probe",counter});
try{
  for(let owner=0;owner<2;owner++){
    const cards=await api(owner,"/v1/oma/model_cards");const card=(Array.isArray(cards)?cards:cards.data??cards.model_cards??[]).find((row:any)=>row.model_id===model);
    assert(card);assert.equal(card.provider,"minimax-cn");assert.equal(card.model,"MiniMax-M3.1-Flash");assert.equal(card.base_url,"https://api.minimaxi.com/anthropic");
    await save("model-"+owner,{model_id:card.model_id,provider:card.provider,model:card.model,endpoint:card.base_url,at:new Date().toISOString()});
  }
  const environment=await api(0,"/v1/environments",{name:"unknown-tool-retry-live",config:{type:"cloud",networking:{type:"unrestricted"}}});
  const agent=await api(0,"/v1/agents",{name:"unknown-tool-retry-live",model,system:"Follow the user request and use bash for commands.",tools:[{type:"agent_toolset_20260401"}]});
  sid=(await api(0,"/v1/sessions",{agent:agent.id,environment_id:environment.id})).id;assert(sid);
  const command="curl --fail --silent --show-error -X POST "+counter+"/effect/"+token+"; sleep 120; printf TOOL_DONE";
  await save("owned",{sid,agentId:agent.id,environmentId:environment.id,token,command});
  await api(1,"/v1/sessions/"+sid+"/events",{events:[{type:"user.message",content:[{type:"text",text:"Run this command once using bash, then report the result: "+command}]}]});
  await wait(()=>count(token),value=>value===1);
  // Health identifies the owner actually running the session; the isolated
  // fault hook verifies ownership before SIGKILL. It receives no credentials.
  const health=await Promise.all(bases.map(base=>fetch(base+"/health").then(response=>response.json()))) as Array<{pid:number}>;
  assert(health.every(row=>allowedPids.includes(row.pid)),"refuse fault against unapproved processes");
  const killed=await promisify(execFile)("/bin/bash",[fault,sid,...health.map(row=>String(row.pid))],{timeout:15000,maxBuffer:65536});
  // Hook stdout must be ONLY the killed PID, never shell/environment output.
  const pid=Number(killed.stdout.trim());assert(allowedPids.includes(pid));
  const dead=health.findIndex(row=>row.pid===pid),peer=1-dead;
  await save("fault",{sid,pid,at:new Date().toISOString(),count:await count(token)});
  const recovered=await wait(()=>events(sid!,peer),rows=>rows.some(row=>row.type==="session.status_idle"&&row.stop_reason?.type==="requires_action"));
  const warning=recovered.find(row=>row.type==="session.warning"&&row.source==="tool_outcome_unknown");assert(warning);
  const details=warning.details, retryId=details.retry_request_id, originalId=details.tool_use_id;
  assert.equal(details.outcome,"dispatched_unknown");assert.equal(retryId,"retry:"+originalId);
  const original=recovered.find(row=>row.id===originalId), retry=recovered.find(row=>row.id===retryId);
  assert(original&&retry);assert.deepEqual(retry.input,original.input);assert.equal(original.input.command,command);
  assert(recovered.some(row=>row.type==="agent.tool_result"&&row.tool_use_id===originalId&&row.is_error===true));
  assert.equal(await count(token),1);
  await save("parked",{sid,originalId,retryId,count:1,at:new Date().toISOString(),frozenInputMatches:true,unknownVisible:true});
  await promisify(execFile)("/bin/bash",[restart],{timeout:90000,maxBuffer:65536});
  await wait(()=>api(0,"/v1/sessions/"+sid),value=>value.status==="idle");
  await api(0,"/v1/sessions/"+sid+"/events",{events:[{type:"user.tool_confirmation",tool_use_id:originalId,result:"allow"}]});
  await sleep(2000);assert.equal(await count(token),1,"closed original authorization must have no effect");
  const stable=await events(sid,1);assert.deepEqual(stable.filter(row=>row.type==="agent.tool_use").map(row=>row.id),recovered.filter(row=>row.type==="agent.tool_use").map(row=>row.id));
  const approval={events:[{type:"user.tool_confirmation",tool_use_id:retryId,result:"allow"}]};
  await api(1,"/v1/sessions/"+sid+"/events",approval);
  await wait(()=>count(token),value=>value===2);
  // Duplicate answer after dispatch cannot authorize a second operation.
  await api(0,"/v1/sessions/"+sid+"/events",approval);
  await wait(()=>api(0,"/v1/sessions/"+sid),value=>value.status==="idle");
  const final=await events(sid,1);assert.equal(await count(token),2);
  assert.equal(final.filter(row=>row.type==="agent.tool_result"&&row.tool_use_id===retryId).length,1);
  await save("results",{status:"PASS",sid,startedAt,endedAt:new Date().toISOString(),neutralCount:1,approvedCount:2,originalId,retryId,restartPark:true,duplicateApprovalNoEffect:true,model:"MiniMax-M3.1-Flash",provider:"minimax-cn",endpoint:"https://api.minimaxi.com/anthropic"});
}catch(error){await save("results",{status:"FAIL",sid,startedAt,endedAt:new Date().toISOString(),error:error instanceof Error?error.name:"UnknownError"});throw error;}
