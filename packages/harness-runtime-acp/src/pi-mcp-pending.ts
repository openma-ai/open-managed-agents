import {join} from 'node:path';

/** Native Pi sampling adapter only: never registers a tool or owns invocation
 * lifecycle. Core's canonical history supplies the answer file. Install only
 * together with atomic Work receipt publication and canonical recovery. */
export function piMcpPendingBarrierFiles(nativePath:string, nativeToolNames:readonly string[]) {
 if(!nativeToolNames.length||nativeToolNames.some(name=>!name.startsWith('mcp__')))throw new Error('Core MCP native tool names required');
 const agentDir=join(nativePath,'home','.pi','agent');
 const answersPath=join(agentDir,'oma-custom-results.json');
 return {answersPath,extensionPath:join(agentDir,'extensions','oma-mcp-pending.js'),source:`import fs from 'node:fs';
const names=new Set(${JSON.stringify(nativeToolNames)});
function receipt(message) {
 if(message.role!=='toolResult'||!names.has(message.toolName)||message.isError===true||!Array.isArray(message.content)||message.content.length!==1)return null;
 const block=message.content[0];if(block?.type!=='text'||typeof block.text!=='string')return null;
 let value;try{value=JSON.parse(block.text);}catch{return null;}
 const token=value?.omaCustomInvocation;
 if(!token||Object.keys(value).length!==1||token.version!==1||Object.keys(token).length!==2||typeof token.receipt!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.receipt))return null;
 return token.receipt;
}
export default function(pi) {
 // Pi emits turn_end after every ordinary tool in the current model batch.
 // Abort before another sampling step, not before the remaining tools finish.
 pi.on('turn_end',(event,ctx)=>{if(event.toolResults.some(receipt))ctx.abort();});
 pi.on('context',(event,ctx)=>{
  const answers=JSON.parse(fs.readFileSync(${JSON.stringify(answersPath)},'utf8'));
  return {messages:event.messages.map(message=>{
   if(!receipt(message))return message;
   const answer=Object.hasOwn(answers,message.toolCallId)?answers[message.toolCallId]:undefined;
   if(!answer||!Array.isArray(answer.content)||typeof answer.isError!=='boolean'){ctx.abort();throw Error('Outstanding Core MCP custom result');}
   return {...message,content:answer.content,isError:answer.isError,details:undefined};
  })};
 });
}
`};
}
