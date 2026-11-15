import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {loadNodeConfig} from "../src/config";
import {nodeDefaults} from "../src/components";
import {createNodeControlPlane} from "../src/control-plane";
import {seedSandboxGatewaySessionRows} from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from "../../../packages/sandbox-gateway-sql/src/index";
import {issueSandboxToken} from "../../../packages/sandbox-gateway/src/index";

it("two real Node HTTP replicas enforce one Work budget without a local gate and revoke old claims",async()=>{
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/work-budget-"));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"admin",PLATFORM_ROOT_SECRET:"test-budget-root-secret",PUBLIC_BASE_URL:"https://control.test",MEMORY_QUEUE:"disabled",LOG_LEVEL:"silent",PROCESS_MODE:"api",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),SANDBOX_WORKDIR:join(root,"sandboxes"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs")});
 const first=await createNodeControlPlane(await nodeDefaults(config,{sandbox:async()=>{throw new Error("No provider launch in proxy test")}}));
 const second=await createNodeControlPlane(await nodeDefaults(config,{sandbox:async()=>{throw new Error("No provider launch in proxy test")}}));
 let calls=0;
 vi.stubGlobal("fetch",async(raw:RequestInfo|URL,init?:RequestInit)=>{
   const req=new Request(raw,init);if(new URL(req.url).hostname!=="provider.test") return Response.json({});calls++;expect(req.headers.get("x-api-key")).toBe("host-only-provider-key");
   return Response.json({usage:{input_tokens:10000,output_tokens:0}});
 });
 try {
  const admin=await first.fetch(new Request("https://control.test/v1/oma/model_cards",{method:"POST",headers:{"x-api-key":"admin","content-type":"application/json"},body:JSON.stringify({model_id:"budget-model",model:"upstream",provider:"anthropic",base_url:"https://provider.test",api_key:"host-only-provider-key",pricing:{version:1,currency:"USD",input_per_mtok:"1",output_per_mtok:"1"}})}));
  expect(admin.status,await admin.text()).toBeLessThan(300);
  calls=0; // model-card creation validates its provider credential before this Work runs.
  const sql=first.components.database.sql;const now=new Date().toISOString();
  await seedSandboxGatewaySessionRows(sql,"default",{id:"budget-session",environmentId:"budget-env",vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
  const doc={id:"budget-session",agent:{id:"agent",version:1,model:"budget-model",mcpServers:[]},environmentId:"budget-env",status:"running",budget:{amountMinor:"1",currency:"USD"},usage:{},updatedAt:now,archivedAt:null,vaultIds:[]};
  await sql.prepare("UPDATE managed_sessions SET document=?,status='running',revision=3 WHERE id='budget-session'").bind(JSON.stringify(doc)).run();
  await sql.prepare("INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_generation,heartbeat_ttl_seconds,revision,state,created_at) VALUES ('default','budget-env','budget-work','budget-session','{}','unused',?,1,90,1,'active',?)").bind(Date.now(),Date.now()).run();
  const claim={workspaceId:"default",environmentId:"budget-env",sessionId:"budget-session",workId:"budget-work",generation:1};
  const token=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef(claim),{scope:"all"});
  const call=(cp:typeof first)=>cp.fetch(new Request("https://control.test/v1/oma/inference-proxy/budget-session/anthropic/v1/messages",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({model:"budget-model",messages:[]})}));
  const response=await call(first);expect(response.status).toBe(200);await response.text();
  expect((await call(second)).status).toBe(402);expect(calls).toBe(1);
  await sql.exec("UPDATE model_cards SET pricing=NULL WHERE model_id='budget-model'");
  const unpriced=await call(second);expect(unpriced.status).toBe(200);await unpriced.text();
  await sql.exec("UPDATE managed_environment_work SET claim_generation=2,sandbox_token_hashes=NULL WHERE id='budget-work'");
  expect((await call(first)).status).toBe(401);expect(calls).toBe(2);
 } finally {vi.unstubAllGlobals();await second.stop();await first.stop();await rm(root,{recursive:true,force:true});}
},60000);
