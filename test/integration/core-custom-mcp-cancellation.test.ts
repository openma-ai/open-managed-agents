import workInputsMigration from '../../apps/main/migrations/0031_work_inputs.sql?raw';
import {env,exports} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import main from '../../apps/main/src/index';
import {CfD1SqlClient} from '@open-managed-agents/sql-client/adapters/cf-d1';
import {issueSandboxToken} from '../../packages/sandbox-gateway/src/index';
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from '../../packages/sandbox-gateway-sql/src/index';
it('CF production Work publication and canonical cancellation share durable D1 receipt state',async()=>{
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
 const path='/v1/oma/sessions/'+session.id;
 const read=await post(path+'/inputs-read',{cursor:null,limit:2},token);expect(read.status,await read.clone().text()).toBe(200);const page=await read.json() as any;const row=page.rows[0];
 expect((await post(path+'/inputs-consume',{inputId:row.event.id,turnId:row.event.id,expectedDocument:row.document,boundary:'before_dispatch'},token)).status).toBe(200);
 const sql=new CfD1SqlClient(env.MAIN_DB);
 const root=(await sql.prepare('SELECT document FROM managed_session_initial_events WHERE session_id=? AND sequence=0').bind(session.id).first<{document:string}>())!.document;
 const claim=(await sql.prepare('SELECT claim_generation FROM managed_environment_work WHERE id=?').bind(work.id).first<{claim_generation:number}>())!;
 const sandbox=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({workspaceId:'default',environmentId:environment.id,sessionId:session.id,workId:work.id,generation:Number(claim.claim_generation)}),{scope:'all'});
 const response=await transport('https://control.test'+path+'/custom-tools/'+encodeURIComponent(row.event.id)+'/mcp',{method:'POST',headers:{authorization:'Bearer '+sandbox,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'approve',arguments:{}}})});
 expect(response.status).toBe(200);const receipt=(await response.json() as any).result.structuredContent.omaCustomInvocation.receipt;
 const publish=await post(path+'/runtime-events',{root:{inputId:row.event.id,turnId:row.event.id,expectedDocument:root},customInvocations:[{receipt,nativeCallId:'cf-native-call'}],events:[{id:'cf-native-call',type:'agent.custom_tool_use',name:'approve',input:{},processed_at:new Date().toISOString()}]},token);expect(publish.status,await publish.clone().text()).toBe(200);
 const cancelled=await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]});expect(cancelled.status,await cancelled.clone().text()).toBeLessThan(300);
 const value=JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(receipt).first<{document:string}>())!.document);expect(value).toMatchObject({state:'cancelled',nativeCallId:'cf-native-call'});
 console.info(JSON.stringify({gate:'cf-canonical-cancel',sessionId:session.id,workId:work.id,receipt,state:value.state,officialHarnessProcess:false}));
},30000);
