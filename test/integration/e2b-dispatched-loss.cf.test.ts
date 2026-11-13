import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import * as sdk from "../../apps/main-node/node_modules/e2b/dist/index.mjs";
import { E2BSandboxExecutor } from "../../packages/sandbox-adapter-e2b/src/e2b";
import { sdkPostDispatchModel } from "../../packages/agent-harness/test/provider-failure-model";
import { PiHarness } from "../../packages/agent-harness/src/pi-loop";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { ensureModelCards } from "./_model-cards";
import { OAUTH_MCP_TEST_PORT } from "../fixtures/oauth-mcp-local-endpoint";

beforeAll(() => ensureModelCards(["sdk-post-dispatch"]));
// Actual Workerd host/DO/D1/default Pi and E2B Commands -> executor classifier.
// RPC fault peer is local; its bash side effects execute on the loopback peer.
// This is not a live CF or E2B deployment acceptance test.
it.each(["terminal", "transport"] as const)("CF observes SDK %s loss then executes a distinct command", async failure => {
  const id=crypto.randomUUID(), peer=`http://127.0.0.1:${OAUTH_MCP_TEST_PORT+1}/${id}`;
  const first="printf x >> bash-effect.txt; cat bash-effect.txt", recovery="printf y >> bash-effect.txt; cat bash-effect.txt";
  const model=sdkPostDispatchModel(first,recovery);const {faux,models,observed}=model;let faults=0;let classified:any;
  const harness="cf-sdk-"+id;
  registerHarness(harness,()=>({async run(ctx){await new PiHarness().run({...ctx,pi:{models,model:faux.getModel(),thinkingLevel:"off",speed:"standard"}});}}));
  const request=async(path:string,body?:unknown)=>{
    const res=await exports.default.fetch(new Request("http://localhost"+path,{method:body===undefined?"GET":"POST",headers:{"x-api-key":"test-key","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const data=await res.json() as any;expect(res.ok,JSON.stringify(data)).toBe(true);return data;
  };
  const agent=await request("/v1/agents",{name:harness,model:"sdk-post-dispatch",_oma:{harness},tools:[{type:"agent_toolset_20260401"}]});
  const environment=await request("/v1/environments",{name:harness,config:{type:"cloud"}});
  const session=await request("/v1/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id});
  const stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
  await runInDurableObject(stub,async(instance:any)=>{
    await instance._sandboxWarm;instance.ensureSandboxCreated();
    const state=instance.portsSandbox.state, original=state.options.executor;
    const wrap=(target:any)=>new Proxy(target,{get(target,key){
      if(key==="exec")return async(command:string,...args:any[])=>{
        if(command!==first&&command!==recovery)return target.exec(command,...args);
        const effect=async()=>{
          const response=await fetch(peer+"/bash",{method:"POST",body:JSON.stringify({command})});
          expect(response.ok).toBe(true);const result=await response.json() as any;expect(result.exitCode).toBe(0);return result.stdout;
        };
        if(command===recovery)return effect();
        const native=new sdk.Sandbox({sandboxId:"offline-sdk",envdVersion:"0.3.0",apiKey:"offline-placeholder"});
        Object.assign(native.commands,{rpc:{start:()=> (async function*(){
          faults++;await effect();yield {event:{event:{case:"start",value:{pid:123}}}};
          if(failure==="terminal")throw new sdk.SandboxNotRunningError("provider terminated after dispatch");
          throw new Error("transport lost after dispatch");
        })()}});
        try{return await new E2BSandboxExecutor(native as never,{}).exec(command);}
        catch(error){classified={name:(error as Error).name,cause:((error as Error).cause as Error)?.name,outcome:(error as any).outcome};throw error;}
      };
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    state.options.executor=(...args:any[])=>wrap(original(...args));if(state.current)state.current.executor=wrap(state.current.executor);
  });
  const path=`/v1/sessions/${session.id}/events`;
  const history=async()=>(await request(path+"?limit=1000&order=asc")).data as any[];
  const work=()=>env.MAIN_DB.prepare("SELECT state,attempt_count,failure FROM managed_session_executions WHERE session_id=?").bind(session.id).all();
  try{
    await request(path,{events:[{type:"user.message",content:[{type:"text",text:"execute"}]}]});
    await expect.poll(async()=>(await history()).some(e=>e.type==="session.status_idle"),{timeout:15000}).toBe(true);
    await expect.poll(async()=>(await work()).results.every(e=>e.state==="completed"),{timeout:15000}).toBe(true);
    const events=await history();
    expect(observed.filter(m=>m.role==="toolResult"&&m.toolCallId==="original")).toEqual([expect.objectContaining({isError:true})]);
    const open=new Set<string>();for(const message of observed){if(message.role==="assistant"){expect(open.size).toBe(0);for(const block of message.content)if(block.type==="toolCall")open.add(block.id);}if(message.role==="toolResult")expect(open.delete(message.toolCallId)).toBe(true);}expect(open.size).toBe(0);
    expect(events.filter(e=>e.type==="agent.tool_result"&&e.tool_use_id==="original")).toEqual([expect.objectContaining({is_error:true})]);
    expect(events.filter(e=>e.type==="session.status_idle")).toEqual([expect.objectContaining({stop_reason:{type:"end_turn"}})]);
    expect(events.some(e=>e.id?.startsWith("retry:"))).toBe(false);expect(events.filter(e=>e.type==="session.error")).toEqual([]);
    expect(faux.state.callCount).toBe(3);expect(faults).toBe(1);
    expect(classified).toEqual({name:failure==="terminal"?"SandboxGoneError":"Error",cause:failure==="terminal"?"SandboxNotRunningError":"Error",outcome:"dispatched_unknown"});
    const results=events.filter(e=>e.type==="agent.tool_result"&&e.tool_use_id==="recovery");
    expect(results).toHaveLength(1);expect(results[0].is_error).not.toBe(true);
    expect(results[0].content).toEqual([{type:"text",text:"xy"}]);
    expect(await(await fetch(peer+"/effects")).json()).toEqual({bash:"xy",mcp:""});
    for(const row of (await work()).results)expect(row).toMatchObject({state:"completed",attempt_count:1});
  }finally{console.log(JSON.stringify({op:"cf.sdk.post_dispatch",failure,session:session.id,faults,classified,modelCalls:faux.state.callCount,observed,events:await history(),work:await work()}));}
},60000);
