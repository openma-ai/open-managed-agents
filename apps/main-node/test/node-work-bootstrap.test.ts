import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {getRequestListener} from "@hono/node-server";
import {expect,it} from "vitest";
import {loadNodeConfig} from "../src/config";
import {nodeDefaults} from "../src/components";
import {createNodeControlPlane} from "../src/control-plane";
import {LocalSubprocessSandbox} from "../../../packages/sandbox/src/adapters/local-subprocess";

it.each(["recover", "stopped", "missing-native", "uninstalled", "late-launch", "cleanup-failed", "cleanup-unconfirmed", "exit-confirmed"] as const)("production Work bootstrap through real HTTP auth: %s",async mode=>{
 const root=await mkdtemp(join(tmpdir(),"oma-work-"));
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 let launches=0;let scopeToken="";const handles: Array<{pid:number;getStatus():Promise<string>}> = [];const tokens:string[]=[];let builds=0;
 const sandbox=new LocalSubprocessSandbox({workdir:join(root,"sandbox"),outputsRoot:join(root,"outputs")});
 const native=sandbox.startManagedProcess.bind(sandbox);
 let cleanupAttempts=0;let confirmedExit=false;let statusChecks=0;let cleanupFault=true;
 sandbox.startManagedProcess=async spec=>{
  if(launches===1&&mode==="exit-confirmed")expect(confirmedExit,"old worker exit must be observed before replacement spawn").toBe(true);
  launches++;scopeToken=spec.env.OPENMA_SANDBOX_TOKEN;tokens.push(scopeToken);const handle=await native(spec);handles.push(handle);
  if(mode==="late-launch")await components.database.sql.prepare("UPDATE managed_environment_work SET claim_at = 0 WHERE id = ?").bind(spec.env.ANTHROPIC_WORK_ID).run();
  if(launches!==1)return handle;
  return {...handle,async kill(signal:string){cleanupAttempts++;if(mode==="cleanup-failed"&&cleanupFault)throw new Error("injected native cleanup failure");await handle.kill(signal);},async getStatus(){
   if(mode==="cleanup-unconfirmed"&&cleanupFault)return "running";
   if(mode==="exit-confirmed"&&statusChecks++<2)return "running";
   const status=await handle.getStatus();if(["exited","killed","completed","error"].includes(status))confirmedExit=true;return status;
  }};
 };
 // Real native child exercises HTTP ACK; ACP body is deliberately not claimed
 // in this bounded bootstrap test. The full runner chain is separate evidence.
 const child="const d=JSON.parse(Buffer.from(process.env.ANTHROPIC_WORK_SECRET,'base64url'));fetch(d.api_base_url+'/v1/environments/'+process.env.ANTHROPIC_ENVIRONMENT_ID+'/work/'+process.env.ANTHROPIC_WORK_ID+'/ack',{method:'POST',headers:{authorization:'Bearer '+d.sessions_token}}).then(r=>{if(!r.ok)process.exit(2);setInterval(()=>{},1000)})";
 if(mode==="missing-native") Object.defineProperty(sandbox,"startManagedProcess",{value:undefined});
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"admin",PLATFORM_ROOT_SECRET:"test-root-secret-not-production",PUBLIC_BASE_URL:base,MEMORY_QUEUE:"disabled",LOG_LEVEL:"silent",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),SANDBOX_WORKDIR:join(root,"sandboxes"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs"),OPENMA_WORK_RUNNER_COMMAND:process.execPath,OPENMA_WORK_RUNNER_ARGS:JSON.stringify(["-e",child]),OPENMA_ACP_HARNESSES:JSON.stringify([{id:mode==="uninstalled"?"other":"codex-acp",version:"1",command:process.execPath}])});
 const components=await nodeDefaults(config,{sandbox:async()=>{builds++;return sandbox;}});const cp=await createNodeControlPlane(components);server.on("request",getRequestListener(cp.fetch));
 try{
  const api=async(path:string,body:unknown)=>{const r=await cp.fetch(new Request(base+path,{method:"POST",headers:{"x-api-key":"admin","content-type":"application/json"},body:JSON.stringify(body)}));const data:any=await r.json();expect(r.status,JSON.stringify(data)).toBeLessThan(300);return data;};
  await api("/v1/oma/model_cards",{model_id:"test",model:"upstream",provider:"anthropic",base_url:"https://upstream.test",api_key:"fake-model-secret"});
  const env=await api("/v1/environments",{name:"native",config:{type:"cloud",networking:{type:"unrestricted"}}});
  const agent=await api("/v1/agents",{name:"installed",model:"test",tools:[],_oma:{harness:"acp-sandbox",acp:{agent:{id:"codex-acp",command:process.execPath}}}});
  const session=await api("/v1/sessions",{agent:agent.id,environment_id:env.id});
  await api('/v1/sessions/'+session.id+'/events',{events:[{type:"user.message",content:[{type:"text",text:"begin"}]}]});
  await cp.start();
  if(mode==="late-launch") {
   expect(launches).toBe(1);
   for(let i=0;i<100;i++){if(await handles[0].getStatus()!=="running")break;await new Promise(resolve=>setTimeout(resolve,20));}
   expect(await handles[0].getStatus()).not.toBe("running");
   return;
  }
  if(mode==="missing-native"||mode==="uninstalled") {
   await new Promise(resolve=>setTimeout(resolve,1100));
   expect(launches).toBe(0);
   const rejected=await components.database.sql.prepare("SELECT state,sandbox_token_hashes FROM managed_environment_work WHERE session_id = ?").bind(session.id).first();
   expect(rejected).toEqual({state:"queued",sandbox_token_hashes:null});
   return;
  }
  for(let i=0;i<100&&launches===0;i++)await new Promise(resolve=>setTimeout(resolve,20));
  expect(launches).toBe(1);expect(scopeToken).toMatch(/^oma_sbx_/);
  let state="";for(let i=0;i<100;i++){state=(await components.database.sql.prepare("SELECT state FROM managed_environment_work WHERE session_id = ?").bind(session.id).first<{state:string}>())!.state;if(state==="starting")break;await new Promise(resolve=>setTimeout(resolve,20));}
  expect(state).toBe("starting");
  expect(await handles[0].getStatus()).toBe("running");
  if(mode==="stopped") {
   // Existing stop state is authoritative: an expired stopped Work never reclaims.
   await components.database.sql.prepare("UPDATE managed_environment_work SET state = 'stopped', claim_at = 0 WHERE session_id = ?").bind(session.id).run();
   await new Promise(resolve=>setTimeout(resolve,1300));
   expect(launches).toBe(1);expect(await handles[0].getStatus()).not.toBe("running");
   return;
  }
  // Fault injection changes only lease time. No new HTTP/user wakeup follows.
  await components.database.sql.prepare("UPDATE managed_environment_work SET claim_at = ? WHERE session_id = ?").bind(Date.now()-100_000,session.id).run();
  if(mode==="cleanup-failed"||mode==="cleanup-unconfirmed") {
   await new Promise(resolve=>setTimeout(resolve,2300));
   expect(cleanupAttempts).toBeGreaterThan(0);
   expect(launches,"failed or unconfirmed cleanup must block a second worker").toBe(1);
   cleanupFault=false;
   await components.database.sql.prepare("UPDATE managed_environment_work SET claim_at = ? WHERE session_id = ?").bind(Date.now()-100_000,session.id).run();
  }
  for(let i=0;i<200&&launches<2;i++)await new Promise(resolve=>setTimeout(resolve,20));
  expect(launches).toBe(2);expect(builds).toBe(1);expect(tokens[1]).not.toBe(tokens[0]);
  for(let i=0;i<100;i++){if(await handles[0].getStatus()!=="running")break;await new Promise(resolve=>setTimeout(resolve,20));}
  expect(await handles[0].getStatus()).not.toBe("running");
  const generation=await components.database.sql.prepare("SELECT claim_generation FROM managed_environment_work WHERE session_id = ?").bind(session.id).first<{claim_generation:number}>();
  expect(generation?.claim_generation).toBe(mode==="cleanup-failed"||mode==="cleanup-unconfirmed"?3:2);
  expect((await components.database.sql.prepare("SELECT COUNT(*) AS count FROM managed_session_executions WHERE session_id = ?").bind(session.id).first<{count:number}>())?.count).toBe(0);
  const channels=(token:string)=>cp.fetch(new Request(base+"/v1/oma/sessions/"+session.id+"/execution-channels",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:"{}"}));
  // HTTP ACK and token verification both use real auth, not disabled middleware.
  for(let i=0;i<100;i++){if((await channels(tokens[1])).status===200)break;await new Promise(resolve=>setTimeout(resolve,20));}
  expect((await channels(tokens[0])).status).toBe(401);
  expect((await channels(tokens[1])).status).toBe(200);
  await cp.stop();
  for(let i=0;i<100;i++){if(await handles[1].getStatus()!=="running")break;await new Promise(resolve=>setTimeout(resolve,20));}
  expect(await handles[1].getStatus()).not.toBe("running");
 }finally{await cp.stop();await sandbox.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
