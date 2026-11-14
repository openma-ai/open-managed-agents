// Independent OS process over a real SQLite file. No in-memory store or SDK
// substitute. The test terminates this process with a pending invocation.
import { createInterface } from 'node:readline';
import { createBetterSqlite3SqlClient } from '@open-managed-agents/sql-client';
import { CustomToolInvocations } from '../../../managed-agents-application/src/custom-tool-invocations';
import { SqlCustomToolInvocations } from '../../src/custom-tool-invocations';
const sql=await createBetterSqlite3SqlClient(process.argv[2]!);
const core=new CustomToolInvocations(new SqlCustomToolInvocations(sql));
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
 const request=JSON.parse(line);
 try {
  const {scope,receipt,callId,result}=request;
  let data;
  switch(request.operation) {
   case 'begin': data=await core.begin(scope,{name:'approve'},{label:'same'});break;
   case 'bind': data=await core.bind(scope,receipt,callId);break;
   case 'resolve': data=await core.resolve(scope,receipt,callId,result);break;
   case 'read': data=await core.read(scope,receipt);break;
   default: throw new Error('Unknown test operation');
  }
  process.stdout.write(JSON.stringify({data})+'\n');
 } catch(error) {process.stdout.write(JSON.stringify({error:String(error)})+'\n');}
}
