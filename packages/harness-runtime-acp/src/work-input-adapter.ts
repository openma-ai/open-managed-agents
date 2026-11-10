import { isDeepStrictEqual } from "node:util";
import type { createWorkInputsHttpClient } from "./work-inputs-http.js";
export interface WorkWireInput extends Record<string, unknown> { id: string; type: string; processed_at: string | null }

// Only protocol field names are translated. Tool inputs, metadata and arbitrary
// user JSON remain opaque; source_position and exact CAS bytes are never rebuilt.
const names: Record<string,string> = {heldAfterExhausted:"held_after_exhausted",denyMessage:"deny_message",processedAt:"processed_at",sessionThreadId:"session_thread_id",toolUseId:"tool_use_id",customToolUseId:"custom_tool_use_id",isError:"is_error",stopReason:"stop_reason",eventIds:"event_ids",actionType:"action_type",maxIterations:"max_iterations",outcomeId:"outcome_id",fileId:"file_id",mediaType:"media_type",cacheControl:"cache_control",retryStatus:"retry_status",mcpServerName:"mcp_server_name",evaluatedPermission:"evaluated_permission"};
const nested = new Set(["content","source","stopReason","error","rubric"]);
function wire(value: unknown): unknown {
 if(Array.isArray(value)) return value.map(wire);
 if(value===null || typeof value!=="object") return value;
 return Object.fromEntries(Object.entries(value).map(([key,value])=>[names[key]??key,nested.has(key)?wire(value):value]));
}
export function createWorkInputReader(client: ReturnType<typeof createWorkInputsHttpClient>) {
 const readLocations = new WeakMap<object, {cursor: string | null; limit: number}>();
 const originals = new WeakMap<object,{inputId:string;turnId:string;expectedDocument:string}>();
 return {
  async read(input: {cursor:string|null;limit:number;signal:AbortSignal}) {
   const page=await client.read(input);
   const events=page.rows.map(row=>{
    const raw: Record<string,unknown> = JSON.parse(row.document);
    const source = raw.source_position as Record<string,unknown>;
    const event: WorkWireInput = {...wire(raw) as Record<string,unknown>,id:row.event.id,type:row.event.type,processed_at:row.event.processedAt};
    readLocations.set(event, {cursor:input.cursor,limit:page.rows.length});
    originals.set(event,{inputId:event.id,turnId:typeof source.execution_id==="string"&&source.execution_id?source.execution_id:event.id,expectedDocument:row.document});
    return event;
   });
   return {events,cursor:page.cursor,hasMore:page.hasMore};
  },
  async verifyConsumption(event: Readonly<Record<string,unknown>>, root: {turnId:string;expectedDocument:string}, signal:AbortSignal) {
   const location=readLocations.get(event), identity=originals.get(event);
   if(!location||!identity)throw new Error("Unknown continuation input");
   const page=await client.read({...location,signal});
   const row=page.rows.find(row=>row.event.id===identity.inputId);
   if(!row)throw new Error("Continuation input unavailable");
   const raw=JSON.parse(row.document), original=JSON.parse(identity.expectedDocument), rootRaw=JSON.parse(root.expectedDocument);
   const expected={...original,processedAt:raw.processedAt,source_position:{...original.source_position,consumed_by_execution_id:root.turnId,consumption_claim:rootRaw.source_position.consumption_claim}};
   if(typeof raw.processedAt!=="string"||!Number.isFinite(Date.parse(raw.processedAt))||!isDeepStrictEqual(raw,expected))throw new Error("Canonical continuation consumption changed");
  },
  async consumedRoot(event: Readonly<Record<string,unknown>>, signal: AbortSignal) {
   const location=readLocations.get(event), identity=originals.get(event);
   if(!location||!identity)throw new Error("Input did not originate from the private Work reader");
   // Immutable source positions let us re-read exactly the original bounded
   // page, without advancing/resetting the live pump cursor or fabricating CAS.
   const page=await client.read({...location,signal});
   const row=page.rows.find(row=>row.event.id===identity.inputId);
   if(!row)throw new Error("Consumed Work root is unavailable");
   const raw=JSON.parse(row.document) as {processedAt:unknown;source_position?:{execution_id?:unknown;consumed_by_execution_id?:unknown;consumption_claim?:unknown}};
   if(typeof raw.processedAt!=="string" || !Number.isFinite(Date.parse(raw.processedAt)) ||
      (raw.source_position?.execution_id??row.event.id)!==identity.turnId || raw.source_position?.consumed_by_execution_id!==identity.turnId ||
      !raw.source_position.consumption_claim)throw new Error("Consumed Work root is unavailable");
   return {inputId:identity.inputId,turnId:identity.turnId,expectedDocument:row.document};
  },
  input(event: Readonly<Record<string,unknown>>) {
   const input=originals.get(event);
   if(!input) throw new Error("Input did not originate from the private Work reader");
   return {...input};
  },
 };
}
