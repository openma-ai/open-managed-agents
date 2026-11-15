import {afterAll,expect,it} from "vitest";
import {createRequire} from "node:module";
import {createBetterSqlite3SqlClient,type SqlClient} from "@open-managed-agents/sql-client";
import {CfD1SqlClient} from "@open-managed-agents/sql-client/adapters/cf-d1";
import {SqlWorkOutcomeInterrupt} from "../src/work-outcome-interrupt";
const scope={workspaceId:"ws",sessionId:"s",interruptId:"interrupt"};
async function fixture(client?:SqlClient){
 const sql=client??await createBetterSqlite3SqlClient(":memory:");
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,environment_id TEXT,archived_at INTEGER,updated_at INTEGER,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_environment_work(workspace_id TEXT,id TEXT,session_id TEXT,environment_id TEXT,revision INTEGER,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,state TEXT,document TEXT,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));`);
 const now=new Date().toISOString();
 await sql.prepare("INSERT INTO managed_sessions VALUES ('ws','s',?,4,'env',NULL,0)").bind(JSON.stringify({id:"s",status:"running",updatedAt:now,outcomeEvaluations:[{type:"outcome_evaluation",outcomeId:"o",result:"evaluating",iteration:1,completedAt:null}]})).run();
 await sql.prepare("INSERT INTO managed_environment_work VALUES ('ws','w','s','env',3,2,'h',?,90,'stopping','{}')").bind(Date.now()).run();
 const add=async(event:Record<string,unknown>,revision:number,source:object={})=>sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s',NULL,?,?,?,0)").bind(event.id,event.type,JSON.stringify({processedAt:now,...event,source_position:{revision,index:0,...source}})).run();
 await add({id:"root",type:"user.define_outcome",outcomeId:"o"},1,{execution_id:"turn",consumed_by_execution_id:"turn",consumption_claim:{workId:"w",generation:2,holder:"h"}});
 await add({id:"start",type:"span.outcome_evaluation_start",outcomeId:"o",iteration:1},2,{execution_id:"turn",environment_work:{workId:"w",generation:2}});
 await add({id:"interrupt",type:"user.interrupt",environmentWorkId:"w"},4);
 const ends=async()=>(await sql.prepare("SELECT document FROM managed_session_events WHERE type='span.outcome_evaluation_end'").all<{document:string}>()).results!.map(r=>JSON.parse(r.document));
 const saved=async()=>JSON.parse((await sql.prepare("SELECT document FROM managed_sessions").first<{document:string}>())!.document);
 return {sql,add,ends,saved,settle:()=>new SqlWorkOutcomeInterrupt(sql).settle(scope)};
}
it("server closes only the started canonical evaluation; duplicate interrupts preserve exact receipt",async()=>{
 const f=await fixture();await f.settle();const first=await f.ends();expect(first).toHaveLength(1);expect(first[0]).toMatchObject({outcomeEvaluationStartId:"start",outcomeId:"o",iteration:1,result:"interrupted",source_position:{execution_id:"turn",environment_work:{workId:"w",generation:2}}});
 expect((await f.saved()).outcomeEvaluations[0]).toMatchObject({result:"interrupted",iteration:1,completedAt:first[0].processedAt});
 await f.settle();await f.add({id:"interrupt-again",type:"user.interrupt",environmentWorkId:"w"},6);await f.sql.exec("UPDATE managed_sessions SET revision=6");await new SqlWorkOutcomeInterrupt(f.sql).settle({...scope,interruptId:"interrupt-again"});expect(await f.ends()).toEqual(first);
});
it.each(["workspace","session","work","generation","holder","ttl","root","thread"])("does not interrupt mismatched %s authority",async kind=>{
 const f=await fixture();
 if(kind==="work")await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.environmentWorkId','other') WHERE id='interrupt'");
 if(kind==="generation")await f.sql.exec("UPDATE managed_environment_work SET claim_generation=3");
 if(kind==="holder")await f.sql.exec("UPDATE managed_environment_work SET claim_worker_id='new'");
 if(kind==="ttl")await f.sql.exec("UPDATE managed_environment_work SET claim_at=0");
 if(kind==="root")await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.source_position.execution_id','other') WHERE id='start'");
 if(kind==="thread")await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.sessionThreadId','child') WHERE id='interrupt'");
 await new SqlWorkOutcomeInterrupt(f.sql).settle({...scope,...(kind==="workspace"?{workspaceId:"foreign"}:kind==="session"?{sessionId:"other"}:{})});expect(await f.ends()).toEqual([]);expect((await f.saved()).outcomeEvaluations[0].result).toBe("evaluating");
});
it("does not fabricate completion for a definition without start",async()=>{const f=await fixture();await f.sql.exec("DELETE FROM managed_session_events WHERE id='start'");await f.settle();expect(await f.ends()).toEqual([]);});
it("does not overwrite an already closed iteration or a later start",async()=>{
 for(const later of [false,true]){const f=await fixture();await f.add(later?{id:"later",type:"span.outcome_evaluation_start",outcomeId:"o",iteration:2}:{id:"done",type:"span.outcome_evaluation_end",outcomeId:"o",iteration:1,outcomeEvaluationStartId:"start",result:"satisfied"},5,{execution_id:"turn",environment_work:{workId:"w",generation:2}});await f.sql.exec("UPDATE managed_sessions SET revision=5");await f.settle();expect((await f.ends()).filter(e=>e.result==="interrupted")).toEqual([]);}
});
it("old Work interrupt does not close a successor Work evaluation or reset session status",async()=>{
 const f=await fixture();await f.sql.exec("UPDATE managed_sessions SET document=json_set(document,'$.status','running','$.outcomeEvaluations[0].iteration',2),revision=6");
 await f.add({id:"new-start",type:"span.outcome_evaluation_start",outcomeId:"o",iteration:2},6,{execution_id:"new-root",environment_work:{workId:"new-work",generation:1}});
 await f.settle();expect(await f.ends()).toEqual([]);expect((await f.saved()).status).toBe("running");
});
it("raw evidence/CAS race rolls back inserted end and aggregate together",async()=>{
 const f=await fixture();const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>f.sql.batchChecked!([...ss.slice(0,-1),f.sql.prepare("UPDATE managed_sessions SET revision=revision+1"),ss.at(-1)!],rows=>validate([...rows.slice(0,-2),rows.at(-1)!]))};
 await expect(new SqlWorkOutcomeInterrupt(sql).settle(scope)).rejects.toThrow("changed concurrently");expect(await f.ends()).toEqual([]);expect((await f.saved()).outcomeEvaluations[0].result).toBe("evaluating");
});
const instances:Array<{dispose():Promise<void>}>=[];afterAll(async()=>{for(const instance of instances)await instance.dispose();});
it("D1 server settlement atomically writes canonical end and aggregate",async()=>{
 const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));instances.push(mf);
 const f=await fixture(new CfD1SqlClient(await mf.getD1Database("DB")));await f.settle();expect(await f.ends()).toHaveLength(1);expect((await f.saved()).outcomeEvaluations[0].result).toBe("interrupted");
});
it("does not interpret Work without bound interrupt as settlement authority",async()=>{
 const f=await fixture();await f.sql.exec("UPDATE managed_environment_work SET state='active';DELETE FROM managed_session_events WHERE id='interrupt'");await f.settle();expect(await f.ends()).toEqual([]);
});
it("rejects root evidence changed between selection and transaction even without a revision bump",async()=>{
 const f=await fixture();let first=true;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{if(first){first=false;await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.source_position.consumption_claim.holder','foreign') WHERE id='root'");}return f.sql.batchChecked!(ss,validate);}};
 await new SqlWorkOutcomeInterrupt(sql).settle(scope);expect(await f.ends()).toEqual([]);
});
it("settles scoped child interrupt using canonical root lane, not missing span lane",async()=>{
 const f=await fixture();await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.sessionThreadId','child') WHERE id IN ('root','interrupt')");await f.settle();expect(await f.ends()).toHaveLength(1);
});
it("can reconcile after an unknown committed response without duplicating an end",async()=>{
 const f=await fixture();let first=true;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{const rows=await f.sql.batchChecked!(ss,validate);if(first){first=false;throw Error("lost response");}return rows;}};
 await expect(new SqlWorkOutcomeInterrupt(sql).settle(scope)).rejects.toThrow("lost response");await f.settle();expect(await f.ends()).toHaveLength(1);
});
it("TTL expiring at write prevents canonical mutation despite earlier selection",async()=>{
 const f=await fixture();let first=true;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{if(first){first=false;await f.sql.exec("UPDATE managed_environment_work SET claim_at=0");}return f.sql.batchChecked!(ss,validate);}};
 await new SqlWorkOutcomeInterrupt(sql).settle(scope);expect(await f.ends()).toEqual([]);
});
it("revokes active Work and settles its evaluation in one transaction before worker teardown can clear claim",async()=>{
 const f=await fixture();await f.sql.exec("UPDATE managed_environment_work SET state='active'");
 await f.settle();expect(await f.ends()).toHaveLength(1);
 expect(await f.sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"stopping"});
});
