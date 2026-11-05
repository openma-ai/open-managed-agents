import { createBetterSqlite3SqlClient } from '@open-managed-agents/sql-client';
import { ensureSessionExecutionCoordinatorSchema } from '../src/coordination';
import { steeringAtomicityConformance, steeringEventSchema } from './steering-atomicity';

steeringAtomicityConformance('SQLite', async run => {
  const sql = await createBetterSqlite3SqlClient(':memory:');
  await ensureSessionExecutionCoordinatorSchema(sql);
  await steeringEventSchema(sql);
  await run(sql);
});
