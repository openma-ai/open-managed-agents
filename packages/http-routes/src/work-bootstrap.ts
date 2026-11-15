import { Hono } from "hono";
type WorkFinalizationClaim={workspaceId:string;environmentId:string;sessionId:string;workId:string;generation:number;holder:string};
// Structural boundary, like work-finalization.ts: HTTP depends on the injected
// application, not on a new workspace/package dependency.
type WorkBootstrapResult={type:string};
/** Exact private read: no request-selected root or claim, no public-key fallback. */
export function buildWorkBootstrapRoutes(dependencies:{
 authenticate(token:string,method:string,path:string):Promise<WorkFinalizationClaim|null>;
 applicationFor(claim:WorkFinalizationClaim):Promise<{read(claim:WorkFinalizationClaim):Promise<WorkBootstrapResult>}>;
}){
 const routes=new Hono();
 routes.post("/:sessionId/work-bootstrap",async c=>{
  try{
   const token=/^Bearer (\S+)$/i.exec(c.req.header("authorization")??"")?.[1];
   if(!token)return c.json({error:"Work credential required"},401);
   const sessionId=c.req.param("sessionId");
   const path=`/v1/oma/sessions/${encodeURIComponent(sessionId)}/work-bootstrap`;
   const claim=await dependencies.authenticate(token,"POST",path);
   if(!claim||claim.sessionId!==sessionId||!claim.holder)return c.json({error:"Work credential required"},401);
   let body:unknown;try{body=await c.req.json();}catch{return c.json({error:"Invalid JSON"},400);}
   if(new URL(c.req.url).search||body===null||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length)return c.json({error:"Bootstrap accepts only an empty object"},400);
   const result=await (await dependencies.applicationFor(claim)).read(claim);
   return c.json(result,result.type==="gap"||result.type==="rejected"?409:200);
  }catch{return c.json({type:"unavailable",phase:"bootstrap"},503);}
 });
 return routes;
}
