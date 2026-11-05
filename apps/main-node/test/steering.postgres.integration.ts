import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { beforeAll, afterAll } from 'vitest';
import { openNodeDatabase } from '../src/database';
import { ensureSessionExecutionClaimLockSchema } from '@open-managed-agents/session-runtime-sql/coordination';
import { steeringAtomicityConformance } from '../../../packages/session-runtime-sql/test/steering-atomicity';

let container: StartedPostgreSqlContainer | undefined;
let database: Awaited<ReturnType<typeof openNodeDatabase>>;
beforeAll(async () => {
  const configured = process.env.OMA_TEST_POSTGRES_URL;
  if (!configured) container = await new PostgreSqlContainer('postgres:16-alpine').start();
  database = await openNodeDatabase({ kind: 'postgres', url: configured ?? container!.getConnectionUri() });
  await ensureSessionExecutionClaimLockSchema(database.sql, 'postgres');
}, 180_000);
afterAll(async () => { await database?.stop?.(); await container?.stop(); }, 60_000);
steeringAtomicityConformance('postgres', async run => { await run(database.sql); });
