import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it, vi } from "vitest";
import { mixedPlatformModel } from "../../packages/agent-harness/test/provider-failure-model";
import { PiHarness } from "../../packages/agent-harness/src/pi-loop";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { ensureModelCards } from "./_model-cards";
import { OAUTH_MCP_TEST_PORT } from "../fixtures/oauth-mcp-local-endpoint";
const command="printf x >> bash-effect.txt; cat bash-effect.txt";
const custom=(id:string)=>({id,name:"approve",args:{ticket:id}});
const bash={id:"b1",name:"bash",args:{command}};
const mcp={id:"m1",name:"mcp__docs__effect",args:{}};
beforeAll(()=>ensureModelCards(["pi-mixed-local"]));
// Default Pi, real Session/D1/DO restart, actual loopback bash and MCP bytes.
// The local peer supplies execution only; this is not a CF container SDK test.
it.each([
  ["custom-first",[custom("c1"),bash]], ["custom-last",[bash,custom("c1")]],
  ["mcp",[custom("c1"),mcp]], ["multiple",[custom("c1"),bash,mcp,custom("c2")]],
] as const)("Pi %s retains results across DO restart without replay", async(label,calls)=>{
  const id=crypto.randomUUID(), peer=`http://127.0.0.1:${OAUTH_MCP_TEST_PORT+1}/${id}`;
  const originalFetch=globalThis.fetch;
  vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(new URL(request.url).hostname!=="pi-mixed-mcp.test")return originalFetch(input,init);
    return originalFetch(peer+"/mcp",{method:request.method,headers:request.headers,body:request.method==="POST"?await request.text():undefined});
  });
  const model=mixedPlatformModel([...calls],label==="multiple");
  const harness="pi-mixed-"+id;
  registerHarness(harness,()=>({async run(ctx){await new PiHarness().run({...ctx,pi:{models:model.models,model:model.faux.getModel(),thinkingLevel:"off",speed:"standard"}});}}));
  const request=async(path:string,body?:unknown)=>{
    const res=await exports.default.fetch(new Request("http://localhost"+path,{method:body===undefined?"GET":"POST",headers:{"x-api-key":"test-key","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const data=await res.json() as any;expect(res.ok,JSON.stringify(data)).toBe(true);return data;
  };
  let snapshot=async()=>({});
  try {
    const agent=await request("/v1/agents",{name:harness,model:"pi-mixed-local",_oma:{harness},mcp_servers:[{type:"url",name:"docs",url:"https://pi-mixed-mcp.test/rpc"}],tools:[{type:"agent_toolset_20260401"},{type:"mcp_toolset",mcp_server_name:"docs"},{type:"custom",name:"approve",description:"approval",input_schema:{type:"object",properties:{ticket:{type:"string"}},required:["ticket"]}}]});
    const environment=await request("/v1/environments",{name:harness,config:{type:"cloud"}});
    const session=await request("/v1/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id});
    let stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
    const bindExecutor=()=>runInDurableObject(stub,async(instance:any)=>{
      await instance._sandboxWarm;instance.ensureSandboxCreated();
      const state=instance.portsSandbox.state, original=state.options.executor;
      const wrap=(target:any)=>new Proxy(target,{get(target,key){
        if(key==="exec")return async(program:string,...args:unknown[])=>{
          if(program!==command)return target.exec(program,...args);
          const response=await originalFetch(peer+"/bash",{method:"POST",body:JSON.stringify({command:program})});
          if(!response.ok)throw new Error("local bash execution refused");
          const result=await response.json() as any;
          return `exit=${result.exitCode}\n${result.stdout}`;
        };
        const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
      }});
      state.options.executor=(...args:any[])=>wrap(original(...args));
      if(state.current)state.current.executor=wrap(state.current.executor);
    });
    const history=async()=>(await request(`/v1/sessions/${session.id}/events?limit=1000&order=asc`)).data;
    snapshot=async()=>({session_id:session.id,events:await history(),model_calls:model.faux.state.callCount,model_history:model.observed,work:await env.MAIN_DB.prepare("SELECT id,state,generation,attempt_count,failure FROM managed_session_executions WHERE session_id=?").bind(session.id).all()});
    const settled=async()=>Number((await env.MAIN_DB.prepare("SELECT COUNT(*) AS n FROM managed_session_executions WHERE session_id=? AND state IN ('queued','running')").bind(session.id).first() as any).n);
    await bindExecutor();
    await request(`/v1/sessions/${session.id}/events`,{events:[{type:"user.message",content:[{type:"text",text:"mixed turn"}]}]});
    await expect.poll(async()=>(await history()).some((e:any)=>e.type==="session.status_idle"&&e.stop_reason.type==="requires_action"),{timeout:15_000}).toBe(true);
    await expect.poll(settled,{timeout:15_000}).toBe(0);
    const before=await history();const park=before.findIndex((e:any)=>e.type==="session.status_idle");
    const ordinary=calls.filter(c=>c.name!=="approve");
    for(const call of ordinary){const result=before.find((e:any)=>(e.tool_use_id??e.mcp_tool_use_id)===call.id);expect(result).toBeDefined();expect(before.indexOf(result)).toBeLessThan(park);expect(result.is_error).not.toBe(true);expect(JSON.stringify(result.content)).toContain(call.id==="b1"?"x":"effect committed");}
    expect(model.faux.state.callCount).toBe(1);
    console.log(JSON.stringify({op:"pi.mixed.before_evict",session_id:session.id}));
    await runInDurableObject(stub, async (instance:any,state:any) => {
      await instance._finalizePromise;
      await instance._recoveryPromise; await instance._recoveryRun;
      await Promise.all(instance._maintenanceRuns.values());
      await state.storage.deleteAlarm();
    });
    // Hard restart models a crashed owner; graceful eviction can wait on
    // retained RPC references even after Work and maintenance have settled.
    await expect(runInDurableObject(stub, (_instance:any,state:any) => {
      state.abort("pi-mixed controlled post-park restart");
    })).rejects.toThrow();
    console.log(JSON.stringify({op:"pi.mixed.after_evict",session_id:session.id}));
    stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
    await bindExecutor();
    const answer=(callId:string)=>request(`/v1/sessions/${session.id}/events`,{events:[{type:"user.custom_tool_result",custom_tool_use_id:callId,content:[{type:"text",text:"approved"}]}]});
    const customs=calls.filter(c=>c.name==="approve");
    if(customs.length>1){await answer(customs[0].id);await expect.poll(settled,{timeout:15_000}).toBe(0);expect(model.faux.state.callCount).toBe(1);await answer(customs[0].id);await expect.poll(settled,{timeout:15_000}).toBe(0);expect(model.faux.state.callCount).toBe(1);}
    await answer(customs.at(-1)!.id);
    await expect.poll(async()=>(await history()).some((e:any)=>e.type==="session.status_idle"&&e.stop_reason.type==="end_turn"),{timeout:15_000}).toBe(true);
    await expect.poll(settled,{timeout:15_000}).toBe(0);
    const after=await history(),effects=await(await originalFetch(peer+"/effects")).json() as any;
    expect(effects).toEqual({bash:calls.some(c=>c.id==="b1")?"x":"",mcp:calls.some(c=>c.id==="m1")?"x":""});
    expect(model.faux.state.callCount).toBe(2);
    for(const call of calls){const results=(model.observed[0] as any[]).filter(m=>m.role==="toolResult"&&m.toolCallId===call.id);expect(results).toHaveLength(1);}
    expect(after.filter((e:any)=>e.type==="session.error")).toEqual([]);
    expect(after.filter((e:any)=>e.type==="session.status_idle"&&e.stop_reason.type==="end_turn")).toHaveLength(1);
    if(label==="multiple") {
      await request(`/v1/sessions/${session.id}/events`,{events:[{type:"user.message",content:[{type:"text",text:"second distinct round"}]}]});
      await expect.poll(async()=>(await history()).some((e:any)=>e.type==="agent.custom_tool_use"&&e.id==="c2_r2"),{timeout:15_000}).toBe(true);
      await expect.poll(settled,{timeout:15_000}).toBe(0);
      const secondPark=await history();
      const lastPark=secondPark.findLastIndex((e:any)=>e.type==="session.status_idle");
      for(const call of ordinary){const result=secondPark.find((e:any)=>(e.tool_use_id??e.mcp_tool_use_id)===call.id+"_r2");expect(result).toBeDefined();expect(secondPark.indexOf(result)).toBeLessThan(lastPark);}
      await answer("c1"); // Late first-round answer must not satisfy c1_r2.
      await expect.poll(settled,{timeout:15_000}).toBe(0);expect(model.faux.state.callCount).toBe(3);
      await answer("c1_r2");await expect.poll(settled,{timeout:15_000}).toBe(0);expect(model.faux.state.callCount).toBe(3);
      await answer("c2_r2");
      await expect.poll(async()=>(await history()).filter((e:any)=>e.type==="session.status_idle"&&e.stop_reason.type==="end_turn").length,{timeout:15_000}).toBe(2);
      await expect.poll(settled,{timeout:15_000}).toBe(0);
      expect(model.faux.state.callCount).toBe(4);
      expect(await(await originalFetch(peer+"/effects")).json()).toEqual({bash:"xx",mcp:"xx"});
      for(const call of calls)expect((model.observed[1] as any[]).filter(m=>m.role==="toolResult"&&m.toolCallId===call.id+"_r2")).toHaveLength(1);
    }
    for(const messages of model.observed as any[][]) {
      const open=new Set<string>();
      for(const message of messages) {
        if(message.role==="assistant") {expect([...open]).toEqual([]);for(const part of message.content)if(part.type==="toolCall")open.add(part.id);}
        if(message.role==="toolResult"){expect(open.has(message.toolCallId)).toBe(true);open.delete(message.toolCallId);}
      }
      expect([...open]).toEqual([]);
    }
    console.log(JSON.stringify({op:"pi.mixed.restart",label,session_id:session.id,model_calls:model.faux.state.callCount,effects,before,after,model_history:model.observed}));
  } finally {console.log(JSON.stringify({op:"pi.mixed.final",label,...await snapshot()}));vi.unstubAllGlobals();}
},60_000);
