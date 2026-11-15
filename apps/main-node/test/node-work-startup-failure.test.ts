import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";
import { WebCryptoAesGcm } from "../../../packages/integrations-adapters-cf/src/index";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";

it("actual Node HTTP atomically settles startup failure, fences later inputs and keeps ordinary force stop unchanged", async () => {
  const root = await mkdtemp(join(process.cwd(),".test-artifacts/startup-"));
  const secretRoot = "test-root-secret-not-production";
  const components = await nodeDefaults(loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"admin",PLATFORM_ROOT_SECRET:secretRoot,PUBLIC_BASE_URL:"https://control.test",MEMORY_QUEUE:"disabled",LOG_LEVEL:"silent",PROCESS_MODE:"api",
    DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),SANDBOX_WORKDIR:join(root,"sandboxes"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs")}),{sandbox:async()=>{throw new Error("No launch");}});
  const cp = await createNodeControlPlane(components);
  const sql = components.database.sql;
  try {
    const now = new Date().toISOString();
    const tokenCipher = new WebCryptoAesGcm(secretRoot,"managed.environment-work.session-token");
    const cipher = new WebCryptoAesGcm(secretRoot,"managed.environment-work.secret");
    async function seed(sessionId: string) {
      const workId = "work_" + sessionId;
      await seedSandboxGatewaySessionRows(sql,"default",{id:sessionId,environmentId:"env",vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
      await sql.prepare("UPDATE managed_sessions SET document = ?,status = 'running',revision = 3 WHERE id = ?").bind(JSON.stringify({id:sessionId,agent:{id:"agent",version:1},environmentId:"env",status:"running",updatedAt:now,archivedAt:null}),sessionId).run();
      const token = "sk-ant-req-v1." + await tokenCipher.encrypt(JSON.stringify({version:1,workspaceId:"default",environmentId:"env",sessionId,workId,issuedAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),claimedAt:now,generation:1,skills:[],files:[],memoryStores:[]}));
      const sealed = await cipher.encrypt(JSON.stringify({sessionsToken:token}));
      await sql.prepare("INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_generation,heartbeat_ttl_seconds,revision,state,created_at) VALUES ('default','env',?,?,?,?,?,1,90,4,'active',?)").bind(workId,sessionId,JSON.stringify({id:workId,environmentId:"env",data:{type:"session",id:sessionId},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,stopRequestedAt:null,stoppedAt:null,metadata:{}}),sealed,Date.now(),Date.now()).run();
      return {workId,token};
    }
    const a = await seed("startup_http");
    const send = (sessionId:string,action:string,body:unknown,bearer=a.token) => cp.fetch(new Request("https://control.test/v1/oma/sessions/"+sessionId+"/"+action,{method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},body:JSON.stringify(body)}));
    expect((await send("startup_http","startup-boundary",{})).status).toBe(200);
    expect((await send("startup_http","runtime-events",{events:[{id:"own-running",type:"session.status_running",processed_at:now}]})).status).toBe(200);
    expect((await send("startup_http","startup-failed",{revision:3,processedAt:now},"admin")).status).toBe(401);
    expect((await send("startup_http","startup-failed",{revision:3,processedAt:now})).status).toBe(200);
    expect((await send("startup_http","startup-failed",{revision:3,processedAt:now})).status).toBe(200);
    expect((await send("startup_http","startup-failed",{revision:4,processedAt:now})).status).toBe(409);
    expect(await sql.prepare("SELECT state FROM managed_environment_work WHERE id = ?").bind(a.workId).first()).toEqual({state:"stopped"});
    expect(await sql.prepare("SELECT status,revision FROM managed_sessions WHERE id = 'startup_http'").first()).toEqual({status:"idle",revision:5});
    await sql.exec("DELETE FROM managed_environments WHERE workspace_id = 'default' AND id = 'env'");
    const b = await seed("later_input");
    expect((await send("later_input","startup-boundary",{},b.token)).status).toBe(200);
    await sql.exec("UPDATE managed_sessions SET revision = 4 WHERE id = 'later_input'");
    expect((await send("later_input","startup-failed",{revision:3,processedAt:now},b.token)).status).toBe(409);
    expect(await sql.prepare("SELECT state FROM managed_environment_work WHERE id = ?").bind(b.workId).first()).toEqual({state:"active"});
    const response = await cp.fetch(new Request("https://control.test/v1/environments/env/work/"+b.workId+"/stop",{method:"POST",headers:{"x-api-key":"admin","content-type":"application/json"},body:JSON.stringify({force:true})}));
    const responseBody = await response.text();
    expect(response.status,responseBody).toBe(200);
    expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id = 'later_input' AND type = 'session.error'").first()).toEqual({n:0});
  } finally { await cp.stop(); await rm(root,{recursive:true,force:true}); }
},60000);
