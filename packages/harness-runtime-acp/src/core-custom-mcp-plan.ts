import {URL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {piMcpPendingBarrierFiles} from './pi-mcp-pending.js';
import type {NodeAcpHarnessStateIo} from './node.js';

export async function preparePiCoreMcp(io:NodeAcpHarnessStateIo,nativePath:string,tools:readonly Readonly<Record<string,unknown>>[]) {
 const custom=tools.filter(tool=>tool.type==='custom');
 if(!custom.length)return null;
 const definitions=new Map<string,Record<string,unknown>>();
 for(const tool of custom){
  if(typeof tool.name!=='string'||!tool.name||definitions.has(tool.name)||!tool.input_schema||typeof tool.input_schema!=='object')throw Error('Invalid Core custom definition');
  definitions.set(tool.name,tool as Record<string,unknown>);
 }
 const names=new Map([...definitions.keys()].map(name=>[`mcp__oma_custom__${name}`,name]));
 const barrier=piMcpPendingBarrierFiles(nativePath,[...names.keys()]);
 const scopePath=join(nativePath,'oma-custom-mcp-scope.json');
 const configPath=join(nativePath,'oma-custom-mcp.json');
 const relayPath=join(nativePath,'oma-custom-mcp.mjs');
 // Build ships this standalone official-SDK bundle beside the supervisor.
 const relay=await readFile(new URL('../dist/node-core-custom-mcp-cli.js',import.meta.url),'utf8');
 await io.writeFile(relayPath,relay);
 await io.writeFile(scopePath,'null');
 await io.writeFile(configPath,JSON.stringify({scopePath,tools:[...definitions.values()].map(d=>({name:d.name,description:d.description??d.name,inputSchema:d.input_schema}))}));
 await io.writeFile(barrier.extensionPath,barrier.source);
 // Neutralize retained old registration on replacement; never advertise twice.
 await io.writeFile(join(nativePath,'home','.pi','agent','extensions','oma-custom-tools.js'),'export default function() {}\n');
 return {...barrier,names,scopePath,server:{name:'oma_custom',command:'node',args:[relayPath,configPath],env:[]},
  async admit(baseUrl:string,sessionId:string,turnId:string,token:string){
   if(!token)throw Error('Core custom tools require scoped sandbox authority');
   await io.writeFile(scopePath,JSON.stringify({url:`${baseUrl.replace(/\/+$/,'')}/v1/oma/sessions/${encodeURIComponent(sessionId)}/custom-tools/${encodeURIComponent(turnId)}/mcp`,token}));
  },
  async clear(){await io.writeFile(scopePath,'null');},
  prepare(call:Record<string,unknown>,result:Record<string,unknown>,nativeName:string){
   const name=names.get(nativeName);if(!name)return null;
   const receipt=receiptFromContent(result.content);if(!receipt)throw Error('Core MCP returned no invocation receipt');
   if(!call.input||typeof call.input!=='object'||Array.isArray(call.input))throw Error('Invalid native custom input');
   // This is a proposed binding, not trusted publication. The existing host
   // projection transaction validates definition, arguments, receipt and fence.
   return {receipt,name,input:call.input as Record<string,unknown>};
  }};
}
function receiptFromContent(content:unknown):string|null {
 if(!Array.isArray(content)||content.length!==1||content[0]?.type!=='text')return null;
 let value;try{value=JSON.parse(content[0].text);if(Array.isArray(value?.content)){if(value.isError===true||value.content.length!==1||value.content[0]?.type!=='text')return null;value=JSON.parse(value.content[0].text);}}catch{return null;}
 const token=value?.omaCustomInvocation;
 return value&&Object.keys(value).length===1&&token&&Object.keys(token).length===2&&token.version===1&&typeof token.receipt==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.receipt)?token.receipt:null;
}
