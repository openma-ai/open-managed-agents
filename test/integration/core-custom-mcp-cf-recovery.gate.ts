import workInputsMigration from '../../apps/main/migrations/0031_work_inputs.sql?raw';
import {env,exports} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import main from '../../apps/main/src/index';
import {CfD1SqlClient} from '@open-managed-agents/sql-client/adapters/cf-d1';
import {issueSandboxToken} from '../../packages/sandbox-gateway/src/index';
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from '../../packages/sandbox-gateway-sql/src/index';
import {cfWorkFinalizationRoutes} from '../../apps/main/src/lib/cf-work-finalization';
import {synchronizeNativeWorkStorage,publishNativeWorkArtifacts} from '../../apps/main/src/lib/cf-native-work-storage';
import {SqlSessionSource} from '../../packages/managed-agents-adapters-sql/src/session-sql-source';
import {sessionOutputsPrefix} from '@open-managed-agents/shared';
it.each(['cancel','answer'])('official Pi resumes CF %s and physically syncs recovery output before normal completion',async(mode)=>{
 await exports.default.fetch(new Request('http://localhost/health'));
 // This legacy broad test worker omits0031; apply the exact production migration.
 for(const statement of workInputsMigration.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await env.MAIN_DB.prepare(statement).run();
 const configured={...env,API_KEY:'test-key',PLATFORM_ROOT_SECRET:'test-platform-root-secret-padded-to-thirtytwo'};
 let finalization:any;
 const transport:typeof fetch=async(raw,init)=>{const request=new Request(raw,init),url=new URL(request.url);if(finalization&&url.pathname.includes('/work-')){url.pathname=url.pathname.replace('/v1/oma/sessions','');return finalization.fetch(new Request(url,request));}return main.fetch(request,configured as never,{waitUntil(){},passThroughOnException(){}} as never);};
 const post=async(path:string,body:unknown,bearer?:string)=>transport('https://control.test'+path,{method:'POST',headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+bearer}:{'x-api-key':'test-key'})},body:JSON.stringify(body)});
 const create=async(path:string,body:unknown)=>{const r=await post(path,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;};
 const agent=await create('/v1/agents',{name:'cf-mcp-cancel',model:'unused',tools:[{type:'custom',name:'approve',description:'Approval',input_schema:{type:'object',properties:{}}}],_oma:{harness:'acp-sandbox',acp:{agent:{command:'/usr/local/bin/openma-pi-acp'}}}});
 const environment=await create('/v1/environments',{name:'cf-mcp-cancel',config:{type:'cloud'}});
 const session=await create('/v1/sessions',{agent:agent.id,environment_id:environment.id,initial_events:[{type:'user.message',content:[{type:'text',text:'start'}]}]});
 const standing=await create('/v1/oma/api_keys',{name:'cf-mcp-worker',environment_id:environment.id});
 const client=new Anthropic({apiKey:null,authToken:standing.key,baseURL:'https://control.test',maxRetries:0,fetch:transport});
 const work=(await client.beta.environments.work.poll(environment.id,{}))!;expect(work).toBeTruthy();
 const secret=JSON.parse(atob(work.secret!));const token=secret.sessions_token;
 // Public CMA polling does not assign an internal holder. This control-plane
 // gate supplies the isolated managed dispatcher holder, not a harness claim.
 const polled=await env.MAIN_DB.prepare('SELECT claim_worker_id FROM managed_environment_work WHERE id=?').bind(work.id).first<{claim_worker_id:string|null}>();expect(polled!.claim_worker_id).toBeNull();
 await env.MAIN_DB.prepare('UPDATE managed_environment_work SET claim_worker_id=? WHERE id=? AND claim_worker_id IS NULL').bind('cf-local-fixture',work.id).run();
 const owner=client.withOptions({apiKey:null,authToken:token});await owner.beta.environments.work.ack(work.id,{environment_id:environment.id});
 const sql=new CfD1SqlClient(env.MAIN_DB);
 const claim=(await sql.prepare('SELECT claim_generation FROM managed_environment_work WHERE id=?').bind(work.id).first<{claim_generation:number}>())!;
 const scope={workspaceId:'default',environmentId:environment.id,sessionId:session.id,workId:work.id};
 const sandboxToken=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({...scope,generation:Number(claim.claim_generation)}),{scope:'all'});
 const bridge='http://127.0.0.1:47891';
 await fetch(bridge+'/__fixture/start',{method:'POST',body:JSON.stringify({scope,token,sandboxToken,generation:Number(claim.claim_generation),holder:'cf-local-fixture'})});

 const rpc=async(path:string,body:unknown)=>{const r=await fetch(bridge+path,{method:'POST',body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBe(200);return r.json() as Promise<any>;};
 const phases:any[]=[];
 const runtime={run:(command:string)=>rpc('/__fixture/io',{type:'run',command}),readBytes:async(path:string)=>Uint8Array.from(atob((await rpc('/__fixture/io',{type:'read',path})).base64),c=>c.charCodeAt(0)),readFile:async(path:string)=>new TextDecoder().decode(await runtime.readBytes(path)),writeFileBytes:async()=>{throw Error('Unexpected finalization write');}};
 // Controlled local physical port, not provider acquisition: production SQL
 // finalization/auth and native storage reconciler operate on actual child files.
 finalization=cfWorkFinalizationRoutes(configured as never,{
  async prepare(scope){
   expect(await scope.isCurrent()).toBe(true);
   const current=(await new SqlSessionSource(sql).find(scope.claim))!;
   const identity=await rpc('/__fixture/identity',{});
   await synchronizeNativeWorkStorage({env:configured as never,sql,claim:scope.claim,session:current,runtime,authorize:scope.isCurrent,
    process:{...scope.claim,id:'local-'+identity.pid,epoch:String(identity.pid),pid:identity.pid,startTicks:identity.startTicks,holderHash:'fixture-host-owned',status:'running',mounts:[]},
    fence:{...scope.claim,ownerId:scope.claim.holder,token,expiresAt:new Date(Date.now()+60000).toISOString()}});
   const archive=await rpc('/__fixture/io',{type:'checkpoint'});expect(archive.bytes).toBeGreaterThan(0);expect(await scope.isCurrent()).toBe(true);
   phases.push({phase:'prepare',workId:scope.claim.workId,turnId:scope.turnId,archive});return {type:'prepared'};
  },
  async publish(scope){
   const current=(await new SqlSessionSource(sql).find(scope.claim))!;
   await publishNativeWorkArtifacts({env:configured as never,sql,claim:scope.claim,session:current,runtime,authorize:scope.isCurrent,turnId:scope.turnId});
   expect(await scope.isCurrent()).toBe(true);phases.push({phase:'publish',workId:scope.claim.workId,turnId:scope.turnId});return {type:'published'};
  },
 });
 const pump=async()=>{
  const observed=await (await fetch(bridge+'/__fixture/next')).json() as any;
  for(const request of observed.queue){
   const response=await transport('https://control.test'+request.path,{method:request.method,headers:request.headers,...(request.method==='GET'?{}:{body:request.body})});
   await rpc('/__fixture/reply',{id:request.id,status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  }
  return observed;
 };
 const wait=async(check:(o:any)=>Promise<boolean>)=>{const end=Date.now()+25000;let last;while(Date.now()<end){last=await pump();if(await check(last))return last;await new Promise(r=>setTimeout(r,20));}throw Error('CF recovery wait exceeded '+JSON.stringify({error:last?.error,observations:last?.observations,phases}));};
 await wait(async()=>!!await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=? AND native_call_id=?').bind(session.id,'cf-official-custom').first());
 if(mode==='cancel'){
 const interrupt=await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]});expect(interrupt.status,await interrupt.clone().text()).toBeLessThan(300);
 }else{
 await wait(async()=>!!await sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle' AND document LIKE '%requires_action%'").bind(session.id).first());
 }
 const receipt=JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=? AND native_call_id=?').bind(session.id,'cf-official-custom').first<{document:string}>())!.document);expect(receipt.state).toBe(mode==='cancel'?'cancelled':'pending');
 await rpc('/__fixture/stop',{});await wait(async o=>o.exited);
 await create('/v1/sessions/'+session.id+'/events',{events:mode==='cancel'?[{type:'user.message',content:[{type:'text',text:'Continue after cancellation; write recovery output'}]}]:[{type:'user.custom_tool_result',custom_tool_use_id:'cf-official-custom',content:[{type:'text',text:'APPROVED_D1'}]}]});
 const next=mode==='answer'?work:(await client.beta.environments.work.poll(environment.id,{}))!;expect(next).toBeTruthy();if(mode==='cancel')expect(next.id).not.toBe(work.id);
 const nextToken=JSON.parse(atob(next.secret!)).sessions_token;
 await env.MAIN_DB.prepare('UPDATE managed_environment_work SET claim_worker_id=? WHERE id=? AND claim_worker_id IS NULL').bind('cf-local-fixture',next.id).run();
 if(mode==='cancel')await client.withOptions({apiKey:null,authToken:nextToken}).beta.environments.work.ack(next.id,{environment_id:environment.id});
 const nextGeneration=Number((await sql.prepare('SELECT claim_generation FROM managed_environment_work WHERE id=?').bind(next.id).first<{claim_generation:number}>())!.claim_generation);
 const nextScope={...scope,workId:next.id};const nextSandboxToken=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({...nextScope,generation:nextGeneration}),{scope:'all'});
 await rpc('/__fixture/start',{scope:nextScope,token:nextToken,sandboxToken:nextSandboxToken,generation:nextGeneration,holder:'cf-local-fixture'});
 const originalTurn=(await sql.prepare('SELECT turn_id FROM managed_custom_invocations WHERE receipt=?').bind(receipt.receipt).first<{turn_id:string}>())!.turn_id;
 const observed=await wait(async o=>o.requests.length===4&&phases.some(p=>p.phase==='publish'&&p.workId===next.id&&p.turnId!==originalTurn));
 const results=observed.requests[2].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='cf-official-custom');
 expect(results).toHaveLength(1);expect(Boolean(results[0].is_error)).toBe(mode==='cancel');expect(JSON.stringify(results[0])).toContain(mode==='cancel'?'interrupted':'APPROVED_D1');
 const objectKey=sessionOutputsPrefix('default',session.id)+'recovered.txt';
 const object=await env.FILES_BUCKET.get(objectKey);expect(object).not.toBeNull();const bytes=new Uint8Array(await object!.arrayBuffer());expect(new TextDecoder().decode(bytes)).toBe('recovered');const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const rows=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=? ORDER BY rowid').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
 expect(rows.filter(e=>e.type==='agent.tool_result'&&e.toolUseId==='cf-official-custom'&&e.isError)).toHaveLength(mode==='cancel'?1:0);
 const finalReceipt=JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(receipt.receipt).first<{document:string}>())!.document);expect(finalReceipt.state).toBe(mode==='cancel'?'cancelled':'resolved');
 expect(rows.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='end_turn')).toHaveLength(1);
 expect(rows.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='retries_exhausted')).toHaveLength(0);
 await rpc('/__fixture/evidence',{mode,finalReceipt,sessionId:session.id,workIds:[work.id,next.id],receipt,phases,canonicalEvents:rows,objectKey,objectText:'recovered',sha256,hostedAcquisition:false,physicalAdapter:'local-filesystem archive; production native storage + local R2'});
},60000);
