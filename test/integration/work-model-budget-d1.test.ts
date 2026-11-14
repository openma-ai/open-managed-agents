// @ts-nocheck
import {env,exports} from "cloudflare:workers";
import {expect,it,vi} from "vitest";
import {sqlClientFromD1} from "../../packages/sql-client/src/adapters/cf-d1";
import {seedSandboxGatewaySessionRows} from "../../packages/sandbox-gateway/test/gateway-store-conformance";
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from "../../packages/sandbox-gateway-sql/src/index";
import {issueSandboxToken} from "../../packages/sandbox-gateway/src/index";
import {SqlWorkModelEgress} from "../../packages/managed-agents-adapters-sql/src/work-model-egress";

it("real CF inference HTTP uses canonical Work budget instead of an inactive SessionDO meter",async()=>{
 await exports.default.fetch(new Request("https://oma.example/health"));
 const {default:app}=await import("../../apps/main/src/index");
 const sql=sqlClientFromD1(env.MAIN_DB),id="budget_"+crypto.randomUUID(),workId="work_"+id;
 const testEnv={...env,PLATFORM_ROOT_SECRET:"fixture-budget-root-secret-0123456789",PUBLIC_BASE_URL:"https://oma.example"};
 const pricing={version:1,currency:"USD",input_per_mtok:"1",output_per_mtok:"1"};
 let calls=0;
 vi.stubGlobal("fetch",async()=>{calls++;return Response.json({usage:{input_tokens:10000,output_tokens:0}})});
 try{
  const card=await app.fetch(new Request("https://oma.example/v1/oma/model_cards",{method:"POST",headers:{"x-api-key":env.API_KEY,"content-type":"application/json"},body:JSON.stringify({model_id:id,model:"upstream",provider:"anthropic",base_url:"https://provider.test",api_key:"host-only-key",pricing})}),testEnv);
  expect(card.status,await card.text()).toBeLessThan(300);calls=0;
  await seedSandboxGatewaySessionRows(sql,"default",{id,environmentId:id,vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
  const doc={id,agent:{id:"agent",version:1,model:id,mcpServers:[]},environmentId:id,status:"running",budget:{amountMinor:"1",currency:"USD"},usage:{},updatedAt:new Date().toISOString(),archivedAt:null,vaultIds:[]};
  await sql.prepare("UPDATE managed_sessions SET document=?,status='running',revision=3 WHERE id=?").bind(JSON.stringify(doc),id).run();
  await sql.prepare("INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_generation,heartbeat_ttl_seconds,revision,state,created_at) VALUES ('default',?,?,?,'{}','unused',?,1,90,1,'active',?)").bind(id,workId,id,Date.now(),Date.now()).run();
  const claim={workspaceId:"default",environmentId:id,sessionId:id,workId,generation:1};
  const token=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef(claim),{scope:"all"});
  const call=()=>app.fetch(new Request("https://oma.example/v1/oma/inference-proxy/"+id+"/anthropic/v1/messages",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({model:id,messages:[]})}),testEnv);
  const first=await call();expect(first.status).toBe(200);await first.text();
  expect((await call()).status).toBe(402);expect(calls).toBe(1);
  const other=await new SqlWorkModelEgress(sql).open(claim,pricing);expect(await other.begin()).toBe(false);
  await sql.prepare("UPDATE model_cards SET pricing=NULL WHERE model_id=?").bind(id).run();
  const unpriced=await call();expect(unpriced.status).toBe(200);await unpriced.text();
  await sql.prepare("UPDATE managed_environment_work SET claim_generation=2,sandbox_token_hashes=NULL WHERE id=?").bind(workId).run();
  expect((await call()).status).toBe(401);
 }finally{vi.unstubAllGlobals();}
},60000);
