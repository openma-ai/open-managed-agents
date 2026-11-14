// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, afterEach } from "vitest";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionStore,
} from "@open-managed-agents/session-runtime-sql/coordination";
import { sqlClientFromDurableObjectStorage } from
  "@open-managed-agents/sql-client/adapters/cf-do";
import { sessionExecutionStoreConformance } from
  "../../packages/session-runtime-contract/test/execution-store-conformance";

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, seconds)).toISOString();

let fixtureSerial = 0;
const fixtureRunId = Date.now().toString(36);

it('broadcasts each consumed input once when canonical and local-only rows share a batch', async () => {
  await exports.default.fetch(new Request('http://localhost/health'));
  await runInDurableObject(freshDoStub(), async (instance) => {
    instance.ensureSchema();
    const sessionId = crypto.randomUUID();
    instance.setState({ ...instance.state, tenant_id: 'default', session_id: sessionId });
    const sql = new CfD1SqlClient(env.MAIN_DB);
    const inputs = ['canonical', 'local-only'].map(id => ({
      id, type: 'user.message', content: [{ type: 'text', text: id }],
    }));
    for (const input of inputs) instance.queue.enqueueQueueInput(input);
    await sql.prepare(`INSERT INTO managed_session_events (workspace_id, session_id, id, type, document, processed_at)
      VALUES (?, ?, ?, 'user.message', ?, ?)`)
      .bind('default', sessionId, inputs[0].id, JSON.stringify({ ...inputs[0], processedAt: null,
        source_position: { revision: 1, index: 0, execution_id: inputs[0].id } }), Date.parse(at(0))).run();
    const emitted: any[] = [];
    instance.broadcastEvent = event => emitted.push(event);
    const broadcastIds = await instance.consumeAcceptedInputs(inputs, inputs[0].id, at(1));
    for (const input of inputs) {
      const row = instance.queueRowForEvent(input.id);
      expect(row).not.toBeNull();
      instance.promoteQueueRow(row, broadcastIds.has(input.id));
    }
    const messages = emitted.filter(event => event.type === 'user.message');
    expect(messages.map(event => event.id)).toEqual(['canonical', 'local-only']);
    expect(messages.every(event => typeof event.processed_at === 'string')).toBe(true);
  });
});

const ownedStubs: DurableObjectStub[] = [];
afterEach(async () => {
  for (const stub of ownedStubs.splice(0)) {
    await runInDurableObject(stub, async (room, state) => {
      await room._recoveryPromise;
      await room._recoveryRun;
      await room._finalizePromise;
      await Promise.all(room._maintenanceRuns.values());
      await state.storage.deleteAlarm();
    });
  }
});

function freshDoStub(fixtureId = `case_${++fixtureSerial}`) {
  const id = `execution_store_${fixtureRunId}_${fixtureId}`;
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
  ownedStubs.push(stub);
  return stub;
}

describe("SessionExecutionStorePort on Durable Object SQLite", () => {
  it("reclaims an expired attempt and fences the stale DO incarnation", async () => {
    await runInDurableObject(freshDoStub(), async (_instance, state) => {
      const sql = sqlClientFromDurableObjectStorage(state.storage);
      await ensureSessionExecutionCoordinatorSchema(sql);
      const store = new SqlSessionExecutionStore(sql);
      await store.admit({
        execution: {
          id: "execution_01",
          workspaceId: "workspace_01",
          sessionId: "session_01",
          admittedAt: at(1),
          events: [{
            id: "event_01",
            type: "user.message",
            content: [{ type: "text", text: "run" }],
            processedAt: at(1),
          }],
        },
        policy: { maxAttempts: 2, timeoutMs: 60_000 },
      });

      const stale = await store.claim({
        ownerId: "do_incarnation_1",
        attemptId: "attempt_1",
        claimedAt: at(2),
        leaseTtlMs: 1_000,
      });
      expect(stale.type).toBe("claimed");
      if (stale.type !== "claimed") return;

      const replacement = await store.claim({
        ownerId: "do_incarnation_2",
        attemptId: "attempt_2",
        claimedAt: at(4),
        leaseTtlMs: 30_000,
      });
      expect(replacement).toMatchObject({
        type: "claimed",
        fence: { ownerId: "do_incarnation_2", generation: 2 },
      });
      await expect(store.settle({
        fence: stale.fence,
        settledAt: at(5),
        outcome: "completed",
      })).resolves.toEqual({ type: "lost" });
    });
  });
});

