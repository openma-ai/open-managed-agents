import { expect, it } from "vitest";
import { buildWorkStartupFailureRoutes } from "../../http-routes/src/work-startup-failure";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { SqlSessionRuntimeProjectionPersistence } from "../src/session-runtime-projection-sql-persistence";

async function fixture() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id));
CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,claim_worker_id TEXT,created_at INTEGER,PRIMARY KEY(workspace_id,id));
CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));`);
  const now = new Date().toISOString();
  const session = { id:"session", agent:{id:"agent",version:1}, environmentId:"env", deploymentId:null, status:"running", updatedAt:now, archivedAt:null };
  await sql.prepare("INSERT INTO managed_sessions VALUES ('ws','session',?,3,0,0,NULL,'env','agent',1,NULL,'running')").bind(JSON.stringify(session)).run();
  await sql.prepare("INSERT INTO managed_environment_work VALUES ('ws','env','work','session','active',1,?,90,4,'{}',NULL,0)").bind(Date.now()).run();
  const persistence = new SqlSessionRuntimeProjectionPersistence(sql);
  const input = { claim:{workspaceId:"ws",environmentId:"env",sessionId:"session",workId:"work",generation:1}, revision:3, processedAt:now };
  return { sql, persistence, input };
}

it("commits startup error, idle and Work stop together under the captured revision", async () => {
  const { sql, persistence, input } = await fixture();
  expect(await persistence.settleStartupFailure(input)).toBe("committed");
  expect(await sql.prepare("SELECT status,revision FROM managed_sessions").first()).toEqual({status:"idle",revision:4});
  expect(await sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"stopped"});
  expect((await sql.prepare("SELECT type FROM managed_session_events ORDER BY id").all()).results).toEqual([{type:"session.error"},{type:"session.status_idle"}]);
  expect(await persistence.settleStartupFailure(input)).toBe("committed");
  expect((await sql.prepare("SELECT count(*) AS n FROM managed_session_events").first<{ n: number }>())!.n).toBe(2);
});

for (const [name, mutation] of [
  ["later input", "UPDATE managed_sessions SET revision = 4"],
  ["reclaimed owner", "UPDATE managed_environment_work SET claim_generation = 2, revision = 5"],
  ["expired lease", "UPDATE managed_environment_work SET claim_at = 0"],
  ["new Work", "INSERT INTO managed_environment_work SELECT workspace_id,environment_id,'new-work',session_id,'queued',0,NULL,90,1,'{}',NULL,1 FROM managed_environment_work"],
  ["already idle", "UPDATE managed_sessions SET status = 'idle', document = json_set(document, '$.status', 'idle')"],
] as const) {
  it("rejects startup settlement after " + name + " without writing terminal facts", async () => {
    const { sql, persistence, input } = await fixture();
    await sql.exec(mutation);
    expect(await persistence.settleStartupFailure(input)).toBe("rejected");
    expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_events").first()).toEqual({ n: 0 });
    expect(await sql.prepare("SELECT state FROM managed_environment_work WHERE id = 'work'").first()).toEqual({ state: "active" });
  });
}

it("confirms only the identical committed body, even after new input", async () => {
  const { sql, persistence, input } = await fixture();
  expect(await persistence.captureStartupBoundary(input.claim)).toBe(3);
  expect(await persistence.settleStartupFailure(input)).toBe("committed");
  await sql.exec("UPDATE managed_sessions SET revision = 5, status = 'running'");
  expect(await persistence.settleStartupFailure(input)).toBe("committed");
  expect(await persistence.settleStartupFailure({ ...input, processedAt: new Date(Date.parse(input.processedAt) + 1).toISOString() })).toBe("rejected");
  expect(await sql.prepare("SELECT status,revision FROM managed_sessions").first()).toEqual({ status: "running", revision: 5 });
});

it("rolls back error and idle when the final Work CAS cannot stop", async () => {
  const { sql, persistence, input } = await fixture();
  await sql.exec("CREATE TRIGGER refuse_work_stop BEFORE UPDATE ON managed_environment_work WHEN NEW.state = 'stopped' BEGIN SELECT RAISE(IGNORE); END");
  expect(await persistence.settleStartupFailure(input)).toBe("rejected");
  expect(await sql.prepare("SELECT status,revision FROM managed_sessions").first()).toEqual({status:"running",revision:3});
  expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_events").first()).toEqual({n:0});
});

it("serves capture and startup failure through the shared private HTTP entry", async () => {

  const { sql, persistence } = await fixture();
  const routes = buildWorkStartupFailureRoutes({
    authenticate: async (token) => token === "work-token" ? {workspaceId:"ws",environmentId:"env",sessionId:"session",workId:"work",generation:1} : null,
    persistenceFor: async () => persistence,
  });
  const send = (path: string, body: unknown, token = "work-token") => routes.request("/session/" + path, {
    method:"POST", headers:{authorization:"Bearer " + token,"content-type":"application/json"}, body:JSON.stringify(body),
  });
  expect((await send("startup-boundary", {})).status).toBe(200);
  expect((await send("startup-failed", {revision:3,processedAt:new Date().toISOString()}, "admin")).status).toBe(401);
  const body = {revision:3,processedAt:new Date().toISOString()};
  expect((await send("startup-failed", body)).status).toBe(200);
  expect((await send("startup-failed", body)).status).toBe(200);
  expect((await send("startup-failed", {...body, revision:4})).status).toBe(409);
  expect(await sql.prepare("SELECT status FROM managed_sessions").first()).toEqual({status:"idle"});
});

it("rejects a Work revision change between prepare and transaction without publishing idle", async () => {
  const { sql, input } = await fixture();
  const raced = new SqlSessionRuntimeProjectionPersistence({
    prepare: text => sql.prepare(text),exec:text=>sql.exec(text),batch:statements=>sql.batch(statements),
    batchChecked: async (statements,validate) => {
      await sql.exec("UPDATE managed_environment_work SET revision = revision + 1");
      return sql.batchChecked!(statements,validate);
    },
  });
  expect(await raced.settleStartupFailure(input)).toBe("rejected");
  expect(await sql.prepare("SELECT status,revision FROM managed_sessions").first()).toEqual({status:"running",revision:3});
  expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_events").first()).toEqual({n:0});
});

it("does not confirm startup facts without a stopped Work", async () => {
  const { sql, persistence, input } = await fixture();
  expect(await persistence.settleStartupFailure(input)).toBe("committed");
  await sql.exec("UPDATE managed_environment_work SET state = 'active'; UPDATE managed_sessions SET revision = 3, status = 'running', document = json_set(document, '$.status', 'running')");
  expect(await persistence.settleStartupFailure(input)).toBe("rejected");
});

it("does not stamp queued input when a later accepted revision rejects late idle", async () => {
  const {sql,persistence,input} = await fixture();
  await sql.prepare("INSERT INTO managed_session_events VALUES ('ws','session',NULL,'queued','user.message',?,NULL)")
    .bind(JSON.stringify({id:"queued",type:"user.message",content:[],processedAt:null})).run();
  await sql.exec("UPDATE managed_sessions SET revision = 4");
  expect(await persistence.settleStartupFailure(input)).toBe("rejected");
  expect(await sql.prepare("SELECT processed_at FROM managed_session_events WHERE id = 'queued'").first()).toEqual({processed_at:null});
  expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_events").first()).toEqual({n:1});
});

it("rolls back terminal events and leaves Work active when the final Session CAS is rejected", async () => {
  const {sql,persistence,input} = await fixture();
  await sql.exec("CREATE TRIGGER refuse_idle BEFORE UPDATE ON managed_sessions WHEN NEW.status = 'idle' BEGIN SELECT RAISE(IGNORE); END");
  expect(await persistence.settleStartupFailure(input)).toBe("rejected");
  expect(await sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"active"});
  expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_events").first()).toEqual({n:0});
});
