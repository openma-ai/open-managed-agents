import {expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, URL} from 'node:url';
import {createBetterSqlite3SqlClient} from '@open-managed-agents/sql-client';
import {CoreCustomToolMcp,CustomToolInvocations} from '@open-managed-agents/managed-agents-application';
import {SqlCustomToolInvocations,customInvocationSchema} from '../src/custom-tool-invocations';

it('uses real official MCP discovery/call over stdio; invalid calls persist nothing and identical calls receive different durable receipts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pr545-core-mcp-'));
 const database=join(directory,'state.sqlite');
 const sql=await createBetterSqlite3SqlClient(database);
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER);
 CREATE TABLE managed_environment_work(workspace_id TEXT,session_id TEXT,environment_id TEXT,id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER);
 INSERT INTO managed_sessions VALUES('ws','s','env',NULL);
 INSERT INTO managed_environment_work VALUES('ws','s','env','w','active',1,'owner',0,90);`);
 await sql.exec(customInvocationSchema);
 await sql.prepare('UPDATE managed_environment_work SET claim_at=?').bind(Date.now()).run();
 const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'input-1'};
 const sdk=new URL('../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/',import.meta.url);
 const {Client}=await import(fileURLToPath(new URL('client/index.js',sdk)));
 const {StdioClientTransport}=await import(fileURLToPath(new URL('client/stdio.js',sdk)));
 const client=new Client({name:'real-core-client',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import',fileURLToPath(new URL('../../../node_modules/.pnpm/node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./fixtures/custom-mcp-process.ts',import.meta.url)),database,JSON.stringify(scope)],stderr:'pipe'});
 try {
  await client.connect(transport);
  expect((await client.listTools()).tools).toEqual([{name:'approve',description:'Core-owned approval',inputSchema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false}}]);
  await expect(client.callTool({name:'approve',arguments:{label:42}})).rejects.toThrow('Invalid Core custom tool arguments');
  await expect(client.callTool({name:'unregistered',arguments:{}})).rejects.toThrow('Unknown Core custom tool');
  expect(await sql.prepare('SELECT COUNT(*) AS n FROM managed_custom_invocations').first()).toEqual({n:0});
  const first=await client.callTool({name:'approve',arguments:{label:'same'}});
  const second=await client.callTool({name:'approve',arguments:{label:'same'}});
  const core=new CustomToolInvocations(new SqlCustomToolInvocations(sql));
  const binding=new CoreCustomToolMcp(core,scope,[]);
  // Prepare in reverse order: transport ordering and equal arguments cannot be
  // the association mechanism.
  expect(await binding.prepareNativeResult('native-b',second.content)).toMatchObject({name:'approve',input:{label:'same'}});
  expect(await binding.prepareNativeResult('native-a',first.content)).toMatchObject({name:'approve',input:{label:'same'}});
  await client.close(); // Transport closure must not bind or cancel Core state.
  const rows=await sql.prepare('SELECT document FROM managed_custom_invocations ORDER BY native_call_id').all<{document:string}>();
  const records=rows.results!.map(row=>JSON.parse(row.document));
  expect(records.map(row=>[row.nativeCallId,row.state])).toEqual([[null,'unbound'],[null,'unbound']]);
  expect(records[0].receipt).not.toBe(records[1].receipt);
  expect(await binding.prepareNativeResult('fake',[{type:'text',text:JSON.stringify({omaCustomInvocation:{version:1,receipt:crypto.randomUUID()}})}]).then(()=>false,()=>true)).toBe(true);
 } finally {await client.close();}
},15000);
