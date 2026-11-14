// A real child process hosting production Work supervisor/control and ACP wire runtime.
import { createNodeManagedAcpSupervisorApp } from "../../../../packages/harness-runtime-acp/src/node-supervisor.js";
import { WorkTurnActivities, loadWorkRuntimeModules } from "../../../../packages/harness-runtime-acp/src/node-work-composition.js";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
const config=JSON.parse(process.env.RESOURCE_CHILD_FIXTURE!);
const rpc=async(method:string,...args:unknown[])=>{const r=await fetch(config.io+"/io",{method:"POST",body:JSON.stringify({method,args})});const value=await r.json() as any;if(!r.ok)throw Error(value.error);return value.result;};
const modules=await loadWorkRuntimeModules(),activities=new WorkTurnActivities();
const app=createNodeManagedAcpSupervisorApp({environment:config.environment,workspacePath:config.workspace,
 acpRuntime:activities.wrapRuntime(modules.createAcpRuntime(new NodeSpawner())),
 stateIo:{readFile:path=>rpc("readFile",path),writeFile:(path,value)=>rpc("writeFile",path,value),writeFileBytes:(path,value)=>rpc("writeFileBytes",path,Buffer.from(value).toString("base64")),exec:command=>rpc("exec",command)},
 workClaim:{generation:1,holder:config.claim.holder},resolveAgent:async()=>({id:"claude-acp",command:process.execPath,args:[config.agent],cwd:config.workspace,env:{OMA_MEMORY_RETIRED:"/stale/retired",OMA_OUTPUTS_DIR:"/stale/outputs",RESOURCE_AGENT_FIXTURE:JSON.stringify({...config.agentSettings,checkResourceEnvironment:true})}}),
 control:{runtime:modules.control,pollIntervalMs:10},finalization:{drainTurn:c=>activities.drain(c)},
 onTurnAdmitted:id=>activities.admit(id),onTurnPublished:id=>{activities.published(id);process.send?.({type:"published",id,pid:process.pid});},
});
try{
 const harness=(await app.resolveHarness({id:"acp",version:"1"}))!;
 const started=await harness.start({scope:config.claim,harness:{id:"acp",version:"1"},workspacePath:config.workspace,outputPath:"/mnt/session/outputs",checkpoint:async()=>{throw Error("Unexpected outside checkpoint");},signal:new AbortController().signal});
 process.send?.({type:"started",pid:process.pid});
 process.on("message",async m=>{if(m==="stop"){await started.stop("fixture child restart");await started.drain();process.send?.({type:"stopped"});process.exit(0);}});
 await started.completed;
}catch(e){process.send?.({type:"failed",error:String(e)});process.exit(1);}
