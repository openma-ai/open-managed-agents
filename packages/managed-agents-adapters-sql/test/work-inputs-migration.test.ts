import { URL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlWorkInputs } from "../src/work-inputs";

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup) await close(); });
const claim = { workspaceId: "ws", sessionId: "s", environmentId: "env", workId: "w", generation: 1, holder: "worker" };
const event = (position: unknown) => JSON.stringify({ id: "input", type: "user.message", content: [], processedAt: null, source_position: position });
for (const backend of ["sqlite", "d1"]) describe(backend + " deployed source-position migration", () => {
  async function fixture() {
    let sql: SqlClient;
    if (backend === "sqlite") {
      const db = await createBetterSqlite3SqlClient(":memory:"); sql = db;
    } else {
      const require = createRequire(import.meta.url);
      const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
      const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('ok')}}", compatibilityDate: "2026-11-01", d1Databases: ["DB"] }));
      sql = new CfD1SqlClient(await mf.getD1Database("DB")); cleanup.push(() => mf.dispose());
    }
    await sql.exec("CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,id TEXT,document TEXT,processed_at INTEGER);" +
      "CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));" +
      "CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER,revision INTEGER);" +
      "CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER);" +
      "INSERT INTO managed_sessions VALUES('ws','s','env',NULL,2);INSERT INTO managed_environment_work VALUES('ws','env','w','s','active',1,'worker',1000,90)");
    await sql.prepare("UPDATE managed_environment_work SET claim_at=?").bind(Date.now()).run();
    const migrate = async () => {
      const path = backend === "sqlite" ? "../../../apps/main-node/migrations-sqlite/0034_work_inputs.sql" : "../../../apps/main/migrations/0031_work_inputs.sql";
      const text = await readFile(new URL(path, import.meta.url), "utf8");
      for (const statement of text.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean)) await sql.prepare(statement).run();
    };
    return { sql, migrate, store: new SqlWorkInputs(sql, { sourcePositionsValidated: true }) };
  }
  it("installs indexed seek and prevents a duplicate source position", async () => {
    const {sql,migrate,store} = await fixture();
    await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,NULL)").bind(event({revision:2,index:0})).run();
    await expect(migrate()).resolves.toBeUndefined();
    expect(await store.read({claim,after:null,limit:1})).toMatchObject({type:"page",rows:[{event:{id:"input"}}]});
    await expect(sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','duplicate',?,NULL)").bind(event({revision:2,index:0})).run()).rejects.toThrow();
  });
  it.each([null, {}, {revision:0,index:0}, {revision:2,index:-1}, {revision:2.5,index:0}, {revision:"2",index:0}, {revision:9007199254740992,index:0}])("rejects invalid canonical positions without guessing from processed_at: %j",async position=>{
    const {sql,migrate}=await fixture();
    await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,123)").bind(event(position)).run();
    await expect(migrate()).rejects.toThrow(/source_position|CHECK/i);
    expect(await sql.prepare("SELECT document FROM managed_session_events").first()).toEqual({document:event(position)});
  });
  it("rejects existing duplicates",async()=>{
    const {sql,migrate}=await fixture();
    for(const id of ["one","two"]) await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s',?,?,NULL)").bind(id,event({revision:2,index:0})).run();
    await expect(migrate()).rejects.toThrow(/source_position|UNIQUE/i);
  });
});
