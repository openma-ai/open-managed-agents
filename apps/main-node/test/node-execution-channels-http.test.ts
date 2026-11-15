import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";
import { SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql/coordination";
import { createSqlGatewaySandboxTokenStore } from "../../../packages/sandbox-gateway-sql/src/index";
import { issueSandboxToken } from "../../../packages/sandbox-gateway/src/index";

it("actual Node HTTP authority returns only current all-scope channels, never creates a token", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-artifacts/channels-"));
  const components = await nodeDefaults(loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"admin",PLATFORM_ROOT_SECRET:"test-root-secret-not-production",PUBLIC_BASE_URL:"https://control.test",MEMORY_QUEUE:"disabled",LOG_LEVEL:"silent",PROCESS_MODE:"api",
    DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),SANDBOX_WORKDIR:join(root,"sandboxes"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs")}),{sandbox:async()=>{throw new Error("No provider launch in channels authority");}});
  const cp = await createNodeControlPlane(components);
  try {
    const admin = async (path:string, body:unknown) => {
      const response = await cp.fetch(new Request("https://control.test"+path,{method:"POST",headers:{"x-api-key":"admin","content-type":"application/json"},body:JSON.stringify(body)}));
      const data:any=await response.json(); expect(response.status,JSON.stringify(data)).toBeLessThan(300); return data;
    };
    await admin("/v1/oma/model_cards",{model_id:"hosted",model:"upstream-model",provider:"anthropic",base_url:"https://upstream.test",api_key:"must-not-appear"});
    const environment = await admin("/v1/environments",{name:"external",config:{type:"self_hosted"}});
    const agent = await admin("/v1/agents",{name:"pinned",model:"hosted",system:"hello",tools:[]});
    const session = await admin("/v1/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id});
    const sql=components.database.sql;
    const row=await sql.prepare("SELECT workspace_id FROM managed_sessions WHERE id = ?").bind(session.id).first<{workspace_id:string}>();
    const workspaceId=row!.workspace_id; const executions=new SqlSessionExecutionCoordinator(sql); const now=new Date().toISOString();
    await executions.admit({execution:{id:"channels-exec",workspaceId,sessionId:session.id,admittedAt:now,events:[{id:"input",type:"user.message",content:[],processedAt:now}]}});
    const claim=await executions.claim({workspaceId,sessionId:session.id,ownerId:"owner",attemptId:"attempt",claimedAt:now,leaseTtlMs:60_000});
    if(claim.type!=="claimed") throw new Error("claim failed");
    const store=createSqlGatewaySandboxTokenStore(sql);
    const token=await issueSandboxToken(store,claim.fence,{scope:"all"});
    const call=(bearer:string,id=session.id)=>cp.fetch(new Request("https://control.test/v1/oma/sessions/"+id+"/execution-channels",{method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},body:"{}"}));
    const response=await call(token); const result:any=await response.json();
    expect(response.status).toBe(200); expect(result).toMatchObject({type:"ready",channels:{mcpProxy:{sessionsToken:token},hostedInference:{sessionsToken:token,model:{providerId:"anthropic",wireModel:"upstream-model"}}}});
    expect(JSON.stringify(result)).not.toContain("must-not-appear");
    expect((await call("sk-ant-req-v1.not-sandbox")).status).toBe(401);
    expect((await call(token,"other-session")).status).toBe(401);
    const replacement=await issueSandboxToken(store,claim.fence,{scope:"all"});
    expect((await call(token)).status).toBe(401);
    expect((await call(replacement)).status).toBe(200);
    const hashes = await sql.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE id = ?").bind(claim.fence.executionId).first<{sandbox_token_hashes:string}>();
    expect(JSON.parse(hashes!.sandbox_token_hashes)).toHaveLength(1);
    const before = hashes!.sandbox_token_hashes;
    await call(replacement);
    expect((await sql.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE id = ?").bind(claim.fence.executionId).first<{sandbox_token_hashes:string}>())!.sandbox_token_hashes).toBe(before);
    // Simulate stored scope/lease transitions, not a second token authority.
    const entries=JSON.parse(before); entries[0].s="egress";
    await sql.prepare("UPDATE managed_session_executions SET sandbox_token_hashes = ? WHERE id = ?").bind(JSON.stringify(entries),claim.fence.executionId).run();
    expect((await call(replacement)).status).toBe(401);
    await sql.prepare("UPDATE managed_session_executions SET sandbox_token_hashes = ?, lease_expires_at_ms = ? WHERE id = ?").bind(before,0,claim.fence.executionId).run();
    expect((await call(replacement)).status).toBe(401);
  } finally {await cp.stop(); await rm(root,{recursive:true,force:true});}
});
