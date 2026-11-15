import {dirname,resolve} from 'node:path';
import {createNodeManagedAcpSupervisorApp} from '../../../../packages/harness-runtime-acp/src/node-supervisor';
import {createAcpRuntime} from '../../../../packages/acp-runtime/src/placement';
import {NodeSpawner} from '@open-managed-agents/acp-runtime/node-spawner';
import {createNodeAcpHarnessStateIo} from '../../../../packages/harness-runtime-acp/src/node';
import {loadWorkRuntimeModules,WorkTurnActivities} from '../../../../packages/harness-runtime-acp/src/node-work-composition';
let run:any;
process.on('message',async(input:any)=>{
 if(input.type==='stop'){try{await run?.stop('fixture restart');process.send?.({type:'stopped'});process.disconnect();}catch(e){process.send?.({type:'failed',message:String(e)});}return;}
 if(input.type!=='start')return;
 try{
  const {root,scope,token,sandboxToken,base,modelBase,entry,fixtureToken}=input;
  const modules=await loadWorkRuntimeModules(),activities=new WorkTurnActivities();
  const io=createNodeAcpHarnessStateIo({workspacePath:root});
  const app=createNodeManagedAcpSupervisorApp({workspacePath:root,environment:{ANTHROPIC_ENVIRONMENT_ID:scope.environmentId,ANTHROPIC_SESSION_ID:scope.sessionId,ANTHROPIC_WORK_ID:scope.workId,OPENMA_SANDBOX_TOKEN:sandboxToken,ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:token,api_base_url:base})).toString('base64url')},
   resolveExecutionChannels:async()=>({type:'ready',channels:{mcpProxy:{gatewayBaseUrl:modelBase,sessionsToken:fixtureToken},hostedInference:{gatewayBaseUrl:modelBase,sessionsToken:fixtureToken,model:{providerId:'anthropic',baseUrl:null,wireModel:'test',protocolEndpoints:[{protocol:'anthropic-messages',proxyPathSegment:'anthropic',upstreamBaseUrl:modelBase}]}}}}),
   agentId:'pi-acp',resolveAgent:async()=>({id:'pi-acp',command:resolve(dirname(entry),'../../../.bin/openma-pi-acp'),cwd:root}),workClaim:{generation:input.generation??2,holder:input.holder??'http-worker'},control:{runtime:modules.control,pollIntervalMs:50},
   acpRuntime:activities.wrapRuntime(createAcpRuntime({type:'local',spawner:new NodeSpawner()})),stateIo:{...io,exec:command=>io.exec(command.replaceAll('/workspace',root))},
   finalization:{drainTurn:context=>activities.drain(context)},onTurnAdmitted:id=>activities.admit(id),onTurnPublished:id=>activities.published(id),lifecycle:{drainDeadlineMs:2000,abortGraceMs:2000,startupRetry:{attempts:1,delayMs:()=>0}}});
  const harness=(await app.resolveHarness({id:'acp',version:'1'}))!;
  run=await harness.start({scope,harness:{id:'acp',version:'1'},workspacePath:root,outputPath:null,checkpoint:async()=>{},signal:new AbortController().signal});
  void run.completed.catch((e:unknown)=>process.send?.({type:'failed',message:String(e)}));
  process.send?.({type:'started',pid:process.pid});
 }catch(e){process.send?.({type:'failed',message:String(e)});}
});
