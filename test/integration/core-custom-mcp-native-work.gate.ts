import workInputsMigration from '../../apps/main/migrations/0031_work_inputs.sql?raw';
import {env,exports} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import main from '../../apps/main/src/index';
import {CfD1SqlClient} from '@open-managed-agents/sql-client/adapters/cf-d1';
import {issueSandboxToken} from '../../packages/sandbox-gateway/src/index';
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from '../../packages/sandbox-gateway-sql/src/index';
it('official Pi Work process publishes and cancels Core MCP through CF host',async()=>{
 await exports.default.fetch(new Request('http://localhost/health'));
 // This legacy broad test worker omits0031; apply the exact production migration.
 for(const statement of workInputsMigration.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await env.MAIN_DB.prepare(statement).run();
 const configured={...env,API_KEY:'test-key',PLATFORM_ROOT_SECRET:'test-platform-root-secret-padded-to-thirtytwo'};
 const transport:typeof fetch=(raw,init)=>main.fetch(new Request(raw,init),configured as never,{waitUntil(){},passThroughOnException(){}} as never);
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
 let cancelled=false,observed:any;const deadline=Date.now()+25000;
 while(Date.now()<deadline){
  observed=await (await fetch(bridge+'/__fixture/next')).json() as any;
  if(observed.error)throw Error(observed.error);
  for(const request of observed.queue){
   const response=await transport('https://control.test'+request.path,{method:request.method,headers:request.headers,...(request.method==='GET'?{}:{body:request.body})});
   await fetch(bridge+'/__fixture/reply',{method:'POST',body:JSON.stringify({id:request.id,status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})});
  }
  const row=await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=? AND native_call_id=?').bind(session.id,'cf-official-custom').first<{document:string}>();
  if(row&&!cancelled){
   expect(JSON.parse(row.document).state).toBe('pending');
   const response=await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]});expect(response.status,await response.clone().text()).toBeLessThan(300);cancelled=true;
  }
  if(cancelled){
   const receipt=JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=? AND native_call_id=?').bind(session.id,'cf-official-custom').first<{document:string}>())!.document);
   expect(receipt.state).toBe('cancelled');
   const results=(await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=? AND type='agent.tool_result'").bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
   expect(results.filter(e=>e.toolUseId==='cf-official-custom'&&e.isError)).toHaveLength(1);
   expect(observed.requests).toHaveLength(2);
   console.info(JSON.stringify({gate:'cf-official-native-cancel',sessionId:session.id,workId:work.id,receipt:receipt.receipt,officialHarnessProcess:true,hostedAcquisition:false}));return;
  }
  await new Promise(r=>setTimeout(r,20));
 }
 throw Error('Official CF native publication did not arrive: '+JSON.stringify(observed?.observations));
},40000);
