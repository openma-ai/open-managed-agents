import { Hono } from "hono";
import { log, logError } from "@open-managed-agents/shared/log";

type Claim={workspaceId:string;environmentId:string;sessionId:string;workId:string;generation:number;holder:string};
type Request={claim:Claim;turnId:string};
type Revision=Request & {revision:number};
type StopReason={type:"end_turn"|"budget_reached"|"retries_exhausted"|"interrupted"}|{type:"requires_action";eventIds:string[]};
type Result=object;
/** Private capability-only protocol. Host implementations are composition-root
 * dependencies, never completion receipts, scope or runtime IDs from HTTP. */
export function buildWorkFinalizationRoutes(dependencies:{
  authenticate(token:string,method:string,path:string):Promise<Claim|null>;
  applicationFor(claim:Claim):Promise<{
    recover(input:Request):Promise<Result>;
    checkpoint(input:Revision):Promise<Result>;
    finalize(input:Revision & {stopReason:StopReason}):Promise<Result>;
    publish(input:Revision & {terminalEventId:string}):Promise<Result>;
    fail(input:Revision & {phase:"run"|"finalization"}):Promise<Result>;
  }>;
}) {
  const routes=new Hono();
  for(const action of ["work-recovery","work-checkpoint","work-finalize","work-publish","work-failed"] as const)routes.post("/:sessionId/"+action,async c=>{
    const startedAt = Date.now();
    const sessionId = c.req.param("sessionId") ?? "";
    const context = { op: "work.finalization.http", action, session_id: sessionId };
    log({ ...context, status: "started" }, "Work finalization HTTP request");
    const respond=(body:unknown,status:number)=>c.json(body,status as never);
    try {
      const token=/^Bearer (\S+)$/i.exec(c.req.header("authorization")??"")?.[1];
      if(!token)return respond({error:"Work credential required"},401);
      const claim=await dependencies.authenticate(token,"POST",`/v1/oma/sessions/${encodeURIComponent(sessionId)}/${action}`);
      if(!claim || claim.sessionId!==sessionId || !claim.holder)return respond({error:"Work credential required"},401);
      let body:unknown;try{body=await c.req.json();}catch{return respond({error:"Invalid JSON"},400);}
      if(!body || typeof body!=="object" || Array.isArray(body))return respond({error:"Invalid request"},400);
      const value=body as Record<string,unknown>;
      const keys=action==="work-recovery"?["turnId"]:action==="work-finalize"?["turnId","revision","stopReason"]:action==="work-publish"?["turnId","revision","terminalEventId"]:action==="work-failed"?["turnId","revision","phase"]:["turnId","revision"];
      if(Object.keys(value).some(k=>!keys.includes(k)) || typeof value.turnId!=="string" || !value.turnId || value.turnId.length>1024 ||
        (action!=="work-recovery" && (!Number.isSafeInteger(value.revision) || Number(value.revision)<1)))return respond({error:"Invalid request"},400);
      if(action==="work-finalize" && !validStopReason(value.stopReason))return respond({error:"Invalid stop reason"},400);
      if(action==="work-publish" && (typeof value.terminalEventId!=="string" || !value.terminalEventId || value.terminalEventId.length>4096))return respond({error:"Invalid terminal"},400);
      if(action==="work-failed" && value.phase!=="run" && value.phase!=="finalization")return respond({error:"Invalid failure phase"},400);
      const app=await dependencies.applicationFor(claim);
      const input={claim,turnId:value.turnId,revision:Number(value.revision)};
      // Await canonical persistence/physical IO, never an enqueue acknowledgement.
      const result=action==="work-recovery"?await app.recover({claim,turnId:value.turnId})
        :action==="work-checkpoint"?await app.checkpoint(input)
        :action==="work-finalize"?await app.finalize({...input,stopReason:value.stopReason as StopReason})
        :action==="work-publish"?await app.publish({...input,terminalEventId:value.terminalEventId as string})
        :await app.fail({...input,phase:value.phase as "run"|"finalization"});
      const type=(result as {type?:string}).type;
      const status=type==="unavailable"?503:type==="failed"?502:type==="rejected"||type==="gap"?409:200;
      log({ ...context, status, result_type: type,
        ...((result as {reason?: unknown}).reason !== undefined ? { reason: (result as {reason?: unknown}).reason } : {}),
        duration_ms: Date.now() - startedAt }, "Work finalization HTTP response");
      return respond(result,status);
    }catch(error){
      logError({ ...context, status: 503, duration_ms: Date.now() - startedAt, err: error }, "Work finalization HTTP handler failed");
      return respond({type:"unavailable",phase:"finalization"},503);
    }
  });
  return routes;
}
function validStopReason(value:unknown):value is StopReason {
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(v.type==="requires_action")return Object.keys(v).every(k=>k==="type"||k==="eventIds") && Array.isArray(v.eventIds) && v.eventIds.length>0 && v.eventIds.every(id=>typeof id==="string"&&id.length>0);
  return Object.keys(v).length===1 && ["end_turn","budget_reached","retries_exhausted","interrupted"].includes(String(v.type));
}
