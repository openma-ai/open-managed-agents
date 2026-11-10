/** In-process turn finalization only, NOT replacement admission/recovery. The
 * admitted set is populated after this process receives a consume receipt.
 * A consumed/no-terminal gap supplies a CAS revision, never model permission. */
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const revision=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
interface Receipt {eventId:string;turnId:string;workId:string;generation:number;revision:number;stopReason:{type:string;eventIds?:string[]}}
function receipt(v:unknown,turnId:string):v is Receipt {
 return record(v)&&v.turnId===turnId&&typeof v.eventId==="string"&&v.eventId.length>0&&typeof v.workId==="string"&&v.workId.length>0&&revision(v.generation)&&revision(v.revision)&&record(v.stopReason)&&
  (v.stopReason.type==="end_turn"||v.stopReason.type==="budget_reached"||
    v.stopReason.type==="requires_action"&&Array.isArray(v.stopReason.eventIds)&&v.stopReason.eventIds.length>0&&v.stopReason.eventIds.every(id=>typeof id==="string"&&id.length>0));
}
export function createWorkTurnFinalizer(options:{apiBaseUrl:string;sessionId:string;sessionsToken:string;signal:AbortSignal;fetch?:typeof globalThis.fetch}) {
 const admitted=new Set<string>();const prepared=new Map<string,number>();const terminals=new Map<string,{revision:number;terminal:Receipt}>();
 async function post(action:string,body:object,allowGap=false):Promise<Record<string,unknown>> {
  options.signal.throwIfAborted();
  let response:Response;
  try {response=await (options.fetch??globalThis.fetch)(new URL(`/v1/oma/sessions/${encodeURIComponent(options.sessionId)}/${action}`,options.apiBaseUrl),{method:"POST",redirect:"error",signal:options.signal,headers:{authorization:`Bearer ${options.sessionsToken}`,"content-type":"application/json"},body:JSON.stringify(body)});}
  catch {throw new Error(`Work ${action} response unknown; do not replay`);}
  const value:unknown=await response.json();options.signal.throwIfAborted();
  if(!record(value)||(!response.ok&&!(allowGap&&response.status===409&&value.type==="gap"&&value.reason==="consumed_turn_without_terminal")))throw new Error(`Work ${action} rejected (${response.status})`);
  return value;
 }
 return {
  admitted(turnId:string){admitted.add(turnId);},
  async checkpoint(turnId:string){
   if(!admitted.has(turnId))throw new Error("Cannot finalize a turn not admitted by this process");
   const current=await post("work-recovery",{turnId},true);
   if(current.type!=="gap"||current.reason!=="consumed_turn_without_terminal"||!revision(current.revision))throw new Error("Active turn has no uncommitted canonical boundary");
   const result=await post("work-checkpoint",{turnId,revision:current.revision});
   if(result.type!=="prepared"||result.turnId!==turnId||result.revision!==current.revision)throw new Error("Invalid Work checkpoint receipt");
   prepared.set(turnId,current.revision);
  },
  async complete(turnId:string){
   const current=prepared.get(turnId);if(current===undefined)throw new Error("Work checkpoint must precede terminal");
   // Invalidate before IO so callers cannot repeat an unknown terminal write.
   prepared.delete(turnId);
   const result=await post("work-finalize",{turnId,revision:current,stopReason:{type:"end_turn"}});
   if(!["committed","parked"].includes(String(result.type))||!revision(result.revision)||!receipt(result.terminal,turnId)||result.terminal.revision>result.revision||
     (result.type==="parked")!==(result.terminal.stopReason.type!=="end_turn"))throw new Error("Invalid Work terminal receipt");
   terminals.set(turnId,{revision:result.revision,terminal:result.terminal});
  },
  async publish(turnId:string){
   const terminal=terminals.get(turnId);if(!terminal)throw new Error("Durable Work terminal ACK required");
   const result=await post("work-publish",{turnId,revision:terminal.revision,terminalEventId:terminal.terminal.eventId});
   if(result.type!=="published"||result.revision!==terminal.revision||!receipt(result.terminal,turnId)||result.terminal.eventId!==terminal.terminal.eventId||
    result.terminal.stopReason.type!==terminal.terminal.stopReason.type||
    JSON.stringify(result.terminal.stopReason.eventIds)!==JSON.stringify(terminal.terminal.stopReason.eventIds))throw new Error("Invalid Work publication receipt");
   terminals.delete(turnId);admitted.delete(turnId);
  },
 };
}
