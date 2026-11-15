// Certification-only ACP proxy. Inject exactly one failed prompt, never store input text.
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const [mode,marker,command,...args]=process.argv.slice(2);
const child=spawn(command,args,{stdio:['pipe','pipe','inherit'],env:process.env});
let request=null,failed=false;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.method==='session/prompt'&&!existsSync(marker)){
  writeFileSync(marker,'injected');request=msg.id;
  if(mode==='first'){failed=true;send({jsonrpc:'2.0',id:request,error:{code:-32603,message:'certification first prompt failure'}});return;}
 }
 child.stdin.write(line+'\n');
});
createInterface({input:child.stdout}).on('line',line=>{
 const msg=JSON.parse(line);
 if(failed&&msg.id===request)return;
 send(msg);
 if(mode==='partial'&&request!==null&&!failed&&msg.method==='session/update'&&msg.params?.update?.sessionUpdate==='agent_message_chunk'){
  failed=true;send({jsonrpc:'2.0',id:request,error:{code:-32603,message:'certification partial output failure'}});
 }
});
child.on('exit',code=>process.exit(code??1));
process.stdin.on('end',()=>child.kill('SIGTERM'));