sessionExecutionStoreConformance("Durable Object SQLite", {
  async withStore(fixtureId, run) {
    return runInDurableObject(freshDoStub(fixtureId), async (_instance, state) => {
      const sql = sqlClientFromDurableObjectStorage(state.storage);
      await sql.exec("DROP TABLE IF EXISTS managed_session_executions");
      await ensureSessionExecutionCoordinatorSchema(sql);
      return run(new SqlSessionExecutionStore(sql));
    });
  },
});

import { CfD1SqlClient } from '@open-managed-agents/sql-client/adapters/cf-d1';
import { steeringAtomicityConformance, steeringEventSchema } from '../../packages/session-runtime-sql/test/steering-atomicity';

steeringAtomicityConformance('DO SQLite', async run => {
  await runInDurableObject(freshDoStub(), async (_instance, state) => {
    const sql = sqlClientFromDurableObjectStorage(state.storage);
    await ensureSessionExecutionCoordinatorSchema(sql);
    await steeringEventSchema(sql);
    await run(sql);
  });
});
steeringAtomicityConformance('D1 (SessionDO execution store)', async run => {
  const sql = new CfD1SqlClient(env.MAIN_DB);
  await ensureSessionExecutionCoordinatorSchema(sql);
  await steeringEventSchema(sql);
  await run(sql);
});

it('SessionDO crash after takeSteeringInputs commits cannot leave S completed but unconsumed', async () => {
  await runInDurableObject(freshDoStub(), async (instance) => {
    const sql = new CfD1SqlClient(env.MAIN_DB);
    await ensureSessionExecutionCoordinatorSchema(sql);
    await steeringEventSchema(sql);
    const workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    const store = new SqlSessionExecutionStore(sql);
    for (const [index, id] of ['Y', 'S'].entries()) {
      const event = { id, type: 'user.message', content: [{ type: 'text', text: id }], processedAt: null };
      await store.admit({ execution: { workspaceId, sessionId, id, admittedAt: at(index), events: [event] } });
      await sql.prepare(`INSERT INTO managed_session_events (workspace_id, session_id, id, type, document, processed_at)
        VALUES (?, ?, ?, 'user.message', ?, ?)`)
        .bind(workspaceId, sessionId, id, JSON.stringify({ ...event, source_position: { revision: index + 1, index: 0, execution_id: id } }), Date.parse(at(index))).run();
    }
    const claimed = await store.claim({ workspaceId, sessionId, ownerId: 'dead-do', attemptId: 'a', claimedAt: at(2), leaseTtlMs: 30_000 });
    expect(claimed.type).toBe('claimed');
    instance.setState({ ...instance.state, tenant_id: workspaceId, session_id: sessionId });
    instance._executionStore = store;
    instance._executionStoreReady = Promise.resolve();
    instance._executionFences.set('sthr_primary', claimed.fence);
    instance.processedClock.nowIso = () => at(3);
    instance.broadcastEvent = () => {};
    instance.consumeAcceptedInputs = async () => { throw new Error('injected crash before re-emit'); };
    await expect(instance.takeSteeringInputs('sthr_primary')).rejects.toThrow('injected crash');
    const restarted = new SqlSessionExecutionStore(sql);
    expect(await restarted.find({ workspaceId, executionId: 'S' })).toMatchObject({ state: 'completed' });
    const row = await sql.prepare('SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND id = ?')
      .bind(workspaceId, sessionId, 'S').first();
    expect(JSON.parse(row.document)).toMatchObject({ processedAt: at(3), source_position: { execution_id: 'S', consumed_by_execution_id: 'Y' } });
    expect(await restarted.listQueued({ workspaceId, sessionId, laneId: 'sthr_primary' })).toEqual([]);
    console.log('DO_STEER_CRASH', row.document);
  });
});
