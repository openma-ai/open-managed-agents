import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const e2bSecret=process.env.E2B_API_KEY;
async function sessionSandboxes(sessionId){
 const q=new URLSearchParams({metadata:new URLSearchParams({sessionId}).toString(),state:'running,paused',limit:'100'});
 const response=await fetch('https://api.e2b.app/v2/sandboxes?'+q,{headers:{'X-API-KEY':e2bSecret}});
 if(!response.ok)throw Error('E2B list '+response.status);
 return (await response.json()).map(s=>({sandboxId:s.sandboxID??s.sandboxId,state:s.state}));
}
// Node or a pre-deployed CF+E2B combined stack; this script NEVER deploys.
// OMA_BASE_URL / API_KEY / MINIMAX_API_KEY / E2B_API_KEY / OMA_EVIDENCE_DIR required.
const W=resolve(import.meta.dirname,'..'),R=process.env.OMA_EVIDENCE_DIR;
const key=process.env.API_KEY,mm=process.env.MINIMAX_API_KEY;
if(!R||!key||!mm||!e2bSecret||!process.env.OMA_BASE_URL)throw Error('Set OMA_BASE_URL, API_KEY, MINIMAX_API_KEY, E2B_API_KEY and OMA_EVIDENCE_DIR');
mkdirSync(R,{recursive:true});
const {Sandbox}=createRequire(W+'/apps/main-node/package.json')('e2b');
const secrets=[key,mm,e2bSecret].filter(Boolean),redact=s=>secrets.reduce((a,k)=>a.split(k).join('<redacted>'),s);
const save=(p,x)=>writeFileSync(R+'/'+p+'.json',redact(JSON.stringify(x,null,2)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const base=process.env.OMA_BASE_URL;
async function api(m,p,b){const r=await fetch(base+p,{method:m,headers:{'x-api-key':key,'content-type':'application/json',accept:'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json();if(r.status>=400)throw Error(p+': '+r.status+' '+JSON.stringify(j).slice(0,300));return j;}
async function events(sid){let page=null,out=[];do{const j=await api('GET','/v1/sessions/'+sid+'/events?limit=100'+(page?'&page='+encodeURIComponent(page):''));out.push(...j.data);page=j.next_page;}while(page);return out;}
async function turn(sid,text,label,allowError=false){const before=(await events(sid)).length;await api('POST','/v1/sessions/'+sid+'/events',{events:[{type:'user.message',content:[{type:'text',text}]}]});for(let i=0;i<180;i++){await sleep(3000);const all=await events(sid),fresh=all.slice(before);if(fresh.some(x=>x.type==='session.status_idle')){save(label,{sid,events:all});const errors=fresh.filter(x=>x.type==='session.error');if(errors.length&&!allowError)throw Error('session.error '+redact(JSON.stringify(errors)).slice(0,400));return fresh;}}throw Error('turn timeout');}
const text=ev=>ev.filter(x=>x.type==='agent.message').flatMap(x=>x.content??[]).map(x=>x.text??'').join('\n');
const context=e=>e.filter(x=>x.source==='oma.acp_context');
const fingerprints={head:execFileSync('git',['-C',W,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:{}};
for(const p of ['packages/agent-harness/src/acp-sandbox-loop.ts','packages/agent-harness/src/acp-recovery.ts','packages/session-runtime-contract/src/harness-context-state.ts'])fingerprints.files[p]=createHash('sha256').update(readFileSync(W+'/'+p)).digest('hex');save('source-fingerprints',fingerprints);
const kind=process.argv[2]??'pi';const modelHandle=kind==='pi'?'minimax-m31-flash-oai':'minimax-m31-flash-ant';const result={kind,checks:[]};let sid;
try{
 await api('POST','/v1/oma/model_cards',{model_id:modelHandle,model:'MiniMax-M3.1-Flash',provider:kind==='pi'?'oai-compatible':'ant-compatible',base_url:kind==='pi'?'https://api.minimaxi.com/v1':'https://api.minimaxi.com/anthropic',api_key:mm,is_default:true,pricing:{version:1,currency:'USD',input_per_mtok:'0.27',output_per_mtok:'1.10'}}).catch(e=>{if(!e.message.includes('409'))throw e;});
 const agent=await api('POST','/v1/agents',{name:'context-chaos-'+kind,model:modelHandle,system:'Remember user conversation exactly. Answer recall questions from memory. Do not read or write files unless explicitly asked.',tools:[{type:'agent_toolset_20260401'}],_oma:{harness:'acp-sandbox',acp:{agent:kind==='pi'?{id:'pi-acp',command:'/bin/bash',args:['-c','export PATH=/workspace/.npm-global/bin:/usr/local/bin:/usr/bin:/bin; export PI_ACP_PI_COMMAND=/workspace/.npm-global/bin/pi; exec /workspace/.npm-global/bin/node /workspace/.npm-global/lib/node_modules/pi-acp/dist/index.js'],cwd:'/workspace',env:{PI_ACP_PI_COMMAND:'/workspace/.npm-global/bin/pi',PATH:'/workspace/.npm-global/bin:/usr/local/bin:/usr/bin:/bin'}}:{registry:'claude-acp@0.94.0',cwd:'/workspace'},per_turn_timeout_ms:180000}}});
 const environment=await api('POST','/v1/environments',{name:'context-'+kind,config:{type:'cloud',networking:{type:'unrestricted'},packages:kind==='pi'?{npm:['node@24.22.2','@earendil-works/pi-coding-agent@0.84.4','pi-acp@0.0.33']}:{}}});
 sid=(await api('POST','/v1/sessions',{agent:agent.id,environment_id:environment.id,title:'ACP context chaos '+kind})).id;result.sid=sid;save(kind+'-state',{sid,agent:agent.id,environment:environment.id});
 const phrase='amber-otter-'+randomBytes(5).toString('hex');
 const first=await turn(sid,'Memorize this exact passphrase: '+phrase+'. Reply only SAVED. Do not use any tools.',kind+'-first');result.checks.push({case:'native-recorded',ok:context(first).some(x=>x.details?.state==='native')});
 save(kind+'-initial-context',context(first));
 let list;for(let i=0;i<Number(process.env.OMA_PAUSE_POLLS??90);i++){list=await sessionSandboxes(sid);if(list.some(x=>x.state==='paused'))break;await sleep(5000);}result.checks.push({case:'idle-paused',ok:list.some(x=>x.state==='paused')});
 const recalled=await turn(sid,'What exact passphrase did I ask you to memorize? Reply only that passphrase. Do not use tools.',kind+'-resume');result.checks.push({case:'native-resume-recall',ok:text(recalled).includes(phrase)&&!context(recalled).some(x=>x.details?.state==='rebuilt')});
 for(const mode of ['snapshot','native-deleted','checkpoint-corrupt']){
 const boxes=await sessionSandboxes(sid),id=boxes[0]?.sandboxId;if(!id)throw Error('no box');
 if(mode==='snapshot'){await Sandbox.kill(id,{apiKey:e2bSecret});}
 else {const box=await Sandbox.connect(id,{apiKey:e2bSecret});await box.commands.run(mode==='native-deleted'?"rm -rf /oma/harness-state/acp/"+sid+"/*/v1/native":"for f in /oma/harness-state/acp/"+sid+"/*/v1/*.json; do printf '{broken' > \"$f\"; done",{user:'root'});}
 const ev=await turn(sid,'Recall the exact original passphrase. Reply only that passphrase; do not use tools.',kind+'-'+mode);result.checks.push({case:mode,ok:text(ev).includes(phrase)&&(mode==='snapshot'?!context(ev).some(x=>x.details?.state==='rebuilt'):context(ev).some(x=>x.details?.state==='rebuilt')),rebuilt:context(ev).some(x=>x.details?.state==='rebuilt')});
 }

 // Real-model failures use a protocol proxy, not a mock model or product hook.
 for(const fault of ['first','partial']){
   const faultAgent=await api('POST','/v1/agents',{name:'context-failure-'+kind+'-'+fault,model:modelHandle,system:'Remember user conversation exactly. Never write conversation or passphrases to disk.',tools:[{type:'agent_toolset_20260401'}],_oma:{harness:'acp-sandbox',acp:{agent:{id:kind==='pi'?'pi-acp':'claude-acp',command:'/bin/bash',args:['-c','export PATH=/workspace/.npm-global/bin:/usr/local/bin:/usr/bin:/bin; export PI_ACP_PI_COMMAND=/workspace/.npm-global/bin/pi; exec /workspace/.npm-global/bin/node /workspace/acp-context-fault-bridge.mjs '+fault+' /workspace/.fault-'+fault+' /workspace/.npm-global/bin/node /workspace/.npm-global/lib/node_modules/'+(kind==='pi'?'pi-acp':'@agentclientprotocol/claude-agent-acp')+'/dist/index.js'],cwd:'/workspace'},per_turn_timeout_ms:180000}}});
  const setup=await api('POST','/v1/environments',{name:'context-fault-'+kind,config:{type:'cloud',networking:{type:'unrestricted'},packages:{npm:['node@24.22.2',...(kind==='pi'?['@earendil-works/pi-coding-agent@0.84.4','pi-acp@0.0.33']:['@agentclientprotocol/claude-agent-acp@0.94.0'])]}}});
  const form=new FormData();form.set('file',new Blob([readFileSync(W+'/scripts/acp-context-fault-bridge.mjs')],{type:'text/javascript'}),'acp-context-fault-bridge.mjs');
  const uploaded=await fetch(base+'/v1/files',{method:'POST',headers:{'x-api-key':key},body:form});
  if(!uploaded.ok)throw Error('fault bridge upload '+uploaded.status);
  const bridgeFile=await uploaded.json();
  const faultSession=await api('POST','/v1/sessions',{agent:faultAgent.id,environment_id:setup.id,title:'ACP failed '+fault});
  const fsid=faultSession.id;
  try{
   await api('POST','/v1/sessions/'+fsid+'/resources',{type:'file',file_id:bridgeFile.id,mount_path:'/workspace/acp-context-fault-bridge.mjs'});
   const original='original-request-'+randomBytes(5).toString('hex');
   const ev=await turn(fsid,'Memorize '+original+'. Reply with it, do not use tools or files.',kind+'-'+fault+'-failed',true);
   result.checks.push({case:fault+'-failure-visible',ok:ev.some(x=>x.type==='session.error')&&!context(ev).some(x=>x.details?.state==='native')});
   const recovery=await turn(fsid,'What exact original-request token did I ask you to memorize? Reply only it. Do not use tools or files.',kind+'-'+fault+'-recovered');
   result.checks.push({case:fault+'-failure-rebuild-recall',ok:text(recovery).includes(original)&&context(recovery).some(x=>x.details?.state==='rebuilt')});
  }finally{await api('POST','/v1/sessions/'+fsid+'/archive',{});}
 }
}catch(e){result.error=redact(String(e.stack??e));}finally{if(sid)await api('POST','/v1/sessions/'+sid+'/archive',{}).catch(e=>{result.cleanupError=String(e.message)});result.ok=!result.error&&!result.cleanupError&&result.checks.every(x=>x.ok);save(kind+'-result',result);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
