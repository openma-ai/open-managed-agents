import {createBetterSqlite3SqlClient} from '@open-managed-agents/sql-client';
import {SqlWorkInputs} from '../../src/work-inputs';
const sql=await createBetterSqlite3SqlClient(process.argv[2]!);
const result=await new SqlWorkInputs(sql,{sourcePositionsValidated:true}).consume(JSON.parse(process.argv[3]!));
process.stdout.write(JSON.stringify(result));
