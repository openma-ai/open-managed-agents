import { expect,it } from 'vitest';
import {readFile} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CfD1SqlClient } from '@open-managed-agents/sql-client/adapters/cf-d1';
import { CustomToolInvocations } from '@open-managed-agents/managed-agents-application';
import { SqlCustomToolInvocations } from '../src/custom-tool-invocations';
const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');

it('keeps Core receipts fenced and cancellation durable on actual local Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('unused')}}",compatibilityDate:'2026-11-01',d1Databases:['DB']}));
 try {
  const sql=new CfD1SqlClient(await mf.getD1Database('DB'));
  await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER);
  CREATE TABLE managed_environment_work(workspace_id TEXT,session_id TEXT,environment_id TEXT,id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER);
  INSERT INTO managed_sessions VALUES('ws','s','env',NULL);
  INSERT INTO managed_environment_work VALUES('ws','s','env','w','active',1,'owner',0,90);`);
  // D1 exec expects each statement on a line; use the prepared DDL normally.
 const migrationPath=resolve(dirname(fileURLToPath(import.meta.url)),'../../../apps/main/migrations/0032_custom_invocations.sql');
 for(const statement of (await readFile(migrationPath,'utf8')).split('--> statement-breakpoint'))await sql.prepare(statement).run();
  await sql.prepare('UPDATE managed_environment_work SET claim_at=?').bind(Date.now()).run();
  const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'input-1'};
  const core=new CustomToolInvocations(new SqlCustomToolInvocations(sql));
  const a=await core.begin(scope,{name:'approve'},{});
  await core.bind(scope,a.receipt,'original');
  const before=await core.read(scope,a.receipt);
  for(const mutation of ["claim_worker_id='OWNER'",'claim_at=0','claim_generation=2']){
   await sql.exec('UPDATE managed_environment_work SET '+mutation);
   expect(await new SqlCustomToolInvocations(sql).replace(scope,before,{...before,state:'cancelled',revision:before.revision+1}),mutation).toBe(false);
   await sql.prepare("UPDATE managed_environment_work SET claim_worker_id='owner',claim_generation=1,claim_at=?").bind(Date.now()).run();
  }
  const other=await core.begin(scope,{name:'approve'},{});expect(other.receipt).not.toBe(a.receipt);
  await expect(core.bind(scope,other.receipt,'original')).rejects.toThrow();
  await core.bind(scope,other.receipt,'second');
  const secondBefore=await core.read(scope,other.receipt);
  const answer={content:[{type:'text' as const,text:'approved'}],isError:false};
  await core.resolve(scope,other.receipt,'second',answer);
  expect(await new SqlCustomToolInvocations(sql).replace(scope,secondBefore,{...secondBefore,state:'cancelled',revision:secondBefore.revision+1})).toBe(false);
  const restarted=new CustomToolInvocations(new SqlCustomToolInvocations(new CfD1SqlClient(await mf.getD1Database('DB'))));
  expect((await restarted.read(scope,other.receipt)).result).toEqual(answer);
  await restarted.resolve(scope,other.receipt,'second',answer);
  await sql.prepare('UPDATE managed_environment_work SET claim_generation=2').run();
  expect(await new SqlCustomToolInvocations(sql).replace(scope,before,{...before,state:'cancelled',revision:before.revision+1})).toBe(false);
  await expect(core.cancel(scope,a.receipt)).rejects.toThrow();
  const successor={...scope,generation:2};
  await core.cancel(successor,a.receipt);
  const recreated=new CustomToolInvocations(new SqlCustomToolInvocations(sql));
  expect((await recreated.read(successor,a.receipt)).state).toBe('cancelled');
  await expect(recreated.resolve(successor,a.receipt,'original',{content:[],isError:false})).rejects.toThrow();
 } finally {await mf.dispose();}
},20000);
