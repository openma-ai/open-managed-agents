import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {createServer} from "node:http";
import {getRequestListener} from "@hono/node-server";
import {expect,it} from "vitest";
import {loadNodeConfig} from "../src/config";
import {nodeDefaults} from "../src/components";
import {createNodeControlPlane} from "../src/control-plane";
import {LocalSubprocessSandbox} from "../../../packages/sandbox/src/adapters/local-subprocess";

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,ms=4000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await pause(20);expect(check()).toBe(true);}

it.each(["kill", "status", "running", "late-kill", "late-status"] as const)("isolates a %s cleanup fault and bounds shutdown without cancelling native RPC",async mode=>{
 const kind=mode.replace("late-", "");
 const lateRecovery=mode.startsWith("late-");
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/handoff-"));
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const sandboxes:LocalSubprocessSandbox[]=[];
 let fault=true,entered=false,killCalls=0,statusCalls=0,lateSettled=false;
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const launches:string[]=[];
 const nativeHandles:Array<{getStatus():Promise<string>}>=[];
 const child="const d=JSON.parse(Buffer.from(process.env.ANTHROPIC_WORK_SECRET,'base64url'));fetch(d.api_base_url+'/v1/environments/'+process.env.ANTHROPIC_ENVIRONMENT_ID+'/work/'+process.env.ANTHROPIC_WORK_ID+'/ack',{method:'POST',headers:{authorization:'Bearer '+d.sessions_token}}).then(r=>{if(!r.ok)process.exit(2);setInterval(()=>{},1000)})";
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"admin",PLATFORM_ROOT_SECRET:"test-root-secret-not-production",PUBLIC_BASE_URL:base,MEMORY_QUEUE:"disabled",LOG_LEVEL:"silent",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),SANDBOX_WORKDIR:join(root,"sandboxes"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs"),OPENMA_WORK_RUNNER_COMMAND:process.execPath,OPENMA_WORK_RUNNER_ARGS:JSON.stringify(["-e",child]),OPENMA_ACP_HARNESSES:JSON.stringify([{id:"codex-acp",version:"1",command:process.execPath}])});
 const components=await nodeDefaults(config,{sandbox:async()=>{
  const sandbox=new LocalSubprocessSandbox({workdir:join(root,"sandbox-"+sandboxes.length),outputsRoot:join(root,"outputs")});sandboxes.push(sandbox);
  const native=sandbox.startManagedProcess.bind(sandbox);
  sandbox.startManagedProcess=async spec=>{
   const first=launches.length===0;launches.push(spec.env.ANTHROPIC_SESSION_ID);
   const handle=await native(spec);nativeHandles.push(handle);if(!first)return handle;
   return {...handle,async kill(signal:string){killCalls++;if(kind==="kill"&&fault){entered=true;await gate;lateSettled=true;}await handle.kill(signal);},async getStatus(){statusCalls++;if(kind==="status"&&fault){entered=true;await gate;lateSettled=true;}if(kind==="running"&&fault){entered=true;return "running";}return handle.getStatus();}};
  };return sandbox;
 }});
 const cp=await createNodeControlPlane(components);server.on("request",getRequestListener(cp.fetch));
 let stopping:Promise<void>|undefined;
 try{
  const api=async(path:string,body:unknown)=>{const r=await cp.fetch(new Request(base+path,{method:"POST",headers:{"x-api-key":"admin","content-type":"application/json"},body:JSON.stringify(body)}));const data:any=await r.json();expect(r.status,JSON.stringify(data)).toBeLessThan(300);return data;};
  await api("/v1/oma/model_cards",{model_id:"test",model:"upstream",provider:"anthropic",base_url:"https://upstream.test",api_key:"fake"});
  const agent=await api("/v1/agents",{name:"installed",model:"test",tools:[],_oma:{harness:"acp-sandbox",acp:{agent:{id:"codex-acp",command:process.execPath}}}});
  const create=async(name:string)=>{const env=await api("/v1/environments",{name,config:{type:"cloud",networking:{type:"unrestricted"}}});const session=await api("/v1/sessions",{agent:agent.id,environment_id:env.id});await api('/v1/sessions/'+session.id+'/events',{events:[{type:"user.message",content:[{type:"text",text:name}]}]});return session;};
  const first=await create("first");await cp.start();await until(()=>launches.length===1);
  await pause(100);
  await components.database.sql.prepare("UPDATE managed_environment_work SET claim_at = ? WHERE session_id = ?").bind(Date.now()-100_000,first.id).run();
  await until(()=>entered);
  // New environment is created only AFTER cleanup is stuck; discovery must not starve.
  const second=await create("independent");
  await until(()=>launches.includes(second.id));
  expect(launches.filter(id=>id===first.id)).toHaveLength(1);
  if(kind!=="running"){
   // An uncancellable timed-out call remains single-flight, not retried concurrently.
   await pause(1300);expect(kind==="kill"?killCalls:statusCalls).toBe(1);
   expect(lateSettled).toBe(false);
  }
  if(lateRecovery){
   fault=false;release();await until(()=>lateSettled);
   await components.database.sql.prepare("UPDATE managed_environment_work SET claim_at = ? WHERE session_id = ?").bind(Date.now()-100_000,first.id).run();
   await until(()=>launches.filter(id=>id===first.id).length===2);
   const replacement=nativeHandles.at(-1)!;
   await pause(400);
   expect(await replacement.getStatus()).toBe("running");
   expect(launches.filter(id=>id===first.id)).toHaveLength(2);
  }
  let stopped=false;stopping=cp.stop().then(()=>{stopped=true;});
  await until(()=>stopped,3200);
  expect(launches.filter(id=>id===first.id)).toHaveLength(lateRecovery?2:1);
  const count=launches.length;
  // The underlying call actually completes late: it must not resurrect/dispatch after stop.
  fault=false;release();await pause(300);
  if(kind!=="running")expect(lateSettled).toBe(true);
  expect(launches).toHaveLength(count);
 }finally{fault=false;release();await stopping;await cp.stop();for(const sandbox of sandboxes)await sandbox.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
},15000);
