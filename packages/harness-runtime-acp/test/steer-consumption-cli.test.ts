import {expect,it} from "vitest";
import {lifecycleFixture,lifecycleWorker} from "../../../apps/main-node/test/session-lifecycle-parity-worker.helper";

it("default CLI consumes injected input under original root and publishes only that root",async()=>{
 const f=await lifecycleFixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 let worker:ReturnType<typeof lifecycleWorker>|undefined;const prompts:string[]=[],steers:string[]=[];
 try{
  await f.message("root task");const first=(await f.events()).find(e=>e.type==="user.message");await f.claim(false);
  worker=lifecycleWorker(f,{async *prompt(text){prompts.push(text);await gate;yield {type:"promptComplete",response:{}};},async steer(text){steers.push(text);}});
  await worker.waitFor(()=>prompts.length,1);await f.message("correction");await worker.waitFor(()=>steers,["correction"]);
  const rows=await f.cp.components.database.sql.prepare("SELECT document FROM managed_session_events WHERE session_id=? AND type='user.message' ORDER BY processed_at").bind(f.session.id).all<{document:string}>();
  const root=rows.results!.map(r=>JSON.parse(r.document)).find(e=>e.id===first.id);
  const correction=rows.results!.map(r=>JSON.parse(r.document)).find(e=>e.id!==first.id);
  expect(correction.source_position.consumed_by_execution_id).toBe(root.source_position.consumed_by_execution_id);
  expect(correction.source_position.execution_id??correction.id).not.toBe(root.source_position.consumed_by_execution_id);
  expect(correction.source_position.consumption_claim).toEqual(root.source_position.consumption_claim);
  const receipts=worker.responses.filter(r=>r.action==="inputs-consume");expect(receipts).toHaveLength(2);
  expect(receipts[1]).toMatchObject({status:200,body:{consumingTurnId:root.source_position.consumed_by_execution_id}});
  release();await worker.published();expect(prompts).toEqual(["root task"]);
  const terminals=(await f.events()).filter(e=>e.type==="session.status_idle"&&e.stop_reason?.type==="end_turn");expect(terminals).toHaveLength(1);
  expect(worker.responses.filter(r=>r.action==="work-publish"&&r.status===200)).toHaveLength(1);
 }finally{release?.();await worker?.stop();await f.dispose();}
},15000);

