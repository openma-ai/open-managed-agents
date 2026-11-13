/** Explicit provider diagnostic: complete official ACP distribution, real guest
 * tools + native load. Does not claim control-plane/topology acceptance. */
import {Sandbox} from '../../../apps/main-node/node_modules/e2b/dist/index.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {piCustomToolFiles} from '../src/pi-custom-tools';
const key=process.env.E2B_API_KEY,template=process.env.OMA_E2B_TEMPLATE,out=process.env.OMA_PI_CUSTOM_RECEIPT;
if(!key||!template||!out)throw Error('Explicit isolated key/template/receipt required');
const r:any={startedAt:new Date().toISOString(),kind:'official ACP inside E2B with production generated extension; not full host/Work acceptance',sourceSha256:createHash('sha256').update(readFileSync(new URL('../src/pi-custom-tools.ts',import.meta.url))).digest('hex'),cases:[]};
const save=()=>writeFileSync(out,JSON.stringify(r,null,2));let box:Sandbox|undefined;
try {
 box=await Sandbox.create(template,{apiKey:key,timeoutMs:600000,metadata:{task:'pr545-task-e2e4t-20261112',purpose:'inside-custom-tools-t2044u-matrix'}});r.sandboxId=box.sandboxId;save();
 const base='/home/oma-worker/custom-matrix';
 r.install=await box.commands.run(`mkdir -p ${base} && cd ${base} && npm install --no-audit --no-fund @openma/pi-acp@0.1.8`,{user:'oma-worker',timeoutMs:180000});save();
 r.versions=await box.commands.run(`cd ${base} && npm ls @openma/pi-acp @earendil-works/pi-coding-agent @earendil-works/pi-agent-core @earendil-works/pi-ai --json`,{user:'oma-worker'});save();
 await box.files.write(base+'/probe.py',readFileSync(new URL('./fixtures/pi-custom-tools/probe.py',import.meta.url)),{user:'oma-worker'});
 for(const name of (process.env.OMA_PI_CUSTOM_CASES?.split(',') ?? ['old-custom-first','custom-first','custom-last','multiple','restart','partial','mcp'])) {
  const old=name.startsWith('old-'), root=base+'/'+name+'-'+randomUUID();
  const definitions=['approve',...(['multiple','partial'].includes(name)?['approve_second']:[])].map(name=>({type:'custom',name,description:'Client approval',input_schema:{type:'object',properties:{}}}));
  const plan=piCustomToolFiles(root+'/native',definitions)!;
  if(!old)await box.files.write(plan.extensionPath,plan.source,{user:'oma-worker'});
  await box.files.write(base+'/plan.json',JSON.stringify({root,answersPath:plan.answersPath,case:old?'custom-first':name,old}),{user:'oma-worker'});
  const item:any={case:name,root,expectedExit:old?1:0};r.cases.push(item);save();
  try {item.execution=await box.commands.run(`cd ${base} && python3 probe.py plan.json`,{user:'oma-worker',timeoutMs:90000});}
  catch(e){item.execution={exitCode:(e as any).exitCode,stdout:(e as any).stdout,stderr:(e as any).stderr};}
  item.pass=item.execution.exitCode===item.expectedExit && (!old || item.execution.stderr?.includes('Custom approve tool not advertised'));
  save();if(!item.pass)throw Error('Case failed: '+name);
 }
 r.status='PASS_NATIVE_CUSTOM_MATRIX';
}catch(e){r.status='FAIL';r.error=String(e);process.exitCode=1;}
finally{if(box)try{r.paused=await box.betaPause();}catch(e){r.pauseError=String(e);}r.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:r.status,sandboxId:r.sandboxId,paused:r.paused}));}
