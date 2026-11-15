import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiHarness, registerHarness } from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";
const dir=process.argv[2]!;
const calls=JSON.parse(readFileSync(join(dir,"calls.json"),"utf8"));
registerHarness("mixed-process",()=>({async run(ctx){
 const faux=fauxProvider({tokensPerSecond:100000}),models=createModels();models.setProvider(faux.provider);
 faux.setResponses([context=>{
  appendFileSync(join(dir,"samples.jsonl"),JSON.stringify({pid:process.pid,at:Date.now(),messages:context.messages})+"\n");
  const lastUser=context.messages.findLastIndex(m=>m.role==="user");
  const round=context.messages.filter(m=>m.role==="user").length;
  const resumed=context.messages.slice(lastUser).some(m=>m.role==="assistant"&&Array.isArray(m.content)&&m.content.some(p=>p.type==="toolCall"));
  return resumed ? fauxAssistantMessage("MIXED_RESTART_DONE") : fauxAssistantMessage(calls.map((c:any)=>fauxToolCall(c.name,c.args,{id:round===1?c.id:c.id+"-r"+round})),{stopReason:"toolUse"});
 },context=>{appendFileSync(join(dir,"samples.jsonl"),JSON.stringify({pid:process.pid,at:Date.now(),unexpected:true,messages:context.messages})+"\n");return fauxAssistantMessage("UNEXPECTED");}]);
 await new PiHarness().run({...ctx,pi:{models,model:faux.getModel(),thinkingLevel:"off",speed:"standard"}});
}}));
const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"1",PLATFORM_ROOT_SECRET:"test-platform-root-secret-padded-to-thirtytwo",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",MEMORY_QUEUE:"disabled",DATABASE_PATH:join(dir,"oma.db"),AUTH_DATABASE_PATH:join(dir,"auth.db"),SANDBOX_WORKDIR:join(dir,"sandboxes"),MEMORY_BLOB_DIR:join(dir,"memory"),FILES_BLOB_DIR:join(dir,"files"),SESSION_OUTPUTS_DIR:join(dir,"outputs")});
const cp=await createNodeControlPlane(await nodeDefaults(config));await cp.start();
const server=serve({fetch:r=>cp.fetch(r),hostname:"127.0.0.1",port:0});
if(!server.listening)await new Promise<void>(r=>server.once("listening",r));
writeFileSync(join(dir,"ready.json"),JSON.stringify({pid:process.pid,port:(server.address() as any).port}));
