import type { ManagedRuntimeEventWire } from "@openma/common/managed-runtime";

/** One ordering/failure domain for projector output and permission publication.
 * Delay tool_use until result/terminal: ACP can ask permission after emitting
 * its pending tool notification. Never publish an immutable unapproved twin. */
export function createWorkOutputAdapter(options: {
 publish(events: ManagedRuntimeEventWire[], customInvocations?: Array<{receipt:string;nativeCallId:string}>): Promise<void>;
 toolUseIdFor(id:string): string | undefined;
 customToolNames?(): ReadonlySet<string>;
 /** Native names returned for the host-owned Core MCP server, not all tools. */
 customInvocationToolNames?(): ReadonlySet<string>;
 /** Core reads an opaque MCP receipt without binding it. The publication
  * transaction binds it to call.id under the current Work fence. null means ordinary tool output. Do not infer an
  * identity from the tool's arguments or its MCP JSON-RPC request ID. */
 customInvocation?(call: ManagedRuntimeEventWire, result: ManagedRuntimeEventWire): Promise<{receipt:string;name:string;input:Record<string,unknown>} | null>;
}) {
 if(options.customInvocation&&!options.customInvocationToolNames)throw new Error('Core MCP output requires native tool names');
 const nativeNames = new Map<string,string>();
 const pending = new Map<string,ManagedRuntimeEventWire>();
 let tail:Promise<void>=Promise.resolve();
 function enqueue(run:()=>Promise<void>) { tail=tail.then(run); return tail; }
 return {
  /** Observe the native ACP name before the shared projector replaces it with
   * a display title. Titles and tool output are not tool identities. */
  nativeTool(update: {toolCallId?:unknown;name?:unknown}) {
   if(typeof update.toolCallId!=="string"||typeof update.name!=="string")return;
   const previous=nativeNames.get(update.toolCallId);
   if(previous!==undefined&&previous!==update.name)throw new Error("Native tool identity changed");
   nativeNames.set(update.toolCallId,update.name);
  },
  canonical(events:ManagedRuntimeEventWire[]) { return enqueue(()=>options.publish(events)); },
  projected(events:ManagedRuntimeEventWire[],terminal=false) {
   return enqueue(async()=>{
    const output:ManagedRuntimeEventWire[]=[];
    const bindings:Array<{receipt:string;nativeCallId:string}>=[];
    const flush=(id:string)=>{
     const tool=pending.get(id);pending.delete(id);
     if(tool&&!options.toolUseIdFor(id)) output.push(tool);
    };
    for(const event of events){
     if(event.type==="agent.tool_use"&&!event.session_thread_id){pending.set(event.id,event);continue;}
     if(event.type==="agent.tool_result"&&!event.session_thread_id&&typeof event.tool_use_id==="string"){
      const call=pending.get(event.tool_use_id);
      const invocation=call && options.customInvocationToolNames?.().has(nativeNames.get(String(call.id)) ?? "") && event.is_error!==true ? await options.customInvocation?.(call,event) : null;
      if(call&&invocation){
       pending.delete(event.tool_use_id);
       bindings.push({receipt:invocation.receipt,nativeCallId:String(call.id)});
       output.push({...call,type:"agent.custom_tool_use",name:invocation.name,input:invocation.input});
       continue; // a bound receipt is a pending request, never an answer
      }
      if(call&&typeof call.name==="string"&&options.customToolNames?.().has(call.name)&&isPendingCustomResult(event,call)) {
       pending.delete(event.tool_use_id);
       output.push({...call,type:"agent.custom_tool_use"});
       continue; // native checkpoint placeholder, not an external answer
      }
      flush(event.tool_use_id);output.push({...event,tool_use_id:options.toolUseIdFor(event.tool_use_id)??event.tool_use_id});
     }else output.push(event);
    }
    if(terminal){const rest:ManagedRuntimeEventWire[]=[];for(const [id,tool] of pending){if(!options.toolUseIdFor(id))rest.push(tool);}pending.clear();output.unshift(...rest);}
    if(output.length)await options.publish(output, bindings.length ? bindings : undefined);
   });
  },
 };
}

function isPendingCustomResult(result:ManagedRuntimeEventWire, call:ManagedRuntimeEventWire):boolean {
 if(result.is_error===true||!Array.isArray(result.content)||result.content.length!==1)return false;
 const block=result.content[0];
 if(!block||typeof block!=="object"||block.type!=="text"||typeof block.text!=="string")return false;
 try {
  const value=JSON.parse(block.text);
  return value?.details?.omaPendingCustom?.toolCallId===call.id && value.details.omaPendingCustom.name===call.name;
 } catch {return false;}
}
