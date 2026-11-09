import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@open-managed-agents/sql-client';
import { takeQueuedSteeringInputs } from '@open-managed-agents/session-runtime-contract/coordination';
import { decodeSessionEventDocument, encodeSessionEventDocument } from '@open-managed-agents/session-runtime-contract/history';
import { SqlSessionExecutionStore } from '../src/coordination';

/** Same failure points on every transactional adapter, including D1/DO. */
export function steeringAtomicityConformance(name: string, withClient: (run: (sql: SqlClient) => Promise<void>) => Promise<void>) {
  describe(`atomic steering: ${name}`, () => {
    for (const mode of ['commit', 'rollback', 'expired', 'racing', 'changed-document', 'preconsumed'] as const) it(mode, () => withClient(async sql => {
      const workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
      const at = (n: number) => new Date(100000 + n * 1000).toISOString();
      const store = new SqlSessionExecutionStore(sql);
      const message = (id: string) => ({ id, type: 'user.message' as const, processedAt: null, content: [{ type: 'text' as const, text: id }] });
      for (const [index, id] of ['Y', 'S', 'S2'].entries()) {
        await store.admit({ execution: { workspaceId, sessionId, id, admittedAt: at(index), events: [message(id)] } });
        await sql.prepare(`INSERT INTO managed_session_events (workspace_id, session_id, id, type, document, processed_at)
          VALUES (?, ?, ?, 'user.message', ?, ?)`)
          .bind(workspaceId, sessionId, id, encodeSessionEventDocument(message(id), { revision: index + 1, index: 0 }, id), 100000 + index * 1000).run();
      }
      const claimed = await store.claim({ workspaceId, sessionId, ownerId: 'host', attemptId: 'attempt', claimedAt: at(3), leaseTtlMs: 2000 });
      if (claimed.type !== 'claimed') throw new Error('expected Y');
      const input = { workspaceId, sessionId, executionId: 'S', steeredAt: at(mode === 'expired' ? 6 : 4), consumer: claimed.fence };
      const read = async (id = 'S') => decodeSessionEventDocument((await sql.prepare(`SELECT document FROM managed_session_events
        WHERE workspace_id = ? AND session_id = ? AND id = ?`).bind(workspaceId, sessionId, id).first<{ document: string }>())!.document);
      if (mode === 'preconsumed') {
        // A shared system/input fact may already have been consumed by this
        // execution. Keep both its original document and sort timestamp.
        await sql.prepare('UPDATE managed_session_events SET document = ?, processed_at = ? WHERE workspace_id = ? AND session_id = ? AND id = ?')
          .bind(encodeSessionEventDocument({ ...message('S'), processedAt: at(1) }, { revision: 2, index: 0 }, 'S', 'Y'), 101000, workspaceId, sessionId, 'S').run();
      }
      if (mode === 'rollback') {
        const broken: SqlClient = { prepare: s => sql.prepare(s), exec: s => sql.exec(s), batch: statements => sql.batch([
          ...statements, sql.prepare('INSERT INTO oma_intentionally_missing_table VALUES (1)'),
        ]) };
        await expect(new SqlSessionExecutionStore(broken).steerQueued(input)).rejects.toBeDefined();
        expect(await store.find({ workspaceId, executionId: 'S' })).toMatchObject({ state: 'queued' });
        expect((await read()).consumedByExecutionId).toBeUndefined();
      }
      if (mode === 'changed-document') {
        // Change a source fact after the optimistic reads, before the batch.
        const competing: SqlClient = { prepare: s => sql.prepare(s), exec: s => sql.exec(s), batch: async statements => {
          await sql.prepare('UPDATE managed_session_events SET document = ? WHERE workspace_id = ? AND session_id = ? AND id = ?')
            .bind(encodeSessionEventDocument({ ...message('S'), processedAt: at(4) }, { revision: 2, index: 0 }, 'S', 'other'), workspaceId, sessionId, 'S').run();
          return sql.batch(statements);
        } };
        expect(await new SqlSessionExecutionStore(competing).steerQueued(input)).toEqual({ type: 'not_queued' });
        expect(await store.find({ workspaceId, executionId: 'S' })).toMatchObject({ state: 'queued' });
        expect((await read()).consumedByExecutionId).toBe('other');
        return;
      }
      const results = mode === 'racing'
        ? await Promise.all([store.steerQueued(input), new SqlSessionExecutionStore(sql).steerQueued(input)])
        : [await store.steerQueued(input)];
      if (mode === 'expired') {
        expect(results[0].type).toBe('not_queued');
        expect(await store.find({ workspaceId, executionId: 'S' })).toMatchObject({ state: 'queued' });
        expect((await read()).consumedByExecutionId).toBeUndefined();
      } else {
        expect(results.filter(result => result.type === 'steered')).toHaveLength(1);
        const delivered = results.find(result => result.type === 'steered');
        if (delivered?.type !== 'steered') throw new Error('expected delivery');
        // The live harness must see the same consumed stamp as recovery does;
        // explicit null is excluded from model context, not a consumed input.
        expect(delivered.execution.events).toMatchObject([{ id: 'S', processedAt: at(mode === 'preconsumed' ? 1 : 4) }]);
        expect(await read()).toMatchObject({ executionId: 'S', consumedByExecutionId: 'Y', event: { processedAt: at(mode === 'preconsumed' ? 1 : 4) } });
        if (mode === 'preconsumed') expect(Number((await sql.prepare('SELECT processed_at FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND id = ?').bind(workspaceId, sessionId, 'S').first<{ processed_at: number }>())!.processed_at)).toBe(101000);
        expect(await store.find({ workspaceId, executionId: 'S' })).toMatchObject({ state: 'completed' });
        // Reconstruct the adapter and discard the original returned inputs.
        const restarted = new SqlSessionExecutionStore(sql);
        expect(await restarted.steerQueued(input)).toEqual({ type: 'not_queued' });
        expect(await takeQueuedSteeringInputs(restarted, { ...input, laneId: 'sthr_primary' })).toMatchObject([{ id: 'S2' }]);
        expect((await read('S2')).consumedByExecutionId).toBe('Y');
      }
      console.log('ATOMIC_STEER', JSON.stringify({ adapter: name, mode, results: results.map(r => r.type), S: await read() }));
    }));
  });
}

export async function steeringEventSchema(sql: SqlClient) {
  await sql.exec(`CREATE TABLE IF NOT EXISTS managed_session_events (
    workspace_id VARCHAR(191), session_id VARCHAR(191), id VARCHAR(191), type VARCHAR(191), document TEXT NOT NULL, processed_at BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, session_id, id))`);
}
