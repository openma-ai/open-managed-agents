import type { Spawner } from "@open-managed-agents/acp-runtime";
import type { WorkRuntimeModules } from "../../../packages/harness-runtime-acp/src/node-work-composition.js";
/** Wire peer only: production AcpRuntimeImpl owns JSON-RPC, startup, prompt,
 * steering, cancellation, errors and activity accounting. No fake AcpSession. */
export interface ParityPeerHooks {
 start?(): Promise<void>;
 prompt(text: string): AsyncGenerator<any>;
 steer?(text: string): Promise<void>;
 cancel?(): void;
}
export async function parityModules(): Promise<WorkRuntimeModules | undefined> {
 const candidate=process.env.OPENMA_COMMON_CANDIDATE;
 if(!candidate)return undefined; // installed loader must prove its own capability, never skip
 const common=await import(/* @vite-ignore */ candidate+"/src/managed-runtime/index.ts");
 const mapping=await import(/* @vite-ignore */ candidate+"/src/acp-runtime/permission-mapping.ts");
 const {AcpRuntimeImpl}=await import(/* @vite-ignore */ candidate+"/src/acp-runtime/runtime.ts");
 return {control:{createSupervisor:common.createManagedAcpSupervisorHarness,createControlChannel:common.createManagedHarnessHttpControlChannel,applyPermissionMode:mapping.applyAcpPermissionMode},createAcpRuntime:spawner=>new AcpRuntimeImpl(spawner)};
}
export function parityPeer(hooks:ParityPeerHooks,kind:"codex"|"claude"="codex"): Spawner {
 return {async spawn(){
  await hooks.start?.();
  let enqueue!:(v:object)=>void,closed=false,buffer="";
  let exit!:()=>void;const exited=new Promise<{code:number;signal:null}>(resolve=>{exit=()=>resolve({code:0,signal:null});});
  const pending=new Set<Promise<void>>();
  const modes=kind==="codex"?["read-only","agent","agent-full-access"]:["default","auto","bypassPermissions"];
  const options=[{id:"mode",name:"Mode",category:"mode",type:"select",currentValue:modes[1],options:modes.map(value=>({value,name:value}))}];
  const text=(params:any)=>params.prompt.map((v:any)=>v.text??"").join("");
  const send=(v:object)=>{if(!closed)enqueue(v);};
  const answer=async(m:any)=>{
   if(m.method==="initialize")send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:kind==="codex"?"@agentclientprotocol/codex-acp":"@agentclientprotocol/claude-agent-acp",version:kind==="codex"?"1.8.0":"0.94.0"},_meta:{steering:{supported:true}}}});
   else if(m.method==="session/new"||m.method==="session/load")send({id:m.id,result:{sessionId:"parity-native",configOptions:options}});
   else if(m.method==="session/set_config_option"){options[0]!.currentValue=m.params.value;send({id:m.id,result:{configOptions:options}});}
   else if(m.method==="_session/steering"){await hooks.steer?.(text(m.params));send({id:m.id,result:{outcome:"injected"}});}
   else if(m.method==="session/cancel"){hooks.cancel?.();}
   else if(m.method==="session/prompt"){
    try {
     for await(const event of hooks.prompt(text(m.params))){
      if(event.type==="promptComplete")continue;
      send({method:"session/update",params:{sessionId:"parity-native",update:event}});
     }
     send({id:m.id,result:{stopReason:"end_turn"}});
    }catch(error){send({id:m.id,error:{code:-32603,message:error instanceof Error?error.message:String(error)}});}
   }else if(m.id!==undefined)send({id:m.id,result:{}});
  };
  return {
   stdout:new ReadableStream<Uint8Array>({start(c){enqueue=v=>c.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:"2.0",...v})+"\n"));}}),
   stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),
   stdin:new WritableStream<Uint8Array>({write(bytes){buffer+=new TextDecoder().decode(bytes);while(buffer.includes("\n")){const end=buffer.indexOf("\n"),m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
    const operation=answer(m);pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});
   }} }),
   async kill(){hooks.cancel?.();closed=true;exit();},exited,
  };
 }};
}
