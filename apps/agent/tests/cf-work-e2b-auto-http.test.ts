import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, expect, it, vi } from "vitest";
import main from "../../main/src/index";
import { createCfDispatchedEnvironmentWorker } from "../src/runtime/cf-environment-worker";
import { dispatchCfWorkRunnerRequest } from "../src/runtime/cf-work-runner-entry";

// Only the remote provider is a substitute. SQL authority, SDK poll and HTTP
// canonical ingress run in workerd; this does not certify a real E2B template.
const provider=vi.hoisted(()=>({launches:[] as any[],files:new Map<string,string>(),commands:[] as any[], worker:undefined as undefined|((launch:any)=>Promise<void>)}));
vi.mock("e2b",()=>({Sandbox:{create:async()=>({sandboxId:"native-physical",kill:async()=>{},updateNetwork:async()=>{},
 commands:{run:async(command:string,options:unknown)=>{provider.commands.push({command,options});return {exitCode:0,stdout:command.startsWith("cat ")?"generation":"",stderr:""};}},
 files:{read:async(path:string)=>path.endsWith("/ready")?"oma-managed-v2":provider.files.get(path),write:async(path:string,content:string)=>{
 provider.files.set(path,content);if(path.endsWith(".go")){const launch=JSON.parse(provider.files.get(path.replace(/\.go$/,".json"))!);provider.launches.push(launch);await provider.worker?.(launch);provider.files.set(path.replace(/\.go$/,".response.json"),JSON.stringify({ok:true,id:launch.id,epoch:"epoch",pid:41}));}
 }},
})}}));
beforeAll(async()=>{await exports.default.fetch(new Request("http://localhost/health"));});
it("automatic SDK poll/claim reaches E2B native Files launcher and worker-only HTTP canonical data plane",async()=>{
 const configured={...env,API_KEY:"test-key",PLATFORM_ROOT_SECRET:"test-platform-root-secret-padded-to-thirtytwo",PUBLIC_BASE_URL:"https://control.test",SANDBOX_ADAPTER:"e2b",E2B_API_KEY:"provider-private",E2B_TEMPLATE:"trusted-final-template",E2B_MAX_LIFETIME_MS:"3600000",OPENMA_ACP_HARNESSES:'[{"id":"codex-acp","version":"1.8.0","command":"/opt/oma-harnesses/codex-acp/bin/codex-acp"}]',MAIN_MCP:undefined};
 const requests:{path:string;status:number}[]=[];
 const transport:typeof fetch=async(input,init)=>{const request=new Request(input,init);const response=await main.fetch(request,configured as never,{waitUntil(){},passThroughOnException(){}} as never);requests.push({path:new URL(request.url).pathname,status:response.status});return response;};
 const post=async(path:string,body:unknown)=>{const r=await transport("https://control.test"+path,{method:"POST",headers:{"x-api-key":"test-key","content-type":"application/json"},body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBeLessThan(400);return r.json() as Promise<any>;};
 const agent=await post("/v1/agents",{name:"native-auto-"+crypto.randomUUID(),model:"unused",tools:[],_oma:{harness:"acp-sandbox",acp:{agent:{command:"/opt/oma-harnesses/codex-acp/bin/codex-acp"}}}});
 const environment=await post("/v1/environments",{name:"native-auto-"+crypto.randomUUID(),config:{type:"cloud",networking:{type:"unrestricted"}}});
 const session=await post("/v1/sessions",{agent:agent.id,environment_id:environment.id});
 const standing=await post("/v1/oma/api_keys",{name:"native-worker",environment_id:environment.id});
 const client=new Anthropic({apiKey:null,authToken:standing.key,baseURL:"https://control.test",maxRetries:0,fetch:transport});
 let scoped="",workId="";const canonicalId="native-canonical-"+crypto.randomUUID();
 provider.launches.length=0;provider.commands.length=0;
 const runtimeRequest=(id:string)=>transport("https://control.test/v1/oma/sessions/"+session.id+"/runtime-events",{method:"POST",headers:{authorization:"Bearer "+scoped,"content-type":"application/json"},body:JSON.stringify({events:[{id,type:"session.status_idle",processed_at:new Date().toISOString(),stop_reason:{type:"end_turn"}}]})});
 provider.worker=async launch=>{
   const secret=JSON.parse(atob(launch.spec.env.ANTHROPIC_WORK_SECRET));scoped=secret.sessions_token;workId=launch.spec.env.ANTHROPIC_WORK_ID;
   const workerClient=client.withOptions({apiKey:null,authToken:scoped});
   await workerClient.beta.environments.work.ack(workId,{environment_id:environment.id});
   await workerClient.beta.environments.work.heartbeat(workId,{environment_id:environment.id});
   expect((await runtimeRequest(canonicalId)).status).toBe(200);
 };
 // Use the existing DO's actual SQLite KV record. Transport adapter lets this
 // test's provider SDK substitute remain in the test realm, not production.
 const namespace={idFromName:(name:string)=>env.SESSION_DO.idFromName(name),get:(id:DurableObjectId)=>({async fetch(request:Request){const body=await request.text();const result=await runInDurableObject(env.SESSION_DO.get(id),async(_instance,state)=>{const response=await dispatchCfWorkRunnerRequest(new Request("https://internal/__internal/work/dispatch",{method:"POST",body}),configured as never,{storage:state.storage,id:state.id.toString(),hasSessionExecution:false});return {status:response.status,body:await response.text()};});return new Response(result.body,{status:result.status});}})};
 try{
 const worker=createCfDispatchedEnvironmentWorker({...configured,SESSION_DO:namespace} as never,{environmentId:environment.id,workspaceId:"default",environmentKey:standing.key},client as never);
 await worker.drain();
 expect(provider.launches).toHaveLength(1);const launch=provider.launches[0];
 expect(launch.spec.command).toBe("/usr/local/bin/node");expect(launch.spec.args).toEqual(["/opt/oma-managed/worker/node-e2b-work-item-cli.js"]);
 expect(launch.identity).toMatchObject({workspaceId:"default",sessionId:session.id,workId,attemptId:"environment-work-claim:1"});
 expect(JSON.stringify(launch)).not.toContain(standing.key);expect(JSON.stringify(launch)).not.toContain("provider-private");
 expect(provider.commands.some(c=>c.command.includes("node-e2b-work-item"))).toBe(false);
 expect(requests.some(r=>r.path.endsWith("/work/poll")&&r.status===200)).toBe(true);
 const history=await client.withOptions({authToken:scoped}).beta.sessions.events.list(session.id,{types:["session.status_idle"]});expect(history.data).toContainEqual(expect.objectContaining({id:canonicalId}));
 const stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
 await runInDurableObject(stub,async(_instance,state)=>{expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({phase:"running",handle:{provider:"e2b",runtimeId:"native-physical"}});});
 await post("/v1/sessions/"+session.id+"/events",{events:[{type:"user.interrupt"}]});
 expect((await runtimeRequest("stale-"+canonicalId)).status).toBe(401);
 const row=await env.MAIN_DB.prepare("SELECT id,state FROM managed_environment_work WHERE workspace_id='default' AND session_id=?").bind(session.id).first<any>();expect(row).toMatchObject({id:workId,state:"stopping"});
 }finally{provider.worker=undefined;}
});
