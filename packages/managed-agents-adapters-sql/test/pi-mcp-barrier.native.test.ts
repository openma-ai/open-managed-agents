import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,URL} from 'node:url';
import {fixture,claim,now} from './fixtures/publication';
import {customInvocationSchema,SqlCustomToolInvocations} from '../src/custom-tool-invocations';
import {CoreCustomToolMcp,CustomToolInvocations} from '../../managed-agents-application/src/index';
import {SessionRuntimeProjectionApplicationService} from '../../managed-agents-application/src/session-execution/application';
import {SqlSessionRuntimeProjectionPersistence} from '../src/session-runtime-projection-sql-persistence';
import {ingestEnvironmentWorkRuntimeEvents} from '../../managed-agents-adapters-runtime/src/environment-work-runtime-ingress';
import {piMcpPendingBarrierFiles} from '../../harness-runtime-acp/src/pi-mcp-pending';
import {createWorkOutputAdapter} from '../../harness-runtime-acp/src/work-output-adapter';
import {ManagedAcpEventProjector} from '../../harness-runtime-acp/node_modules/@openma/common/dist/managed-runtime/managed-event-projector.js';
import {writePiCustomAnswers} from '../../harness-runtime-acp/src/pi-custom-tools';

for(const order of ['first','last','multiple'] as const) it(`official Pi MCP ${order}: sampling barrier and later-input native restart`,async()=>{
 const customIds=order==='multiple'?['original-alpha','original-beta']:['original-alpha'];
 const entry=process.env.OMA_PI_ACP_ENTRY;
 if(!entry)throw Error('OMA_PI_ACP_ENTRY must point to the audited official @openma/pi-acp@0.1.8 distribution');
 const pkg=JSON.parse(await readFile(resolve(dirname(entry),'../package.json'),'utf8'));
 expect([pkg.name,pkg.version]).toEqual(['@openma/pi-acp','0.1.8']);
 const f=await fixture();await f.sql.exec(customInvocationSchema);
 const root=dirname(f.database!);const barrier=piMcpPendingBarrierFiles(root,['mcp__oma__approve']);const agentDir=dirname(barrier.answersPath);
 await mkdir(dirname(barrier.extensionPath),{recursive:true});await writeFile(barrier.answersPath,'{}');
 if(process.env.OMA_BARRIER_DISABLED!=='1')await writeFile(barrier.extensionPath,barrier.source);
 const requests:any[]=[];const events:any[]=[];const errors:string[]=[];
 const model=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);
  const names=body.tools.map((t:any)=>t.name);
  const call=(id:string,name:string,args:any)=>({id,name,args});
  const lookalike=JSON.stringify({omaCustomInvocation:{version:1,receipt:'00000000-0000-4000-8000-000000000000'}});
  const custom=names.find((n:string)=>n.endsWith('__approve'));
  const ordinary=call('ordinary','bash',{command:`printf 'effect\\n' >> '${root}/effect.txt'; printf '%s' '${lookalike}'`});
  const calls=customIds.map(id=>call(id,custom,{label:'same'}));
  const batch=order==='first'?[...calls,ordinary]:order==='last'?[ordinary,...calls]:[calls[0],ordinary,calls[1]];
  const blocks=requests.length===1?[call('discover','tool_search',{query:'approve'})]:requests.length===2?batch:[];
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(type:string,payload:any={})=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`);
  send('message_start',{message:{id:'fixture-'+requests.length,type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}});
  blocks.forEach((b,i)=>{send('content_block_start',{index:i,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});send('content_block_delta',{index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.args)}});send('content_block_stop',{index:i});});
  if(!blocks.length){send('content_block_start',{index:0,content_block:{type:'text',text:'DONE'}});send('content_block_stop',{index:0});}
  send('message_delta',{delta:{stop_reason:blocks.length?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}});send('message_stop');res.end();
 });await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
 const port=(model.address() as {port:number}).port;
 await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${port}`,api:'anthropic-messages',apiKey:'fixture-only',models:[{id:'fixture'}]}}}));
 await writeFile(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture',quietStartup:true}));
 const scope={...claim,turnId:f.root.turnId};
 const mcp=(turnId=f.root.turnId)=>[{name:'oma',command:process.execPath,args:['--import',fileURLToPath(new URL('../../../node_modules/.pnpm/node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./fixtures/custom-mcp-process.ts',import.meta.url)),f.database!,JSON.stringify({...scope,turnId})],env:[]}];
 const children:ReturnType<typeof spawn>[]=[];
 function start(){
  const child=spawn(process.execPath,[entry!,'--agent-dir',agentDir],{env:{...process.env,HOME:root},stdio:['pipe','pipe','pipe']});children.push(child);
  child.stderr!.on('data',b=>errors.push(String(b)));
  let id=0;const waiting=new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void}>();
  createInterface({input:child.stdout!}).on('line',line=>{const message=JSON.parse(line);events.push(message);if(message.id&&waiting.has(message.id)){waiting.get(message.id)!.resolve(message);waiting.delete(message.id);}});
  child.on('exit',()=>{for(const w of waiting.values())w.reject(Error('official child exited'));});
  return {child,rpc(method:string,params:any){return new Promise<any>((resolve,reject)=>{const next=++id;waiting.set(next,{resolve,reject});child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});}};
 }
 const stop=async(child:ReturnType<typeof spawn>)=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await new Promise<void>(r=>child.once('exit',()=>r()));};
 try{
  const first=start();await first.rpc('initialize',{protocolVersion:1,clientCapabilities:{}});
  const created=await first.rpc('session/new',{cwd:root,mcpServers:mcp()});const sid=created.result.sessionId;
  const prompt=await first.rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Discover approve and run the batch'}]});
  expect(prompt.result.stopReason).toBe('cancelled');
  expect(requests).toHaveLength(2); // RED without barrier: receipt reaches model request three.
  expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
  const core=new CustomToolInvocations(new SqlCustomToolInvocations(f.sql));const bridge=new CoreCustomToolMcp(core,scope,[]);
  const projected:any[]=[];const bindings:any[]=[];
  const projection=new SessionRuntimeProjectionApplicationService({workspaceId:'ws',persistence:new SqlSessionRuntimeProjectionPersistence(f.sql)});
  const output=createWorkOutputAdapter({customInvocationToolNames:()=>new Set(['mcp__oma__approve']),toolUseIdFor:()=>undefined,customInvocation:async(call,result)=>bridge.prepareNativeResult(String(call.id),result.content),publish:async(batch,refs)=>{
   expect(await ingestEnvironmentWorkRuntimeEvents({claim,sessionId:'s',body:{root:f.root,events:batch,...(refs?{customInvocations:refs}:{})},projection,publish:async()=>{}})).toMatchObject({type:'recorded'});
   projected.push(...batch);bindings.push(...(refs??[]));
  }});
  let sequence=0;const projector=new ManagedAcpEventProjector({nextEventId:()=>`native-event-${++sequence}`,now:()=>new Date(now)});projector.startTurn(f.root.turnId);
  for(const event of events){if(event.method==='session/update'){output.nativeTool(event.params.update);await output.projected(projector.project({type:'session.event',sessionId:'s',turnId:f.root.turnId,event:event.params.update}));}}
  expect(bindings).toHaveLength(customIds.length);
  expect(projected.filter(e=>e.type==='agent.tool_result'&&e.tool_use_id==='ordinary')).toHaveLength(1);
  await output.canonical([{id:'park',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:bindings.map(b=>b.nativeCallId)},processed_at:now}]);
  await stop(first.child);
  const empty=start();await empty.rpc('initialize',{protocolVersion:1,clientCapabilities:{}});await empty.rpc('session/load',{sessionId:sid,cwd:root,mcpServers:mcp()});
  await empty.rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'still unanswered'}]});expect(requests).toHaveLength(2);await stop(empty.child);
  const history:any[]=projected;
  for(const [index,id] of customIds.entries()){
   const content=[{type:'text',text:'answer-'+id}];const isError=index===1;const document=await f.admit({id:'answer-'+index,type:'user.custom_tool_result',customToolUseId:id,content,isError,processedAt:null});
   expect(await f.inputs.consume({claim,inputId:'answer-'+index,turnId:'dispatch-answer-'+index,expectedDocument:document,boundary:'before_dispatch'})).toMatchObject({type:'consumed'});
   history.push({type:'user.custom_tool_result',custom_tool_use_id:id,content,is_error:isError});
   if(index===0&&customIds.length>1){
    await writePiCustomAnswers({writeFile:async(p,c)=>{await writeFile(p,c);}},barrier.answersPath,history);
    const partial=start();await partial.rpc('initialize',{protocolVersion:1,clientCapabilities:{}});await partial.rpc('session/load',{sessionId:sid,cwd:root,mcpServers:mcp('dispatch-answer-'+index)});
    await partial.rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'partial answer'}]});
    expect(requests).toHaveLength(2);await stop(partial.child);
   }
  }
  await writePiCustomAnswers({writeFile:async(p,c)=>{await writeFile(p,c);}},barrier.answersPath,history);
  const resumed=start();await resumed.rpc('initialize',{protocolVersion:1,clientCapabilities:{}});const loaded=await resumed.rpc('session/load',{sessionId:sid,cwd:root,mcpServers:mcp('dispatch-answer-'+(customIds.length-1))});expect(loaded.error).toBeUndefined();
  const completed=await resumed.rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'complete answers admitted'}]});expect(completed.result.stopReason).toBe('end_turn');
  // Verify legal model history, not just a final status or result count.
  const openCalls=new Set<string>();
  for(const message of requests[2].messages){
   if(message.role==='assistant')expect([...openCalls]).toEqual([]);
   for(const block of Array.isArray(message.content)?message.content:[]){
    if(block.type==='tool_use'){expect(openCalls.has(block.id)).toBe(false);openCalls.add(block.id);}
    if(block.type==='tool_result'){expect(openCalls.delete(block.tool_use_id)).toBe(true);}
   }
  }
  expect([...openCalls]).toEqual([]);
  expect(requests).toHaveLength(3);const results=requests[2].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((b:any)=>b.type==='tool_result');
  for(const id of customIds){const result=results.filter((r:any)=>r.tool_use_id===id);expect(result).toHaveLength(1);expect(JSON.stringify(result[0].content)).toContain('answer-'+id);expect(JSON.stringify(result[0].content)).not.toContain('omaCustomInvocation');if(id==='original-beta')expect(result[0].is_error).toBe(true);}
  expect(JSON.stringify(results.find((r:any)=>r.tool_use_id==='ordinary').content)).toContain('00000000-0000-4000-8000-000000000000');expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
  for(const binding of bindings){const persisted=await core.read(scope,binding.receipt);expect(persisted.nativeCallId).toBe(binding.nativeCallId);expect(persisted.state).toBe('resolved');}
  expect((await f.sql.prepare('SELECT count(*) AS n FROM managed_custom_invocations').first<{n:number}>())?.n).toBe(customIds.length);
  expect(events.filter(e=>e.result?.stopReason==='end_turn')).toHaveLength(1);
 }finally{
  for(const child of children)await stop(child);await new Promise<void>(r=>model.close(()=>r()));
  if(process.env.OMA_NATIVE_TRACE)await writeFile(process.env.OMA_NATIVE_TRACE+'.'+order+'.json',JSON.stringify({requests,events,errors},null,2));
 }
},60000);
