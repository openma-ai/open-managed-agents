import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { beforeAll, afterAll } from 'vitest';
import { openNodeDatabase } from '../src/database';
import { ensureSessionExecutionClaimLockSchema } from '@open-managed-agents/session-runtime-sql/coordination';
import { steeringAtomicityConformance } from '../../../packages/session-runtime-sql/test/steering-atomicity';

let container: StartedMySqlContainer | undefined;
let database: Awaited<ReturnType<typeof openNodeDatabase>>;
beforeAll(async () => {
  const configured = process.env.OMA_TEST_MYSQL_URL;
  if (!configured) container = await new MySqlContainer('mysql:8.4').start();
  database = await openNodeDatabase({ kind: 'mysql', url: configured ?? container!.getConnectionUri() });
  await ensureSessionExecutionClaimLockSchema(database.sql, 'mysql');
}, 180_000);
afterAll(async () => { await database?.stop?.(); await container?.stop(); }, 60_000);
steeringAtomicityConformance('mysql', async run => { await run(database.sql); });
