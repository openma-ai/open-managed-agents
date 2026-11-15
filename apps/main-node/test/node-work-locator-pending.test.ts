import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {getRequestListener} from "@hono/node-server";
import {expect,it} from "vitest";
import {loadNodeConfig} from "../src/config";
import {nodeDefaults} from "../src/components";
import {createNodeControlPlane} from "../src/control-plane";
import {LocalSubprocessSandbox} from "../../../packages/sandbox/src/adapters/local-subprocess";

it.each(["retry-claim", "hung-inspect", "hung-restore", "late-inspect", "late-restore"] as const)("locator late RPC and replacement claim: %s",async mode=>{
 const root=await mkdtemp(join(tmpdir(),"oma-work-locator-"));
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 let launches=0;let scopeToken="";const handles: Array<{pid:number;getStatus():Promise<string>}> = [];const tokens:string[]=[];let builds=0;
 const sandbox=new LocalSubprocessSandbox({workdir:join(root,"sandbox"),outputsRoot:join(root,"outputs")});
 const native=sandbox.startManagedProcess.bind(sandbox);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let restores=0;
 let oldAlive=true;let kills=0;let inspected=0;let startedIdentity:any;
 const locator={sandboxId:"physical-original",id:"exact-old-uuid",epoch:"launcher-original",pid:1234,identity:{workspaceId:"",sessionId:"",workId:"",attemptId:""},status:"running" as const};
 Object.assign(sandbox,{
  inspectManagedProcessSlot:async()=>{inspected++;if(mode==="hung-inspect"||mode==="late-inspect")await gate;return locator;},
  restoreManagedProcess:async(value:unknown)=>{restores++;expect(value).toBe(locator);if(mode==="hung-restore"||mode==="late-restore")await gate;return {id:locator.id,pid:locator.pid,kill:async()=>{kills++;if(mode==="retry-claim")await gate;oldAlive=false;},getStatus:async()=>oldAlive?"running":"exited"};},
 });
 sandbox.startManagedProcess=async(spec:any,identity?:unknown)=>{
  startedIdentity=identity;
  if(oldAlive)throw Object.assign(new Error("management worker busy"),{outcome:"rejected"});
  launches++;scopeToken=spec.env.OPENMA_SANDBOX_TOKEN;tokens.push(scopeToken);const handle=await native(spec);handles.push(handle);return handle;
 };
 // Real native child exercises HTTP ACK; ACP body is deliberately not claimed
 // in this bounded bootstrap test. The full runner chain is separate evidence.
 const child="const d=JSON.parse(Buffer.from(process.env.ANTHROPIC_WORK_SECRET,'base64url'));fetch(d.api_base_url+'/v1/environments/'+process.env.ANTHROPIC_ENVIRONMENT_ID+'/work/'+process.env.ANTHROPIC_WORK_ID+'/ack',{method:'POST',headers:{authorization:'Bearer '+d.sessions_token}}).then(r=>{if(!r.ok)process.exit(2);setInterval(()=>{},1000)})";

 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"admin",PLATFORM_ROOT_SECRET:"test-root-secret-not-production",PUBLIC_BASE_URL:base,MEMORY_QUEUE:"disabled",LOG_LEVEL:"silent",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),SANDBOX_WORKDIR:join(root,"sandboxes"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs"),OPENMA_WORK_RESERVATION_RECLAIM_MS:"5000",OPENMA_WORK_RUNNER_COMMAND:process.execPath,OPENMA_WORK_RUNNER_ARGS:JSON.stringify(["-e",child]),OPENMA_ACP_HARNESSES:JSON.stringify([{id:"codex-acp",version:"1",command:process.execPath}])});
 const components=await nodeDefaults(config,{sandbox:async()=>{builds++;return sandbox;}});const cp=await createNodeControlPlane(components);server.on("request",getRequestListener(cp.fetch));
 try{
  const api=async(path:string,body:unknown)=>{const r=await cp.fetch(new Request(base+path,{method:"POST",headers:{"x-api-key":"admin","content-type":"application/json"},body:JSON.stringify(body)}));const data:any=await r.json();expect(r.status,JSON.stringify(data)).toBeLessThan(300);return data;};
  await api("/v1/oma/model_cards",{model_id:"test",model:"upstream",provider:"anthropic",base_url:"https://upstream.test",api_key:"fake-model-secret"});
  const env=await api("/v1/environments",{name:"native",config:{type:"cloud",networking:{type:"unrestricted"}}});
  const agent=await api("/v1/agents",{name:"installed",model:"test",tools:[],_oma:{harness:"acp-sandbox",acp:{agent:{id:"codex-acp",command:process.execPath}}}});
  const session=await api("/v1/sessions",{agent:agent.id,environment_id:env.id});
  await api('/v1/sessions/'+session.id+'/events',{events:[{type:"user.message",content:[{type:"text",text:"begin"}]}]});
  const row=await components.database.sql.prepare("SELECT id FROM managed_environment_work WHERE session_id = ?").bind(session.id).first<{id:string}>();
  expect(row).not.toBeNull();
  locator.identity={workspaceId:session.workspace_id??"",sessionId:session.id,workId:row!.id,attemptId:""};
  const workspace=await components.database.sql.prepare("SELECT workspace_id FROM managed_environment_work WHERE id = ?").bind(row!.id).first<{workspace_id:string}>();
  locator.identity.workspaceId=workspace!.workspace_id;
  // Simulate a previous control-plane process and prior claimed attempt, with
  // no local management map. The real poll/CAS creates generation 2.
  await components.database.sql.prepare("UPDATE managed_environment_work SET claim_generation = 1 WHERE id = ?").bind(row!.id).run();
  const oldRef=await import("../../../packages/sandbox-gateway-sql/src/environment-work-sandbox-token-store-sql");
  locator.identity.attemptId=oldRef.environmentWorkSandboxTokenRef({workspaceId:workspace!.workspace_id,environmentId:env.id,sessionId:session.id,workId:row!.id,generation:1}).attemptId;

  const starting=cp.start();
  for(let i=0;i<100&&(mode.endsWith("restore")?restores:mode==="retry-claim"?kills:inspected)===0;i++)await new Promise(resolve=>setTimeout(resolve,20));
  if(mode==="retry-claim"||mode.startsWith("late-")){
   await starting;expect(kills).toBe(mode==="retry-claim"?1:0);expect(launches).toBe(0);
   if(mode.startsWith("late-")){await new Promise(resolve=>setTimeout(resolve,1200));expect(inspected).toBe(1);expect(restores).toBe(mode==="late-restore"?1:0);}
   await components.database.sql.prepare("UPDATE managed_environment_work SET claim_at = 0 WHERE id = ?").bind(row!.id).run();
   if(mode.startsWith("late-")){
    let generation=0;
    for(let i=0;i<150&&generation<3;i++){generation=(await components.database.sql.prepare("SELECT claim_generation FROM managed_environment_work WHERE id = ?").bind(row!.id).first<{claim_generation:number}>())!.claim_generation;await new Promise(resolve=>setTimeout(resolve,20));}
    expect(generation).toBeGreaterThanOrEqual(3);
    await new Promise(resolve=>setTimeout(resolve,1400));
    expect(inspected,"same physical discovery must remain single-flight across new wrappers").toBe(1);
    expect(restores).toBe(mode==="late-restore"?1:0);
   }
   release();
   for(let i=0;i<220&&launches===0;i++)await new Promise(resolve=>setTimeout(resolve,20));
   expect(launches,"new legitimate claim must continue exact old handle cleanup").toBe(1);
   const generation=await components.database.sql.prepare("SELECT claim_generation FROM managed_environment_work WHERE id = ?").bind(row!.id).first<{claim_generation:number}>();
   expect(generation!.claim_generation).toBeGreaterThanOrEqual(3);
  }else{
   let stopped=false;const stopping=cp.stop().then(()=>{stopped=true;});
   try{await new Promise(resolve=>setTimeout(resolve,2400));expect(stopped,"discovery must not block shutdown").toBe(true);expect(kills).toBe(0);expect(launches).toBe(0);expect(inspected).toBe(1);expect(restores).toBe(mode==="hung-restore"?1:0);}
   finally{release();await starting;await stopping;}
   await new Promise(resolve=>setTimeout(resolve,100));expect(kills).toBe(0);expect(launches).toBe(0);
  }
 }finally{release();await cp.stop();await sandbox.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
