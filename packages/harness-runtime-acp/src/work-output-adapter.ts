import type { ManagedRuntimeEventWire } from "@openma/common/managed-runtime";

/** One ordering/failure domain for projector output and permission publication.
 * Delay tool_use until result/terminal: ACP can ask permission after emitting
 * its pending tool notification. Never publish an immutable unapproved twin. */
export function createWorkOutputAdapter(options: {
 publish(events: ManagedRuntimeEventWire[]): Promise<void>;
 toolUseIdFor(id:string): string | undefined;
}) {
 const pending = new Map<string,ManagedRuntimeEventWire>();
 let tail:Promise<void>=Promise.resolve();
 function enqueue(run:()=>Promise<void>) { tail=tail.then(run); return tail; }
 return {
  canonical(events:ManagedRuntimeEventWire[]) { return enqueue(()=>options.publish(events)); },
  projected(events:ManagedRuntimeEventWire[],terminal=false) {
   return enqueue(async()=>{
    const output:ManagedRuntimeEventWire[]=[];
    const flush=(id:string)=>{
     const tool=pending.get(id);pending.delete(id);
     if(tool&&!options.toolUseIdFor(id)) output.push(tool);
    };
    for(const event of events){
     if(event.type==="agent.tool_use"&&!event.session_thread_id){pending.set(event.id,event);continue;}
     if(event.type==="agent.tool_result"&&!event.session_thread_id&&typeof event.tool_use_id==="string"){
      flush(event.tool_use_id);output.push({...event,tool_use_id:options.toolUseIdFor(event.tool_use_id)??event.tool_use_id});
     }else output.push(event);
    }
    if(terminal){const rest:ManagedRuntimeEventWire[]=[];for(const [id,tool] of pending){if(!options.toolUseIdFor(id))rest.push(tool);}pending.clear();output.unshift(...rest);}
    if(output.length)await options.publish(output);
   });
  },
 };
}
