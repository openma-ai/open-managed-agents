import { Hono } from "hono";
import { log, logError } from "@open-managed-agents/shared/log";

type Claim={workspaceId:string;sessionId:string;environmentId:string;workId:string;generation:number;holder:string};
type Result={type:string;[key:string]:unknown};
/** Private handler mounted by the Node and CF composition roots. Authenticate a sealed Work token
 * for the exact method/path and resolve holder from trusted claim state. Ordinary
 * Session/API credentials and caller-supplied scope are not sufficient. SQL
 * repeats all ownership checks inside the consumption transaction.
 * The structural port keeps HTTP independent of the concrete SQL adapter. */
export function buildWorkInputRoutes(dependencies:{
 authenticate(token:string,method:string,path:string):Promise<Claim|null>;
 applicationFor(claim:Claim):Promise<{
  read(input:{claim:Claim;cursor:string|null;limit:number}):Promise<Result>;
  consume(input:{claim:Claim;inputId:string;turnId:string;expectedDocument:string;consumingTurnId?:string;rootInputId?:string;expectedRootDocument?:string;boundary:"before_dispatch"|"after_acceptance"|"acceptance_unknown"}):Promise<Result>;
 }>;
}) {
 const routes=new Hono();
 for(const action of ["inputs-read","inputs-consume"] as const)routes.post("/:sessionId/"+action,async c=>{
  const startedAt=Date.now();
  const sessionId=c.req.param("sessionId") ?? "";
  const context={op:"work.inputs.http",action,session_id:sessionId};
  log({...context,status:"started"},"Work inputs HTTP request");
  const respond=(body:unknown,status:number)=>{log({...context,status,duration_ms:Date.now()-startedAt},"Work inputs HTTP response");return c.json(body,status as never);};
  try {
   const token=/^Bearer (\S+)$/i.exec(c.req.header("authorization")??"")?.[1];
   if(!token)return respond({error:"Work credential required"},401);
   const claim=await dependencies.authenticate(token,"POST","/v1/oma/sessions/"+encodeURIComponent(sessionId)+"/"+action);
   if(!claim||claim.sessionId!==sessionId||!claim.holder)return respond({error:"Work credential required"},401);
   let body:unknown;try{body=await c.req.json();}catch{return respond({error:"Invalid JSON"},400);}
   if(!body||typeof body!=="object"||Array.isArray(body))return respond({error:"Invalid input"},400);
   const value=body as Record<string,unknown>;
   let result:Result;
   if(action==="inputs-read") {
    if(Object.keys(value).some(k=>k!=="cursor"&&k!=="limit")||(value.cursor!==null&&typeof value.cursor!=="string")||!Number.isSafeInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>200)return respond({error:"Invalid page"},400);
    result=await (await dependencies.applicationFor(claim)).read({claim,cursor:value.cursor as string|null,limit:Number(value.limit)});
   }else {
    if(Object.keys(value).some(k=>!["inputId","turnId","expectedDocument","boundary","consumingTurnId","rootInputId","expectedRootDocument"].includes(k))||
      ["inputId","turnId","expectedDocument"].some(k=>typeof value[k]!=="string"||value[k]==="")||
      ["consumingTurnId","rootInputId","expectedRootDocument"].some(k=>value[k]!==undefined&&(typeof value[k]!=="string"||value[k]===""))||
      (value.consumingTurnId!==undefined&&value.consumingTurnId!==value.turnId&&(!value.rootInputId||!value.expectedRootDocument))||
      ((value.consumingTurnId===undefined||value.consumingTurnId===value.turnId)&&(value.rootInputId!==undefined||value.expectedRootDocument!==undefined))||
      !["before_dispatch","after_acceptance","acceptance_unknown"].includes(String(value.boundary)))return respond({error:"Invalid consumption"},400);
    result=await (await dependencies.applicationFor(claim)).consume({claim,inputId:value.inputId as string,turnId:value.turnId as string,expectedDocument:value.expectedDocument as string,
      ...(value.consumingTurnId!==undefined?{consumingTurnId:value.consumingTurnId as string}:{}),
      ...(value.rootInputId!==undefined?{rootInputId:value.rootInputId as string,expectedRootDocument:value.expectedRootDocument as string}:{}),boundary:value.boundary as "before_dispatch"|"after_acceptance"|"acceptance_unknown"});
   }
   return respond(result,result.type==="invalid"?400:result.type==="page"||result.type==="consumed"?200:409);
  }catch(error){logError({...context,status:503,duration_ms:Date.now()-startedAt,err:error},"Work inputs HTTP handler failed");return respond({error:"Work inputs unavailable"},503);}
 });
 return routes;
}
