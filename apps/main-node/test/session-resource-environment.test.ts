import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registerHarness, type HarnessContext } from "@open-managed-agents/agent-harness";
import { reconcileSandboxResourceEnvironment } from "@open-managed-agents/sandbox";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";

it("Node Session passes mounted facts to complete process composition without stale declared or sandbox paths", async () => {
 const dir=await mkdtemp(join(tmpdir(),"session-resource-env-"));
 const harnessId="resource-env-"+Date.now();
 let observed: { facts: HarnessContext["resourceFacts"]; environment: Record<string,string>; prompt: string }|undefined;
 let failure: unknown;
 registerHarness(harnessId,()=>({async run(ctx){try {
  const sandbox=ctx.runtime.sandbox;
  await sandbox.setEnvVars!({OMA_MEMORY_LEFTOVER:"/retired",UNRELATED:"keep"});
  console.log("node.session.resource.facts",JSON.stringify(ctx.resourceFacts));
  if(!ctx.resourceFacts)throw Error("Node Session omitted current resource facts");
  const env=await reconcileSandboxResourceEnvironment(sandbox,ctx.resourceFacts,{OMA_MEMORY_INSTALLED:"/retired-installed",OMA_OUTPUTS_DIR:"/old-output"});
  const child=await sandbox.spawnDuplexProcess!({command:process.execPath,args:["-e",'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("OMA_MEMORY_")||k==="OMA_OUTPUTS_DIR"||k==="UNRELATED"))))'],env});
  const text=await new Response(child.stdout).text();await child.exited;
  observed={facts:ctx.resourceFacts,environment:JSON.parse(text),prompt:ctx.systemPrompt};
  console.log("node.session.child.resource.environment",JSON.stringify(observed.environment));
 }catch(e){failure=e;}}}));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"1",PLATFORM_ROOT_SECRET:"test-platform-root-secret-padded-to-thirtytwo",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",MEMORY_QUEUE:"disabled",DATABASE_PATH:join(dir,"db"),AUTH_DATABASE_PATH:join(dir,"auth"),SANDBOX_WORKDIR:join(dir,"sandbox"),MEMORY_BLOB_DIR:join(dir,"memory"),FILES_BLOB_DIR:join(dir,"files"),SESSION_OUTPUTS_DIR:join(dir,"outputs")});
 const cp=await createNodeControlPlane(await nodeDefaults(config));await cp.start();
 const api=async(path:string,body?:unknown)=>{const r=await cp.fetch(new Request("http://localhost"+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));expect(r.ok,await r.clone().text()).toBe(true);return r.json() as Promise<any>;};
 try{
  await api("/v1/oma/model_cards",{provider:"ant",model_id:"resource-env-model",api_key:"test",base_url:"http://unused.invalid"});
  const agent=await api("/v1/agents",{name:"resource-env",model:"resource-env-model",system:"resource test",_oma:{harness:harnessId}});
  const store=await api("/v1/memory_stores",{name:"notes"});
  const environment=await api("/v1/environments",{name:"resource-env",config:{type:"cloud"}});
  const session=await api("/v1/sessions",{agent:agent.id,environment_id:environment.id,resources:[{type:"memory_store",memory_store_id:store.id,access:"read_only"}]});
  await api(`/v1/sessions/${session.id}/events`,{events:[{type:"user.message",content:[{type:"text",text:"inspect"}]}]});
  await expect.poll(async()=>{ const events=await api(`/v1/sessions/${session.id}/events`); const errors=events.data.filter((e:any)=>e.type==="session.error"); if(errors.length)console.log("node.session.start.errors",JSON.stringify(errors)); return observed!==undefined||failure!==undefined; },{timeout:15000}).toBe(true);
  expect(failure).toBeUndefined();
  expect(observed!.facts!.memoryStores).toMatchObject([{storeId:store.id,path:"/mnt/memory/notes",access:"read_only"}]);
  expect(observed!.prompt).toContain("Mounted at /mnt/memory/notes/ (read-only)");
  expect(observed!.environment.OMA_MEMORY_INSTALLED).toBeUndefined();
  expect(observed!.environment.OMA_MEMORY_LEFTOVER).toBeUndefined();
  expect(observed!.environment.OMA_MEMORY_NOTES).toContain("/memory/notes");
  expect(observed!.environment.OMA_OUTPUTS_DIR).toContain("outputs");
  expect(observed!.environment.UNRELATED).toBe("keep");
 }finally{await cp.stop();}
});
