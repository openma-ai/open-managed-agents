import { expect, it } from 'vitest';
import { ManagedAcpEventProjector } from '../../harness-runtime-acp/node_modules/@openma/common/dist/managed-runtime/managed-event-projector.js';
import { createBetterSqlite3SqlClient } from '@open-managed-agents/sql-client';
import { CoreCustomToolMcp, CustomToolInvocations } from '@open-managed-agents/managed-agents-application';
import { SqlCustomToolInvocations, customInvocationSchema } from '../src/custom-tool-invocations';
import { createWorkOutputAdapter } from '../../harness-runtime-acp/src/work-output-adapter';

const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'input-1'};
async function fixture() {
 const sql=await createBetterSqlite3SqlClient(':memory:');
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER);
 CREATE TABLE managed_environment_work(workspace_id TEXT,session_id TEXT,environment_id TEXT,id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER);
 INSERT INTO managed_sessions VALUES('ws','s','env',NULL);
 INSERT INTO managed_environment_work VALUES('ws','s','env','w','active',1,'owner',0,90);`);
 await sql.exec(customInvocationSchema);
 await sql.prepare('UPDATE managed_environment_work SET claim_at=?').bind(Date.now()).run();
 return {sql,core:new CustomToolInvocations(new SqlCustomToolInvocations(sql))};
}

it('projects two equal-argument MCP receipts to distinct original calls, never publishes a receipt as an external answer',async()=>{
 const {core}=await fixture();
 const mcp=new CoreCustomToolMcp(core,scope,[{name:'approve',description:'Approval',input_schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false}}]);
 const first=await mcp.callTool({name:'approve',arguments:{label:'same'}});
 const second=await mcp.callTool({name:'approve',arguments:{label:'same'}});
 const published:Record<string,unknown>[]=[];
 const bindings:Array<{receipt:string;nativeCallId:string}>=[];
 const output=createWorkOutputAdapter({
  customInvocationToolNames:()=>new Set(["mcp__oma__approve"]),
  publish:async (events,batch)=>{published.push(...events);bindings.push(...(batch??[]));},toolUseIdFor:()=>undefined,
  // This is the real Core store, not a reporter that returns a claimed marker.
  async customInvocation(call:Record<string,unknown>,result:Record<string,unknown>) {
   return mcp.prepareNativeResult(String(call.id),result.content);
  },
 });
 let sequence=0;
 const projector=new ManagedAcpEventProjector({nextEventId:()=>`event-${++sequence}`,now:()=>new Date('2026-11-13T00:00:00Z')});
 projector.startTurn('input-1');
 const project=(update:Record<string,unknown>)=>projector.project({type:'session.event',sessionId:'s',turnId:'input-1',event:update});
 for(const [id,receipt] of [['original-alpha',first],['original-beta',second]] as const) {
  output.nativeTool({toolCallId:id,name:'mcp__oma__approve'});
  await output.projected(project({sessionUpdate:'tool_call',toolCallId:id,title:'mcp__oma__approve',status:'in_progress',rawInput:{label:'same'}}));
  await output.projected(project({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:{content:receipt.content,details:{server:'oma',tool:'approve'},structuredContent:receipt.structuredContent}}));
 }
 expect(published.map(e=>[e.type,e.id,e.name])).toEqual([
  ['agent.custom_tool_use','original-alpha','approve'],['agent.custom_tool_use','original-beta','approve'],
 ]);
 expect(bindings).toEqual([{receipt:first.structuredContent.omaCustomInvocation.receipt,nativeCallId:'original-alpha'},{receipt:second.structuredContent.omaCustomInvocation.receipt,nativeCallId:'original-beta'}]);
 expect((await core.read(scope,first.structuredContent.omaCustomInvocation.receipt)).nativeCallId).toBeNull();
 expect((await core.read(scope,second.structuredContent.omaCustomInvocation.receipt)).nativeCallId).toBeNull();
});

it('keeps receipt/native identity one-to-one, first result immutable, and cancellation terminal',async()=>{
 const {core}=await fixture();
 const first=await core.begin(scope,{name:'approve'},{label:'same'});
 const second=await core.begin(scope,{name:'approve'},{label:'same'});
 expect(first.receipt).not.toBe(second.receipt);
 await expect(core.resolve(scope,first.receipt,'original',{content:[],isError:false})).rejects.toThrow();
 await core.bind(scope,first.receipt,'original');
 await expect(core.bind(scope,second.receipt,'original')).rejects.toThrow();
 await expect(core.bind(scope,first.receipt,'different')).rejects.toThrow();
 const result={content:[{type:'text',text:'answer'}],isError:false};
 await expect(core.resolve(scope,first.receipt,'different',result)).rejects.toThrow();
 await core.resolve(scope,first.receipt,'original',result);
 await core.resolve(scope,first.receipt,'original',result);
 await expect(core.resolve(scope,first.receipt,'original',{content:[],isError:true})).rejects.toThrow();
 await core.cancel(scope,second.receipt);
 await expect(core.bind(scope,second.receipt,'later')).rejects.toThrow();
 expect((await core.read(scope,first.receipt)).result).toEqual(result);
 const cancelled=await core.begin(scope,{name:'approve'},{});
 await core.bind(scope,cancelled.receipt,'cancelled-call');
 await core.cancel(scope,cancelled.receipt);
 await expect(core.bind(scope,cancelled.receipt,'cancelled-call')).rejects.toThrow();
});

it('fences stale owners and expired leases at the database mutation, including after the initial read',async()=>{
 const {core,sql}=await fixture();
 const invocation=await core.begin(scope,{name:'approve'},{});
 const store=new SqlCustomToolInvocations(sql);
 const before=(await store.read(scope,invocation.receipt))!;
 await sql.exec('UPDATE managed_environment_work SET claim_generation=2');
 expect(await store.replace(scope,before,{...before,state:'cancelled',revision:2})).toBe(false);
 await expect(core.bind(scope,invocation.receipt,'old-owner')).rejects.toThrow();
 const successor={...scope,generation:2};
 expect((await core.bind(successor,invocation.receipt,'new-owner')).nativeCallId).toBe('new-owner');
 await sql.exec('UPDATE managed_environment_work SET claim_at=0');
 await expect(core.cancel(successor,invocation.receipt)).rejects.toThrow();
});

it('rejects a canonical revision race after production inspection and before invocation creation',async()=>{
 const {sql,core}=await fixture();
 await sql.exec('ALTER TABLE managed_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 3');
 const inspected={...scope,canonicalRevision:3};
 await sql.exec('UPDATE managed_sessions SET revision=4');
 await expect(core.begin(inspected,{name:'approve'},{})).rejects.toThrow();
 expect((await sql.prepare('SELECT count(*) AS n FROM managed_custom_invocations').first<{n:number}>())?.n).toBe(0);
});
