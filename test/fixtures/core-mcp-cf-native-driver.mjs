// Explicit opt-in driver: real official Pi/Work subprocess, in-memory HTTP
// forwarding to Workerd. No credential/body logging and no provider calls.
import {createServer} from 'node:http';
import {fork,spawn,execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
const entry=process.env.OMA_PI_ACP_ENTRY;
if(!entry)throw Error('Official Pi entry required');
const pkg=JSON.parse(await readFile(resolve(dirname(entry),'../package.json'),'utf8'));
if(pkg.name!=='@openma/pi-acp'||pkg.version!=='0.1.8')throw Error('Official Pi 0.1.8 required');
const root=await mkdtemp(join(tmpdir(),'oma-cf-mcp-'));
const recovery=process.env.OMA_CF_RECOVERY==='1';
const execute=promisify(execFile);
const physical=[];
const pending=new Map(),queue=[],requests=[],observations=[];let sequence=0,child,error;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;let raw='';for await(const c of req)raw+=c;
 const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(path==='/__fixture/start'){
  const input=JSON.parse(raw);error=undefined;
  await mkdir(join(root,'outputs'),{recursive:true});
  child=fork(resolve('apps/main-node/test/fixtures/core-mcp-work-child.ts'),[],{execArgv:['--import',resolve('node_modules/.pnpm/node_modules/tsx/dist/loader.mjs')],stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',()=>{});
  child.on('message',m=>{if(m.type==='failed')error=m.message;});
  child.on('exit',()=>observations.push({event:'child-exit',pid:child.pid}));
  child.send({type:'start',...input,root,base:origin,modelBase:origin+'/model',entry,fixtureToken:input.sandboxToken});
  observations.push({event:'child-start',pid:child.pid});return json({started:true,pid:child.pid});
 }
 if(path==='/__fixture/stop'){if(child?.connected)child.send({type:'stop'});return json({stopping:true});}
 if(path==='/__fixture/identity'){
  if(!child||child.exitCode!==null)throw Error('No live Work process');
  const stat=await readFile(`/proc/${child.pid}/stat`,'utf8');
  return json({pid:child.pid,startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]});
 }
 if(path==='/__fixture/io'){
  const input=JSON.parse(raw);
  const mapped=p=>p.replaceAll('/mnt/session/outputs',join(root,'outputs')).replaceAll('/workspace',root);
  if(input.type==='run'){
   try{const r=await execute('bash',['-c',mapped(input.command)],{cwd:root,maxBuffer:8*1024*1024});return json({exitCode:0,stdout:r.stdout,stderr:r.stderr});}
   catch(e){return json({exitCode:e.code??1,stdout:e.stdout??'',stderr:e.stderr??String(e)});}
  }
  if(input.type==='read')return json({base64:(await readFile(mapped(input.path))).toString('base64')});
  if(input.type==='checkpoint'){
   const archive=join(root,'../'+root.split('/').at(-1)+'.tar');
   await execute('tar',['-cf',archive,'-C',root,'.']);
   const bytes=await readFile(archive);await rm(archive);
   const result={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};physical.push(result);return json(result);
  }
  throw Error('Unsupported fixture IO');
 }
 if(path==='/__fixture/evidence'){physical.push(JSON.parse(raw));return json({ok:true});}
 if(path==='/__fixture/next')return json({queue:queue.splice(0),requests,error,observations,exited:child?.exitCode!==null});
 if(path==='/__fixture/reply'){
  const value=JSON.parse(raw),response=pending.get(value.id);if(!response)throw Error('Unknown forward request');
  pending.delete(value.id);observations.push({path:response.path,status:value.status});response.res.writeHead(value.status,value.headers);response.res.end(value.body);return json({ok:true});
 }
 if(path.startsWith('/model/')||path.startsWith('/v1/oma/inference-proxy/')){
  const body=JSON.parse(raw);requests.push(body);const names=body.tools.map(t=>t.name);
  const custom=names.find(n=>n==='mcp__oma_custom__approve');
  if(requests.length===2&&!custom){res.writeHead(400);return res.end('Core MCP approve missing');}
  const calls=requests.length===1?[{id:'discover',name:'tool_search',input:{query:'approve'}}]:requests.length===2?[{id:'cf-official-custom',name:custom,input:{}},{id:'ordinary',name:'bash',input:{command:'sleep 10'}}]:recovery&&requests.length===3?[{id:'cf-recovery-action',name:'bash',input:{command:`printf recovered > ${root}/outputs/recovered.txt`}}]:[];
  res.writeHead(200,{'content-type':'text/event-stream'});const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  send('message_start',{message:{id:'fixture-'+requests.length,type:'message',role:'assistant',model:'test',content:[],usage:{input_tokens:1,output_tokens:0}}});
  calls.forEach((c,index)=>{send('content_block_start',{index,content_block:{type:'tool_use',id:c.id,name:c.name,input:{}}});send('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(c.input)}});send('content_block_stop',{index});});
  if(!calls.length){send('content_block_start',{index:0,content_block:{type:'text',text:'DONE'}});send('content_block_stop',{index:0});}
  send('message_delta',{delta:{stop_reason:calls.length?'tool_use':'end_turn'},usage:{output_tokens:1}});send('message_stop',{});return res.end();
 }
 const id=++sequence;pending.set(id,{res,path});queue.push({id,path:req.url,method:req.method,headers:req.headers,body:raw});
}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(47891,'127.0.0.1',r));const origin='http://127.0.0.1:47891';
const test=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config',recovery?'vitest.mcp-recovery.config.ts':'vitest.mcp-native.config.ts',...(process.env.OMA_CF_TEST_NAME?['-t',process.env.OMA_CF_TEST_NAME]:[])],{stdio:'inherit',env:process.env});
const code=await new Promise(r=>test.once('exit',r));
if(child&&child.exitCode===null){child.send({type:'stop'});await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGTERM');}
for(const {res} of pending.values()){res.writeHead(503);res.end();}server.closeAllConnections();await new Promise(r=>server.close(r));
if(process.env.OMA_CF_NATIVE_TRACE)await writeFile(process.env.OMA_CF_NATIVE_TRACE,JSON.stringify({requests,observations,physical,error,officialPackage:{name:pkg.name,version:pkg.version},exitCode:code},null,2));
await rm(root,{recursive:true,force:true});process.exitCode=code??1;
