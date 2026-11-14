import {writeFileSync} from 'node:fs';
import {serve} from '@hono/node-server';
import {loadNodeConfig} from '../../src/config';
import {nodeDefaults} from '../../src/components';
import {createNodeControlPlane} from '../../src/control-plane';
import {SqlEnvironmentWorkStore} from '../../../../packages/environment-work-store-sql/src/index';
import {SqlWorkFinalization} from '../../../../packages/managed-agents-adapters-sql/src/work-finalization';
import {WorkFinalizationApplication} from '../../../../packages/managed-agents-application/src/work-finalization/application';
import {buildWorkFinalizationRoutes} from '../../../../packages/http-routes/src/work-finalization';
import {authenticateWorkFinalizationBearer} from '../../../../packages/managed-agents-adapters-runtime/src/environment-work-session-token';
let cp:any,server:any;
process.on('message',async(input:any)=>{
 if(input.type==='stop'){if(server)await new Promise<void>(r=>server.close(()=>r()));if(cp)await cp.stop('test');process.disconnect();return;}
 if(input.type!=='start')return;
 try{
  const components=await nodeDefaults(loadNodeConfig(input.env));cp=await createNodeControlPlane(components);
  const sql=components.database.sql;
  for(const method of ['batch','batchChecked'] as const){
    const original=sql[method]?.bind(sql);if(!original)continue;
    (sql as any)[method]=async(...args:any[])=>{try{if(method==='batchChecked'){const validate=args[1];args[1]=(rows:any[])=>{try{return validate(rows);}catch(error){process.send?.({type:'database-error',path:'fixture/database-validation',operation:method,changes:rows.map(r=>r.meta.changes)});throw error;}};}return await (original as any)(...args);}catch(error:any){process.send?.({type:'database-error',path:'fixture/database-error',operation:method,code:error.code,message:error.message});throw error;}};
  }
  // Isolated fixture only: terminate this host inside the real SQLite
  // publication transaction after receipt binding, before event insertion.
  if(input.crashPublication){
   (sql as any).db.function('fixture_crash_publication',()=>{writeFileSync(input.crashPublication,'receipt update reached');process.kill(process.pid,'SIGKILL');});
   await sql.prepare("CREATE TRIGGER fixture_crash_publication AFTER UPDATE ON managed_custom_invocations WHEN json_extract(NEW.document,'$.state')='pending' BEGIN SELECT fixture_crash_publication(); END").run();
  }else if(components.database.dialect==='sqlite') await sql.prepare('DROP TRIGGER IF EXISTS fixture_crash_publication').run();
  const cipher=components.secrets!.cipherFor('managed.environment-work.secret');
  const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
  const routes=buildWorkFinalizationRoutes({authenticate:(token,method,path)=>authenticateWorkFinalizationBearer({token,method,path,crypto:components.secrets!.cipherFor('managed.environment-work.session-token'),now:()=>new Date(),find:claim=>store.find({workspaceId:claim.workspaceId,environmentId:claim.environmentId,workId:claim.workId})}),applicationFor:async()=>new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql,{dialect:components.database.dialect}),host:{async prepare(scope){if(!await scope.isCurrent())throw Error('Stale physical fixture');return {type:'prepared'};},async publish(scope){if(!await scope.isCurrent())throw Error('Stale physical fixture');return {type:'published'};}}})});
  let dropCall=input.dropCallOnce===true;
  server=serve({hostname:'127.0.0.1',port:input.port??0,fetch:async(request:Request)=>{
   const url=new URL(request.url),path=url.pathname;let body:any;
   if(path.endsWith('/runtime-events')||path.endsWith('/mcp'))try{body=await request.clone().json();}catch{}
   let response:Response;
   if(path.includes('/work-')){url.pathname=path.replace('/v1/oma/sessions','');response=await routes.fetch(new Request(url,request));}
   else response=await cp.fetch(request);
   if(input.crashPublicationAck&&body?.customInvocations?.length&&response.ok){
    writeFileSync(input.crashPublicationAck,'canonical commit reached; response not sent');
    process.kill(process.pid,'SIGKILL');
   }
   if(dropCall&&body?.method==='tools/call'&&response.ok){dropCall=false;response=new Response('controlled transport failure after Core commit',{status:503});process.send?.({type:'observation',path,status:503,faultAfterCommit:true});}
   process.send?.({type:'observation',path,status:response.status,...(body?.events?{events:body.events}:{}),...(path.endsWith('/mcp')?{mcpMethod:body?.method}:{}),...(path.includes('/work-')?{body:await response.clone().json()}:{})});
   return response;
  }});
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  process.send?.({type:'ready',pid:process.pid,port:server.address().port});
 }catch(e){process.send?.({type:'failed',message:String(e)});}
});
