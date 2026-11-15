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
   const originalLimit = page.rows.length;
   type Batch = { rootId: string; ids: string[] };
   const batchOf = (raw: Record<string, any>): Batch | undefined => {
    const batch = raw.source_position.input_batch;
    if (batch === undefined) return;
    if (!batch || typeof batch !== "object" || Array.isArray(batch) ||
        typeof batch.rootId !== "string" || !Array.isArray(batch.ids) ||
        batch.ids.length < 2 || batch.ids.length > 200 ||
        batch.ids.some((id: unknown) => typeof id !== "string" || !id) ||
        batch.ids[0] !== batch.rootId || new Set(batch.ids).size !== batch.ids.length ||
        Object.keys(batch).some(key => key !== "rootId" && key !== "ids")) {
     throw new Error("Invalid canonical input batch");
    }
    return batch;
   };
   // A same-lane acceptance group may straddle a page with other lanes
   // interleaved. Finish declared groups with bounded ordered seeks, retaining
   // each fetched row's actual readback location (never a fabricated cursor).
   const locations = new Map(page.rows.map(row => [row.event.id, {cursor:input.cursor,limit:originalLimit}]));
   for (let index = 0; index < page.rows.length; index++) {
    const batch = batchOf(JSON.parse(page.rows[index]!.document));
    if (!batch) continue;
    let remaining = batch.ids.filter(id => !locations.has(id));
    while (remaining.length && page.hasMore) {
     if (page.rows.length - originalLimit >= 200) throw new Error("Canonical input batch exceeds bounded read");
     const location = {cursor:page.cursor,limit:Math.min(remaining.length,200 - (page.rows.length - originalLimit))};
     const next = await client.read({...location,signal:input.signal});
     if (!next.rows.length || next.rows.some(row => locations.has(row.event.id))) throw new Error("Incomplete canonical input batch");
     for (const row of next.rows) locations.set(row.event.id,location);
     page.rows.push(...next.rows);
     page.cursor = next.cursor;
     page.hasMore = next.hasMore;
     remaining = batch.ids.filter(id => !locations.has(id));
    }
    if (remaining.length) throw new Error("Incomplete canonical input batch");
   }
   const emitted = new Set<string>();
   const events = page.rows.flatMap(row => {
    const raw = JSON.parse(row.document);
    const source = raw.source_position;
    const batch = batchOf(raw);
    if (emitted.has(row.event.id)) return [];
    const event: WorkWireInput = {...wire(raw) as Record<string,unknown>,id:row.event.id,type:row.event.type,processed_at:row.event.processedAt};
    readLocations.set(event, locations.get(event.id)!);
    originals.set(event,{inputId:event.id,turnId:typeof source.execution_id === "string" && source.execution_id ? source.execution_id : event.id,expectedDocument:row.document});
    if (batch) {
     if (row.event.id !== batch.rootId) throw new Error("Invalid canonical batch root");
     const content: unknown[] = [];
     let previousIndex = row.position.index - 1;
     for (const id of batch.ids) {
      const member = page.rows.find(candidate => candidate.event.id === id);
      if (!member) throw new Error("Incomplete canonical input batch");
      const value = JSON.parse(member.document);
      if (member.event.type !== "user.message" || member.position.revision !== row.position.revision ||
          member.position.index <= previousIndex || (value.sessionThreadId ?? "sthr_primary") !== (raw.sessionThreadId ?? "sthr_primary") ||
          !isDeepStrictEqual(value.source_position.input_batch,batch) ||
          (value.processedAt === null) !== (raw.processedAt === null) || value._queued === true || value.cancelled_at_ms != null ||
          value.deferredUntilToolResults !== undefined || value.deferred_until_tool_results !== undefined ||
          !isDeepStrictEqual(value.source_position.consumption_claim,source.consumption_claim) ||
          value.source_position.consumed_by_execution_id !== source.consumed_by_execution_id || !Array.isArray(value.content)) {
       throw new Error("Invalid canonical input batch");
      }
      previousIndex = member.position.index;
      if (content.length) content.push({type:"text",text:"\n"});
      content.push(...wire(value.content) as unknown[]);
      emitted.add(id);
     }
     event.content = content.every(block => typeof block === "object" && block !== null && (block as {type?:unknown}).type === "text")
      ? [{type:"text",text:content.map(block => (block as {text:string}).text).join("")}] : content;
    }
    return [event];
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
