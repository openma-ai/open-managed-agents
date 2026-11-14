// Deterministic ACP wire peer, a separately spawned process. No provider SDK or inference.
import { createInterface } from "node:readline";
import { discoverSkillManifest, discoverMemoryPath, discoverOutputsDir, MEMORY_FACT, shq } from "../../../../test/resource-convergence/resource-agent-fixture.js";
const settings=JSON.parse(process.env.RESOURCE_AGENT_FIXTURE!);
const send=(value:object)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");
const update=(value:object)=>send({method:"session/update",params:{sessionId:"resource-wire",update:value}});
let modes=[{id:"mode",name:"Mode",category:"mode",type:"select",currentValue:"default",options:[{value:"default",name:"Default"},{value:"bypassPermissions",name:"Full"}]}];
async function handle(m:any){
 if(m.method==="initialize")return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:"@agentclientprotocol/claude-agent-acp",version:"0.94.0"}}});
 if(m.method==="session/new")return send({id:m.id,result:{sessionId:"resource-wire",configOptions:modes}});
 if(m.method==="session/set_config_option"){modes=modes.map(o=>({...o,currentValue:m.params.value}));return send({id:m.id,result:{configOptions:modes}});}
 if(m.method!=="session/prompt"){if(m.id!==undefined)send({id:m.id,result:{}});return;}
 const text=m.params.prompt.map((p:any)=>p.text??"").join("");
 const manifest=discoverSkillManifest(text,settings.skillId),rw=discoverMemoryPath(text,[settings.rwName]),ro=discoverMemoryPath(text,[settings.roName]),outputs=discoverOutputsDir(text);
 if(!manifest||!rw||!ro||!outputs)throw Error("Child agent could not discover resource paths");
 if(settings.checkResourceEnvironment){
  const valid=process.env.OMA_MEMORY_RETIRED===undefined&&process.env.OMA_MEMORY_AMBIENT===undefined&&process.env.OMA_OUTPUTS_DIR===outputs;
  await fetch(settings.io+"/resource-env",{method:"POST",body:JSON.stringify({retiredPresent:process.env.OMA_MEMORY_RETIRED!==undefined,ambientPresent:process.env.OMA_MEMORY_AMBIENT!==undefined,outputMatchesGuidance:process.env.OMA_OUTPUTS_DIR===outputs})});
  if(!valid)throw Error("Child resource environment disagrees with current resource contract");
 }

 const modesText=text.split("\n");if(!modesText.some((s:string)=>s.includes(rw)&&s.includes("read-write"))||!modesText.some((s:string)=>s.includes(ro)&&s.includes("read-only")))throw Error("Child agent missing mount modes");
 const recall=text.includes("recall exact memory");let manifestRead="";let last:any;
 const label=text.includes("recall exact memory restored")?"restored":"next";
 const commands=recall?[["recall-"+label,`base64 < ${shq(rw+"/fact.md")}`]]:[
  ["skill-read",`base64 < ${shq(manifest)}`],
  ["skill-script",`cd ${shq(manifest.slice(0,manifest.lastIndexOf("/")))} && sh scripts/make-report.sh ${shq(outputs+"/skill-report.txt")}`],
  ["memory-write",`printf %s ${shq(MEMORY_FACT)} > ${shq(rw+"/fact.md")}`],
  ["readonly-write",`printf MUTATION > ${shq(ro+"/seed.md")}`],
 ];
 if(settings.checkWorkspace){
  const workspace=/The session workspace is (\S+)\/\./.exec(text)?.[1];
  if(!workspace)throw Error("Child missing advertised workspace");
  const operation=recall?["recall-workspace-"+label,`base64 < ${shq(workspace+"/resource-workspace.txt")}`]:["workspace-write",`printf %s ${shq(MEMORY_FACT)} > ${shq(workspace+"/resource-workspace.txt")}`];
  commands.splice(recall?0:commands.length-1,0,operation);
 }
 for(const [id,command] of commands){
  if(id==="skill-script"&&!manifestRead.includes("sh scripts/make-report.sh"))throw Error("Child did not read bundled script instruction");
  update({sessionUpdate:"tool_call",toolCallId:id,title:id,kind:"execute",status:"in_progress",rawInput:{command}});
  const response=await fetch(settings.io+"/tool",{method:"POST",body:JSON.stringify({id,command,agentPid:process.pid})});
  if(!response.ok)throw Error("Child provider IO failed: "+response.status);
  last=await response.json();if(id==="skill-read")manifestRead=last.output;
  update({sessionUpdate:"tool_call_update",toolCallId:id,status:last.error?"failed":"completed",rawOutput:{output:last.output,exit_code:last.error?1:0},content:[{type:"content",content:{type:"text",text:last.output}}]});
 }
 update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:recall?(last.output===MEMORY_FACT?"RECALL exact bytes":"RECALL FAILED"):(last.error?"DONE readonly error observed":"FAILED readonly write accepted")}});
 send({id:m.id,result:{stopReason:"end_turn"}});
}
for await(const line of createInterface({input:process.stdin})){try{await handle(JSON.parse(line));}catch(e){process.stderr.write(String(e)+"\n");process.exitCode=1;break;}}
