// @ts-expect-error vitest raw SQL import
import workInputsMigration from "../../apps/main/migrations/0031_work_inputs.sql?raw";
// Local CF control/bootstrap/finalizer -> real Node supervisor + ACP child.
// Provider IO is a LocalSubprocess transport, with explicit R2 mount copy-sync.
// This is not a native CF container/FUSE or live-provider certification.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect,it,vi } from "vitest";
import { OAUTH_MCP_TEST_PORT } from "../fixtures/oauth-mcp-local-endpoint";
import { SKILL_FILES,SKILL_MD,MEMORY_FACT,READONLY_SEED,EXPECTED_REPORT } from "../resource-convergence/resource-agent-fixture";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { sandboxTokenSha256 } from "@open-managed-agents/sandbox-gateway";
import { dispatchCfWorkRunnerRequest } from "../../apps/agent/src/runtime/cf-work-runner-entry";
import { cfWorkFinalizationRoutes } from "../../apps/main/src/lib/cf-work-finalization";
import { SessionDO } from "../../apps/agent/src/runtime/session-do";
import { parseExecResult } from "@open-managed-agents/sandbox";
const e2b=vi.hoisted(()=>({handlers:{} as Record<string,(...args:any[])=>Promise<any>>}));
vi.mock("../../apps/agent/node_modules/e2b",()=>{
 class Sandbox {
  sandboxId:string;constructor(options:any){this.sandboxId=options.sandboxId;}
  static async create(source:any,options:any){return new Sandbox({sandboxId:await e2b.handlers.create(source,options)});}
  static async connect(id:string){await e2b.handlers.connect(id);return new Sandbox({sandboxId:id});}
  static async kill(id:string){return e2b.handlers.kill(id);}
  static async deleteSnapshot(id:string){return e2b.handlers.deleteSnapshot(id);}
  async kill(){return e2b.handlers.kill(this.sandboxId);}async setTimeout(){}async updateNetwork(){}
  async createSnapshot(options:any){return e2b.handlers.snapshot(this.sandboxId,options);}
  files={read:(path:string,options:any)=>e2b.handlers.read(path,options),write:(path:string,bytes:any,options:any)=>e2b.handlers.write(path,bytes,options)};
  commands={run:(command:string,options:any)=>e2b.handlers.run(command,options)};
 }
 return {Sandbox,ConnectionConfig:class {},ApiClient:class {api={GET:(_path:string,options:any)=>e2b.handlers.inspect(options.params.path.sandboxID)};}};
});
it("CF E2B Work executing child chain: Skill script, Memory across restart, readonly callID and exact output download",async()=>{
 const unique=crypto.randomUUID();
 // test-worker has a legacy 0029 baseline. Exercise the real fail-closed 0031
 // migration before creating this gate's data; never synthesize/relax indexes.
 await exports.default.fetch(new Request("http://localhost/health"));
 await env.MAIN_DB!.batch((workInputsMigration as string).split("--> statement-breakpoint").map(sql=>sql.trim()).filter(Boolean).map(sql=>env.MAIN_DB!.prepare(sql)));

 const boot=await fetch(`http://127.0.0.1:${OAUTH_MCP_TEST_PORT+1}/${unique}/work-peer`,{method:"POST",body:"{}"});expect(boot.ok,await boot.clone().text()).toBe(true);
 const peer=(await boot.json() as any).origin;
 const remote=async(path:string,input:unknown={})=>{const r=await fetch(peer+path,{method:"POST",body:JSON.stringify(input)});if(!r.ok){const body=await r.text();console.log(JSON.stringify({op:"cf.work.peer_failure",path,status:r.status,body}));throw Error(`${path}: ${r.status} ${body}`);}return r.json() as Promise<any>;};
 const api=async(path:string,body?:unknown)=>exports.default.fetch(new Request("http://localhost"+path,{method:body===undefined?"GET":"POST",headers:{"x-api-key":"test-key",...(body instanceof FormData?{}:{"content-type":"application/json"})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)}));
 const json=async(path:string,body?:unknown)=>{const r=await api(path,body);expect(r.ok,await r.clone().text()).toBe(true);return r.json() as Promise<any>;};
 const form=new FormData();for(const f of SKILL_FILES)form.append("files[]",new File([f.content],f.name));const skill=await json("/v1/skills",form);
 const rw=await json("/v1/memory_stores",{name:"work-notes"}),ro=await json("/v1/memory_stores",{name:"work-policies"});await json(`/v1/memory_stores/${ro.id}/memories`,{path:"/seed.md",content:READONLY_SEED});
 const agent=await json("/v1/agents",{name:unique,model:"test",skills:[{type:"custom",skill_id:skill.id,version:"latest"}],_oma:{harness:"acp-sandbox",acp:{agent:{command:"/usr/bin/node"}}}});
 const environment=await json("/v1/environments",{name:unique,config:{type:"cloud"}});
 const session=await json("/v1/sessions",{agent:agent.id,environment_id:environment.id,resources:[{type:"memory_store",memory_store_id:rw.id,access:"read_write"},{type:"memory_store",memory_store_id:ro.id,access:"read_only"}]});
 const sql=new CfD1SqlClient(env.MAIN_DB!),bound=(await new SqlSessionSource(sql).find({workspaceId:"default",sessionId:session.id}))!;
 console.log(JSON.stringify({op:"cf.work.input_indexes",rows:await sql.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE '%source_position%'").all()}));
 const now=new Date().toISOString(),root=env.PLATFORM_ROOT_SECRET!;const claim={workspaceId:"default",sessionId:session.id,environmentId:environment.id,workId:"work_"+unique,generation:1,holder:"local-owner"};
 const cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret"),codec=new WebCryptoAesGcm(root,"managed.environment-work.session-token");
 const token="sk-ant-req-v1."+await codec.encrypt(JSON.stringify({version:1,...claim,claimedAt:now,issuedAt:now,expiresAt:new Date(Date.now()+300000).toISOString(),skills:bound.agent.skills.map(s=>({skillId:s.skillId,version:s.version})),files:[],memoryStores:[{memoryStoreId:rw.id,access:"read_write"},{memoryStoreId:ro.id,access:"read_only"}]}));
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(session.id).run();
 const work=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 await work.insert({workspaceId:"default",record:{work:{id:claim.workId,environmentId:environment.id,data:{type:"session",id:session.id},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:1,workerId:claim.holder,claimedAt:now},heartbeatTtlSeconds:300}});
 const configured={...env,SANDBOX_ADAPTER:"e2b",PUBLIC_BASE_URL:peer,E2B_API_KEY:"fixture-only",E2B_TEMPLATE:"trusted-local",E2B_MAX_LIFETIME_MS:"3600000",R2_ACCESS_KEY_ID:undefined,R2_SECRET_ACCESS_KEY:undefined,R2_FILES_ACCESS_KEY_ID:undefined,R2_FILES_SECRET_ACCESS_KEY:undefined,MAIN_MCP:undefined,OPENMA_ACP_HARNESSES:JSON.stringify([{id:"claude-acp",version:"0.94.0",command:"/usr/bin/node"}])};
 let runtimeId="",alive=false,slot:any=null,allocation=0;const management=new Map<string,string>();
 const io=async(method:string,...args:unknown[])=>(await remote("/io",{method,args})).result;
 e2b.handlers={
  create:async(source:string)=>{runtimeId="local-e2b-"+(++allocation);alive=true;slot=null;management.clear();await remote("/provision",{sessionId:session.id,mounts:[]});if(source.startsWith("local-"))await remote("/restore",{id:source});return runtimeId;},
  connect:async(id:string)=>{if(!alive||id!==runtimeId)throw Object.assign(Error("sandbox gone"),{status:404,name:"NotFoundError"});},
  inspect:async(id:string)=>({data:alive&&id===runtimeId?{sandboxID:runtimeId,state:"running",lifecycle:{autoResume:false},envdVersion:"fixture",envdAccessToken:"fixture"}:null}),
  kill:async()=>{await remote("/stop");alive=false;return true;},
  snapshot:async()=>({snapshotId:(await remote("/checkpoint")).backup.id}),
  deleteSnapshot:async(id:string)=>{await remote("/discard",{id});},
  run:async(command:string)=>{const result=parseExecResult(await io("exec",command));console.log(JSON.stringify({op:"e2b.local.run",exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr}));return {exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr};},
  read:async(path:string,options:any)=>{
   if(path==="/run/oma-managed/ready")return "oma-managed-v2";
   if(path.startsWith("/run/oma-managed/")){if(!management.has(path))throw Object.assign(Error("missing management file"),{name:"NotFoundError"});return management.get(path);}
   try {const bytes=Buffer.from(await io("readFileBytes",path),"base64");return options?.format==="bytes"?bytes:bytes.toString();}catch{throw Object.assign(Error("missing provider file"),{name:"NotFoundError"});}
  },
  write:async(path:string,bytes:string|Uint8Array)=>{
   if(!path.startsWith("/run/oma-managed/")){await io("writeFileBytes",path,Buffer.from(bytes).toString("base64"));return;}
   management.set(path,typeof bytes==="string"?bytes:new TextDecoder().decode(bytes));if(!path.endsWith(".go"))return;
   const req=JSON.parse(management.get(path.replace(/\.go$/,".json"))!);let result:any={ok:true};
   if(req.op==="start"){
    const launch=await remote("/start",{claim,environment:Object.fromEntries(Object.entries(req.spec.env).filter(([k])=>k.startsWith("ANTHROPIC_"))),agentSettings:{checkWorkspace:true,skillId:skill.id,rwName:rw.name,roName:ro.name}});
    const holderHash=await sandboxTokenSha256(req.spec.env.OPENMA_SANDBOX_TOKEN);slot={sandboxId:runtimeId,id:req.id,epoch:launch.startTicks,pid:launch.pid,identity:req.identity,status:"running",holderHash};result={ok:true,...slot};console.log(JSON.stringify({op:"e2b.local.child_started",pid:launch.pid,epoch:slot.epoch}));
   }else if(req.op==="inspect-slot")result={ok:true,locator:slot};
   else {if(req.target!==slot.id||req.epoch!==slot.epoch||JSON.stringify(req.identity)!==JSON.stringify(slot.identity))throw Error("Wrong E2B exact process locator");if(req.op==="kill")await remote("/stop");slot.status=(await remote("/status")).exited?"exited":"running";result={ok:true,status:slot.status};}
   management.set(path.replace(/\.go$/,".response.json"),JSON.stringify(result));
  },
 };
 let stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
 const binding={fetch:async(input:any,init?:RequestInit)=>{const request=new Request(input,init),url=new URL(request.url),body=await request.text();const response=await runInDurableObject(stub,async(_i,state)=>{const owner=new SessionDO(state,configured as never);const r=await owner.fetch(new Request("https://internal"+url.pathname.replace(`/sessions/${session.id}`,""),{method:request.method,headers:request.headers,body}));return {status:r.status,body:await r.text()};});return new Response(response.body,{status:response.status});}};
 const finalRoutes=cfWorkFinalizationRoutes({...configured,SANDBOX_sandbox_default:binding} as never);
 let pumping=true;const pump=(async()=>{while(pumping){const requests=await remote("/pending");for(const request of requests){const url="http://localhost"+request.path,init={method:request.method,headers:request.headers,body:request.body||undefined};let response:Response;
   if(/\/work-(recovery|checkpoint|finalize|publish|failed)$/.test(request.path))response=await finalRoutes.fetch(new Request(url.replace("/v1/oma/sessions",""),init));else response=await exports.default.fetch(new Request(url,init));
   if(!response.ok)console.log(JSON.stringify({op:"cf.work.child_http_failure",path:request.path,status:response.status,body:await response.clone().text()}));
   await remote("/reply",{id:request.id,status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString("base64")});}
   await new Promise(r=>setTimeout(r,10));}})();
 const dispatch=async()=>{const result=await runInDurableObject(stub,async(_i,state)=>{const response=await dispatchCfWorkRunnerRequest(new Request("http://internal/__internal/work/dispatch",{method:"POST",body:JSON.stringify({...claim,apiBaseUrl:peer,workSecret:Buffer.from(JSON.stringify({sessions_token:token,api_base_url:peer,claim_generation:1})).toString("base64url")})}),configured as never,{storage:state.storage,id:state.id.toString(),hasSessionExecution:false});return {status:response.status,body:await response.text()};});expect(result.status,result.body).toBe(200);};
 const turn=async(text:string,count:number)=>{await json(`/v1/sessions/${session.id}/events`,{events:[{type:"user.message",content:[{type:"text",text}]}]});await expect.poll(async()=>{const status=await remote("/status");if(status.exited)throw Error(JSON.stringify(status.observations));return status.publications.length;},{timeout:20000}).toBe(count);
  const events=(await json(`/v1/sessions/${session.id}/events?limit=1000&order=asc`)).data;expect(events.filter((e:any)=>e.type==="session.status_idle").map((e:any)=>e.stop_reason.type)).toEqual(Array(count).fill("end_turn"));expect(events.filter((e:any)=>e.type==="session.error")).toEqual([]);const errors=events.filter((e:any)=>e.type==="agent.tool_result"&&e.tool_use_id==="readonly-write");expect(errors).toHaveLength(1);expect(errors[0].is_error).toBe(true);
  for(const [store,path,bytes] of [[rw,"/fact.md",MEMORY_FACT],[ro,"/seed.md",READONLY_SEED]] as const){const page=await json(`/v1/memory_stores/${store.id}/memories?limit=100`),entry=page.data.find((r:any)=>r.path===path);expect(entry).toBeDefined();expect((await json(`/v1/memory_stores/${store.id}/memories/${entry.id}?view=full`)).content).toBe(bytes);}
  const output=await api(`/v1/sessions/${session.id}/outputs/skill-report.txt`);expect(output.status).toBe(200);expect(await output.text()).toBe(EXPECTED_REPORT);
 };
 try{
  await dispatch();await turn("make the report",1);let status=await remote("/status");expect(status.observations.find((o:any)=>o.id==="skill-read").output).toBe(SKILL_MD);expect(status.observations.find((o:any)=>o.id==="skill-script").error).toBe(false);
  await turn("recall exact memory next",2);status=await remote("/status");expect(status.observations.find((o:any)=>o.id==="recall-next").output).toBe(MEMORY_FACT);
  await remote("/stop");alive=false;
  await expect(runInDurableObject(stub,(_i,state)=>state.abort("E2B Work owner restart"))).rejects.toThrow();stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
  await dispatch();await turn("recall exact memory restored",3);status=await remote("/status");expect(status.observations.find((o:any)=>o.id==="recall-restored").output).toBe(MEMORY_FACT);console.log(JSON.stringify({op:"cf.work.workspace_recall",observation:status.observations.find((o:any)=>o.id==="recall-workspace-restored")}));expect(status.observations.find((o:any)=>o.id==="recall-workspace-restored").output).toBe(MEMORY_FACT);console.log(JSON.stringify({op:"cf.work.combined",generation:status.generation,observations:status.observations,publications:status.publications}));
 }finally{await remote("/stop");pumping=false;await pump;}
},120000);
