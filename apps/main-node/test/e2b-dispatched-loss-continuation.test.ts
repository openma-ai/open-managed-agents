import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import * as sdk from "e2b";
import { E2BSandboxExecutor } from "../../../packages/sandbox-adapter-e2b/src/e2b";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiHarness, registerHarness, type HarnessContext } from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";

// Real host/SQL/Pi/tools plus official E2B Commands stream and production
// executor classification. Only SDK RPC transport is a local deterministic peer.
it.each([["terminal",false,false],["transport",false,false],["transport",true,false],["transport",false,true]] as const)("SDK post-dispatch %s is observed before continuation (mixed %s, replay %s)", async (failure,mixed,replay) => {
  const dir=mkdtempSync(join(tmpdir(),"oma-e2b-loss-"));
  const first=`printf x >> ${join(dir,"first-effect")}`;
  const faux=fauxProvider({tokensPerSecond:100_000}); let observed:any[]=[];let faults=0;let errorChain:any;let failedRuntime:object|undefined;let recoveryRuntime:object|undefined;const dead=new WeakSet<object>();
  faux.setResponses([
    fauxAssistantMessage([...(mixed?[fauxToolCall("approve",{},{id:"c1"})]:[]),fauxToolCall("bash",{command:first},{id:"failed-call"}),...(mixed?[fauxToolCall("write",{file_path:"/ordinary-effect",content:"ordinary"},{id:"ordinary"}),fauxToolCall("approve",{},{id:"c2"})]:[])],{stopReason:"toolUse"}),
    context=>{observed=structuredClone(context.messages);return fauxAssistantMessage([replay ? fauxToolCall("bash",{command:first},{id:"recovery"}) : fauxToolCall("write",{file_path:"/recovery-effect",content:"recovered"},{id:"recovery"})],{stopReason:"toolUse"});},
    fauxAssistantMessage("normal completion"),
  ]);
  const models=createModels();models.setProvider(faux.provider);
  const harness="sdk-loss-"+crypto.randomUUID();registerHarness(harness,()=>({async run(ctx:HarnessContext){await new PiHarness().run({...ctx,pi:{models,model:faux.getModel(),thinkingLevel:"off",speed:"standard"}});}}));
  const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"1",PLATFORM_ROOT_SECRET:"local-sdk-classification-test-root-secret",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",MEMORY_QUEUE:"disabled",DATABASE_PATH:join(dir,"oma.db"),AUTH_DATABASE_PATH:join(dir,"auth.db"),SANDBOX_WORKDIR:join(dir,"sandboxes"),MEMORY_BLOB_DIR:join(dir,"memories"),FILES_BLOB_DIR:join(dir,"files"),SESSION_OUTPUTS_DIR:join(dir,"outputs")});
  const components=await nodeDefaults(config);const provider=components.sessionSandboxProvider!.provider;
  const wrap=(target:any)=>new Proxy(target,{get(target,key){
    if(key==="exec")return async(command:string,...args:any[])=>{
      if(command!==first)return target.exec(command,...args);
      const native=new sdk.Sandbox({sandboxId:"offline-sdk",envdVersion:"0.3.0",apiKey:"offline-placeholder"});
      Object.assign(native.commands,{rpc:{start:()=> (async function*(){
        faults++;await target.exec(command,...args); // actual effect before stream loss
        yield {event:{event:{case:"start",value:{pid:123}}}};
        if(failure==="terminal"){failedRuntime=target;dead.add(target);await target.destroy();throw new sdk.SandboxNotRunningError("sandbox terminated after dispatch");}
        throw new Error("transport disconnected after dispatch");
      })()}});
      try{return await new E2BSandboxExecutor(native as never,{}).exec(command);}
      catch(error){errorChain={name:(error as Error).name,outcome:(error as any).outcome,cause:(error as Error).cause instanceof Error?((error as Error).cause as Error).name:undefined};throw error;}
    };
    if(key==="writeFile")return async(path:string,...args:any[])=>{
      if(path.endsWith("/recovery-effect"))recoveryRuntime=target;
      if(dead.has(target))throw new sdk.SandboxNotRunningError("cannot write to terminated provider runtime");
      return target.writeFile(path,...args);
    };
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
  const factory=components.sandbox;components.sandbox=async(...args:Parameters<typeof factory>)=>wrap(await factory(...args));
  components.sessionSandboxProvider={...components.sessionSandboxProvider!,provider:{...provider,create:async(...args:Parameters<typeof provider.create>)=>wrap(await provider.create(...args)),resume:async(...args:Parameters<typeof provider.resume>)=>wrap(await provider.resume(...args))}};
  const cp=await createNodeControlPlane(components);await cp.start();const db=new Database(join(dir,"oma.db"),{readonly:true});
  const server=serve({fetch:r=>cp.fetch(r),hostname:"127.0.0.1",port:0});if(!server.listening)await new Promise<void>(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=async(path:string,body?:unknown)=>{const res=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await res.json() as any;expect(res.ok,JSON.stringify(value)).toBe(true);return value;};
  try{
    await request("/v1/oma/model_cards",{provider:"ant",model_id:"sdk-local-model",api_key:"test",base_url:"http://unused.invalid"});
    const agent=await request("/v1/agents",{name:harness,model:"sdk-local-model",system:"test",_oma:{harness},tools:[{type:"agent_toolset_20260401"},{type:"custom",name:"approve",description:"approve",input_schema:{type:"object",properties:{}}}]});
    const environment=await request("/v1/environments",{name:harness,config:{type:"cloud"}});
    const session=await request("/v1/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id});
    const path=`/v1/sessions/${session.id}/events`;const history=async()=>(await request(path+"?limit=1000&order=asc")).data as any[];
    const settled=()=> (db.prepare("SELECT COUNT(*) AS n FROM managed_session_executions WHERE session_id=? AND state IN ('queued','running')").get(session.id) as any).n===0;
    await request(path,{events:[{type:"user.message",content:[{type:"text",text:"execute"}]}]});
    if(mixed){
      await expect.poll(async()=>settled()&&(await history()).some(e=>e.type==="session.status_idle"),{timeout:15000}).toBe(true);
      const before=await history();const idle=before.findIndex(e=>e.type==="session.status_idle");
      for(const id of ["failed-call","ordinary"])expect(before.findIndex(e=>e.type==="agent.tool_result"&&e.tool_use_id===id)).toBeLessThan(idle);
      expect(before.find(e=>e.type==="agent.tool_result"&&e.tool_use_id==="ordinary").is_error).not.toBe(true);
      expect(before[idle].stop_reason.event_ids.sort()).toEqual(["c1","c2"]);expect(faux.state.callCount).toBe(1);
      const answer=(id:string)=>request(path,{events:[{type:"user.custom_tool_result",custom_tool_use_id:id,content:[{type:"text",text:"approved"}]}]});
      await answer("c1");await expect.poll(settled).toBe(true);expect(faux.state.callCount).toBe(1);
      await answer("c1");await expect.poll(settled).toBe(true);expect(faux.state.callCount).toBe(1);await answer("c2");
    }
    await expect.poll(async()=>settled()&&(await history()).some(e=>e.type==="session.status_idle"&&e.stop_reason.type===(replay?"requires_action":"end_turn")),{timeout:15000}).toBe(true);
    const events=await history();
    console.log(JSON.stringify({op:"actual.sdk.host.continuation",session:session.id,failure,mixed,replay,faults,replacedRuntime:failedRuntime!==undefined&&recoveryRuntime!==undefined&&failedRuntime!==recoveryRuntime,errorChain,modelCalls:faux.state.callCount,events,observed}));
    expect(errorChain).toMatchObject({outcome:"dispatched_unknown",cause:failure==="terminal"?"SandboxNotRunningError":"Error"});
    expect(observed.filter(m=>m.role==="toolResult"&&m.toolCallId==="failed-call")).toEqual([expect.objectContaining({isError:true})]);
    const open=new Set<string>();for(const message of observed){if(message.role==="assistant"){expect(open.size).toBe(0);for(const block of message.content)if(block.type==="toolCall")open.add(block.id);}if(message.role==="toolResult")expect(open.delete(message.toolCallId)).toBe(true);}expect(open.size).toBe(0);
    expect(events.filter(e=>e.type==="agent.tool_result"&&e.tool_use_id==="failed-call")).toEqual([expect.objectContaining({is_error:true})]);
    expect(events.some(e=>e.id?.startsWith("retry:"))).toBe(false);
    if(replay){
      expect(events.filter(e=>e.type==="session.status_idle")).toEqual([expect.objectContaining({stop_reason:{type:"requires_action",event_ids:["recovery"]}})]);
      expect(faux.state.callCount).toBe(2);expect(faults).toBe(1);
      expect(readFileSync(join(dir,"first-effect"),"utf8")).toBe("x");
      expect(events.some(e=>e.type==="agent.tool_result"&&e.tool_use_id==="recovery")).toBe(false);
      return;
    }
    expect(events.filter(e=>e.type==="session.status_idle"&&e.stop_reason.type!=="requires_action")).toEqual([expect.objectContaining({stop_reason:{type:"end_turn"}})]);
    expect(faux.state.callCount).toBe(3);expect(faults).toBe(1);
    if(failure==="terminal"){expect(recoveryRuntime).toBeDefined();expect(recoveryRuntime).not.toBe(failedRuntime);}
    expect(readFileSync(join(dir,"first-effect"),"utf8")).toBe("x");expect(readFileSync(join(dir,"sandboxes",session.id,"recovery-effect"),"utf8")).toBe("recovered");
  }finally{await new Promise<void>(r=>server.close(()=>r()));await cp.stop();db.close();rmSync(dir,{recursive:true,force:true});}
},60000);
