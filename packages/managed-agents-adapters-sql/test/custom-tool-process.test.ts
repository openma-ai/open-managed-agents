import { expect,it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, URL } from 'node:url';
import { createBetterSqlite3SqlClient } from '@open-managed-agents/sql-client';
import { customInvocationSchema } from '../src/custom-tool-invocations';
const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'input-1'};

it('recovers two pending original-call associations after SIGKILL, accepts external results out of order, and fences the old process',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pr545-core-restart-'));
 const database=join(directory,'state.sqlite');
 const sql=await createBetterSqlite3SqlClient(database);
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER);
 CREATE TABLE managed_environment_work(workspace_id TEXT,session_id TEXT,environment_id TEXT,id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER);
 INSERT INTO managed_sessions VALUES('ws','s','env',NULL);
 INSERT INTO managed_environment_work VALUES('ws','s','env','w','active',1,'owner',0,90);`);
 await sql.exec(customInvocationSchema);
 await sql.prepare('UPDATE managed_environment_work SET claim_at=?').bind(Date.now()).run();
 const children:ReturnType<typeof launch>[]=[];
 function launch() {
  const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../../../node_modules/.pnpm/node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./fixtures/custom-invocation-process.ts',import.meta.url)),database],{stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const lines=createInterface({input:child.stdout});
  const queue=lines[Symbol.asyncIterator]();
  return {child,async call(request:Record<string,unknown>) {
   child.stdin.write(JSON.stringify(request)+'\n');
   const response=await queue.next();
   if(response.done)throw Error('Core child exited: '+stderr);
   return JSON.parse(response.value);
  }};
 }
 try {
  const first=launch();children.push(first);
  const a=(await first.call({operation:'begin',scope})).data;
  const b=(await first.call({operation:'begin',scope})).data;
  expect(a.receipt).not.toBe(b.receipt);
  expect((await first.call({operation:'bind',scope,receipt:a.receipt,callId:'native-a'})).data.state).toBe('pending');
  expect((await first.call({operation:'bind',scope,receipt:b.receipt,callId:'native-b'})).data.state).toBe('pending');
  const exited=once(first.child,'exit');first.child.kill('SIGKILL');await exited;
  await sql.exec("UPDATE managed_environment_work SET claim_generation=2,claim_worker_id='successor'");
  const successor={...scope,generation:2,holder:'successor'};
  const second=launch();children.push(second);
  expect((await second.call({operation:'read',scope,receipt:a.receipt})).error).toContain('fenced');
  for(const [invocation,callId,text] of [[b,'native-b','second answer'],[a,'native-a','first answer']] as const) {
   expect((await second.call({operation:'read',scope:successor,receipt:invocation.receipt})).data).toMatchObject({nativeCallId:callId,state:'pending'});
   expect((await second.call({operation:'resolve',scope:successor,receipt:invocation.receipt,callId,result:{content:[{type:'text',text}],isError:false}})).data.state).toBe('resolved');
  }
  const rows=await sql.prepare('SELECT native_call_id,document FROM managed_custom_invocations ORDER BY native_call_id').all<{native_call_id:string;document:string}>();
  expect(rows.results?.map(row=>[row.native_call_id,JSON.parse(row.document).result.content[0].text])).toEqual([['native-a','first answer'],['native-b','second answer']]);
  expect(rows.results).toHaveLength(2);
 } finally {for(const {child} of children) if(child.exitCode===null&&child.signalCode===null) {const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
},15000);