it.each(["promptRequired","permission","startedNewTurn","failed"] as const)("native %s never consumes twice or invents another root",async outcome=>{
 const {runNodeWorkItemCli}=await import("../src/node-work-item-cli");
 const {parityModules,parityPeer}=await import("../../../apps/main-node/test/session-lifecycle-parity-acp.fixture");
 const {createNodeAcpHarnessStateIo}=await import("../src/node");
 const {mkdir}=await import("node:fs/promises");
 const f=await lifecycleFixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const prompts:string[]=[],steers:string[]=[],receipts:Array<{action:string;body:unknown;status:number}>=[];
 const controller=new AbortController();let running:Promise<unknown>|undefined;
 try{
  await f.message("root before fallback");await f.claim(false);await f.prepareSandbox();
  const native=parityPeer({async *prompt(text){prompts.push(text);await gate;yield {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"continued"}};yield {type:"promptComplete",response:{}};},async steer(text){steers.push(text);release();}});
  const spawner:typeof native={async spawn(spec){const process=await native.spawn(spec);let text="",incoming="";let promptId:unknown, count=0;let withheld:unknown;let emit:((bytes:Uint8Array)=>void)|undefined;
   const writer=process.stdin.getWriter();
   return {...process,stdin:new WritableStream<Uint8Array>({async write(bytes){
    incoming+=new TextDecoder().decode(bytes);
    while(incoming.includes("\n")){const end=incoming.indexOf("\n");const m=JSON.parse(incoming.slice(0,end));incoming=incoming.slice(end+1);
     if(m.method==="session/prompt"){count++;promptId=m.id;}
     if(m.id==="continuation-permission"&&m.result){expect(m.result).toEqual({outcome:{outcome:"selected",optionId:"yes"}});emit!(new TextEncoder().encode(JSON.stringify(withheld)+"\n"));continue;}
     await writer.write(new TextEncoder().encode(JSON.stringify(m)+"\n"));
    }
   }}),stdout:process.stdout.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(bytes,out){
    text+=new TextDecoder().decode(bytes);while(text.includes("\n")){const end=text.indexOf("\n");const msg=JSON.parse(text.slice(0,end));text=text.slice(end+1);
     if(msg.result?.outcome==="injected")msg.result.outcome=outcome==="permission"?"promptRequired":outcome;
     if(outcome==="permission"&&count===2&&msg.id===promptId&&msg.result?.stopReason){
      withheld=msg;emit=bytes=>out.enqueue(bytes);
      out.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:"2.0",id:"continuation-permission",method:"session/request_permission",params:{sessionId:"parity-native",toolCall:{toolCallId:"continuation-tool",title:"Read"},options:[{optionId:"yes",kind:"allow_once",name:"Yes"},{optionId:"no",kind:"reject_once",name:"No"}]}})+"\n"));continue;
     }
     out.enqueue(new TextEncoder().encode(JSON.stringify(msg)+"\n"));
    }
   }}))};
  }};
  const workspace=f.root+"/fallback-native";await mkdir(workspace,{recursive:true});
  running=runNodeWorkItemCli({environment:{ANTHROPIC_ENVIRONMENT_ID:f.scope.environmentId,ANTHROPIC_SESSION_ID:f.scope.sessionId,ANTHROPIC_WORK_ID:f.scope.workId,OPENMA_HARNESS_ID:"acp",OPENMA_ACP_AGENT_ID:"codex-acp",ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:f.token(),api_base_url:f.base})).toString("base64url")},signal:controller.signal,heartbeatIntervalMs:50,
   runtime:{modules:await parityModules(),spawner,stateIo:createNodeAcpHarnessStateIo({workspacePath:workspace})},
   fetch:async(raw,init)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;const response=await f.nativeFetch(new Request(raw,init));if(action==="inputs-consume"||action==="work-publish")receipts.push({action,status:response.status,body:await response.clone().json()});
    if(outcome==="permission"&&action==="runtime-events"&&response.ok){const events=JSON.parse(String(init?.body)).events;for(const event of events)if(event.type==="agent.tool_use"&&event.evaluated_permission==="ask")await f.api("/v1/sessions/"+f.session.id+"/events",{events:[{type:"user.tool_confirmation",tool_use_id:event.id,result:"allow"}]});}
    return response;},
  }).catch(error=>error);
  await expect.poll(()=>prompts.length).toBe(1);await f.message("fallback correction");
  if(outcome==="promptRequired"||outcome==="permission"){
   await expect.poll(()=>receipts.filter(r=>r.action==="work-publish"&&r.status===200).length,{timeout:7000}).toBe(1);
   expect(prompts).toEqual(["root before fallback","fallback correction"]);
   expect((await f.events()).filter(e=>e.type==="session.status_idle"&&e.stop_reason?.type==="end_turn")).toHaveLength(1);
  }else{
   const result=await running;expect(result).toBeInstanceOf(Error);
   if(outcome==="startedNewTurn")expect(String(result)).toContain("unknown dispatch outcome");
   expect(prompts).toEqual(["root before fallback"]);
  }
  expect(steers).toEqual(["fallback correction"]);
  const consumption=receipts.filter(r=>r.action==="inputs-consume");
  expect(consumption).toHaveLength(outcome==="permission"?3:2);expect(consumption.every(r=>r.status===200)).toBe(true);
  expect(consumption[1].body).toMatchObject({consumingTurnId:(consumption[0].body as {turnId:string}).turnId});
 }finally{release?.();controller.abort();await running;await f.dispose();}
},15000);
