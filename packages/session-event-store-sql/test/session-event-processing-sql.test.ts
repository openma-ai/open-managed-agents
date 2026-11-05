import { beforeEach, describe, expect, it } from "vitest";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { sessionEventSortTime } from "@open-managed-agents/session-event-store";
import type { SentSessionEvent } from "@open-managed-agents/domain/sessions";

import { consumeSessionInputs, takeQueuedSteeringInputs } from '../../session-runtime-contract/src/coordination';
import { decodeSessionEventDocument } from '../../session-runtime-contract/src/history';
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from '../../session-runtime-sql/src/coordination';
import { SqlSessionRuntimeHistorySource } from '../../session-runtime-sql/src/history';
import { SqlSessionStore } from '../../session-store-sql/src/index';
import { SqlSessionEventStore } from "../src/index";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL,
  revision integer NOT NULL, status text, updated_at integer,
  agent_id text, agent_version integer, environment_id text, deployment_id text, created_at integer, archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_session_initial_events (workspace_id text, session_id text, sequence integer, document text, PRIMARY KEY(workspace_id,session_id,sequence));
CREATE TABLE managed_session_events (
  workspace_id text NOT NULL, session_id text NOT NULL, thread_id text,
  id text NOT NULL, type text NOT NULL, document text NOT NULL,
  processed_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, id)
);
`;

const session = (updatedAt: string) => ({
  id: "session_01", environmentId: "env_01", status: "running", updatedAt,
}) as never;

describe("SqlSessionEventStore queued input processing", () => {
  let client: SqlClient;
  let store: SqlSessionEventStore;
  let revision = 1;

  async function append(events: SentSessionEvent[], acceptedAt: string) {
    const result = await store.append({
      workspaceId: "w", sessionId: "session_01", expectedRevision: revision,
      events, nextSession: session(acceptedAt),
    });
    expect(result.type).toBe("appended");
    revision += 1;
  }

  async function list() {
    return store.list({ workspaceId: "w", sessionId: "session_01", limit: 20, order: "asc" });
  }

  beforeEach(async () => {
    revision = 1;
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    await client.prepare(
      "INSERT INTO managed_sessions (workspace_id,id,document,revision,status,updated_at) VALUES ('w', 'session_01', '{}', 1, 'running', 0)",
    ).run();
    store = new SqlSessionEventStore(client);
  });

  it("keeps a queued input null at its acceptance position, then stamps and repositions it once", async () => {
    await append([{ id: "q1", type: "user.message", content: [{ type: "text", text: "queued" }], processedAt: null }],
      "2026-08-26T01:00:00.000Z");
    await append([{ id: "r1", type: "user.tool_result", toolUseId: "t", processedAt: "2026-08-26T02:00:00.000Z" }],
      "2026-08-26T02:00:00.000Z");

    const before = await list();
    expect(before.map((event) => [event.id, event.processedAt])).toEqual([["q1", null], ["r1", "2026-08-26T02:00:00.000Z"]]);
    expect(sessionEventSortTime(before[0]!)).toBe("2026-08-26T01:00:00.000Z");

    const marked = await store.markProcessed({
      workspaceId: "w", sessionId: "session_01", eventIds: ["q1", "missing"],
      processedAt: "2026-08-26T03:00:00.000Z",
    });
    expect(marked).toEqual([{ id: "q1", type: "user.message", content: [{ type: "text", text: "queued" }],
      processedAt: "2026-08-26T03:00:00.000Z" }]);

    const after = await list();
    expect(after.map((event) => [event.id, event.processedAt])).toEqual([
      ["r1", "2026-08-26T02:00:00.000Z"], ["q1", "2026-08-26T03:00:00.000Z"],
    ]);

    // Idempotent: a second stamp keeps the first processing time.
    const again = await store.markProcessed({
      workspaceId: "w", sessionId: "session_01", eventIds: ["q1"],
      processedAt: "2026-08-26T04:00:00.000Z",
    });
    expect(again[0]?.processedAt).toBe("2026-08-26T03:00:00.000Z");
  });
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 0, 0, seconds)).toISOString();
  const message = (id: string): SentSessionEvent => ({ id, type: 'user.message', content: [{ type: 'text', text: id }], processedAt: null });
  async function facts(id: string) {
    const row = await client.prepare('SELECT document FROM managed_session_events WHERE id = ?').bind(id).first<{ document: string }>();
    return decodeSessionEventDocument(row!.document);
  }
  async function coordinated() {
    await ensureSessionExecutionCoordinatorSchema(client);
    store = new SqlSessionEventStore(client, { executionOutbox: true });
    return new SqlSessionExecutionStore(client);
  }
  async function consume(inputs: readonly { id: string }[], consumer: string, stamp = at(10)) {
    return consumeSessionInputs(store, { workspaceId: 'w', sessionId: 'session_01', inputs, consumingExecutionId: consumer, processedAt: stamp }, events => {
      for (const event of events) expect(event).not.toHaveProperty('source_position');
    });
  }
  it('B1 atomically binds every batch input to its lane execution and losing appends leave no rows', async () => {
    const coordinator = await coordinated();
    await append([{ id: 'D', type: 'user.define_outcome', description: 'goal', rubric: 'ok', maxIterations: 1, outcomeId: 'o', processedAt: at(1) }, message('M'), { ...message('C'), sessionThreadId: 'child' }], at(1));
    expect(await facts('D')).toMatchObject({ executionId: 'D' });
    expect(await facts('M')).toMatchObject({ executionId: 'D' });
    expect(await facts('C')).toMatchObject({ executionId: 'C' });
    expect(await coordinator.find({ workspaceId: 'w', executionId: 'D' })).toMatchObject({ events: [{ id: 'D' }, { id: 'M' }] });
    const lost = await store.append({ workspaceId: 'w', sessionId: 'session_01', expectedRevision: 1, events: [message('lost')], nextSession: session(at(2)) });
    expect(lost.type).toBe('revision_conflict');
    expect(await coordinator.find({ workspaceId: 'w', executionId: 'lost' })).toBeNull();
    expect(await store.list({ workspaceId: 'w', sessionId: 'session_01', eventIds: ['lost'], limit: 10, order: 'asc' })).toEqual([]);
  });
  it('B2 CAS keeps the winning processing time and consumer together under competing consumers', async () => {
    await coordinated();
    await append([message('X')], at(1));
    await Promise.all([consume([message('X')], 'Y', at(2)), consume([message('X')], 'X', at(3))]);
    const decoded = await facts('X');
    expect(decoded.executionId).toBe('X');
    expect([[at(2), 'Y'], [at(3), 'X']]).toContainEqual([decoded.event.processedAt, decoded.consumedByExecutionId]);
    await consume([message('X')], 'other', at(4));
    expect(await facts('X')).toEqual(decoded);
  });
  it('held and after-call inputs are stamped with the actual absorbing execution', async () => {
    const coordinator = await coordinated();
    await append([message('Y')], at(1));
    const y = await coordinator.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'host', attemptId: 'a1', claimedAt: at(2), leaseTtlMs: 30000 });
    if (y.type !== 'claimed') throw new Error('expected Y');
    await consume(y.execution.events, y.execution.id, at(2));
    await append([message('S')], at(3));
    const steering = await takeQueuedSteeringInputs(coordinator, { workspaceId: 'w', sessionId: 'session_01', laneId: 'sthr_primary', steeredAt: at(4), consumer: y.fence });
    await consume(steering, 'Y', at(4));
    expect(await facts('S')).toMatchObject({ executionId: 'S', consumedByExecutionId: 'Y' });
    await append([message('H')], at(5));
    await coordinator.settle({ fence: y.fence, settledAt: at(6), outcome: 'failed', holdQueuedOnLane: true });
    expect((await facts('H')).consumedByExecutionId).toBeUndefined();
    await append([message('X')], at(7));
    const x = await coordinator.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'host', attemptId: 'a2', claimedAt: at(8), leaseTtlMs: 30000 });
    if (x.type !== 'claimed') throw new Error('expected X');
    expect(x.execution.events.map(e => e.id)).toEqual(['H', 'X']);
    await consume(x.execution.events, x.execution.id, at(8));
    expect(await facts('H')).toMatchObject({ executionId: 'H', consumedByExecutionId: 'X', event: { processedAt: at(8) } });
    expect(await facts('X')).toMatchObject({ executionId: 'X', consumedByExecutionId: 'X' });
  });
  it('bootstrap stores B1 with its outbox and stamps B2 in the existing initial-event rows', async () => {
    await coordinated();
    await new SqlSessionStore(client, { seal: async value => value }, { executionOutbox: true }).insert({
      workspaceId: 'w', resourceSecrets: [],
      session: { id: 'boot', agent: { id: 'a', version: 1 }, environmentId: 'env', resources: [], createdAt: at(1), updatedAt: at(1), archivedAt: null, status: 'idle' } as never,
      initialEvents: [{ type: 'user.define_outcome', description: 'goal', rubric: 'ok', maxIterations: 1 }, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
    });
    const history = new SqlSessionRuntimeHistorySource(client);
    const before = await history.load({ workspaceId: 'w', sessionId: 'boot' });
    expect(before!.orderedInitialEvents).toMatchObject([{ executionId: 'bootstrap_boot:0' }, { executionId: 'bootstrap_boot:0' }]);
    expect(JSON.stringify(before!.initialEvents)).not.toContain('source_position');
    const emitted: unknown[] = [];
    await consumeSessionInputs(store, { workspaceId: 'w', sessionId: 'boot', inputs: [{ id: 'bootstrap_boot:0' }, { id: 'bootstrap_boot:1' }], consumingExecutionId: 'bootstrap_boot:0', processedAt: at(2) }, events => { emitted.push(...events); });
    expect(emitted).toHaveLength(2);
    const after = await history.load({ workspaceId: 'w', sessionId: 'boot' });
    expect(after!.orderedInitialEvents).toMatchObject([{ consumedByExecutionId: 'bootstrap_boot:0', event: { processedAt: at(2) } }, { consumedByExecutionId: 'bootstrap_boot:0', event: { processedAt: at(2) } }]);
    expect(JSON.stringify(after!.initialEvents)).not.toContain('consumed_by_execution_id');
  });

  // SQL-level crash injection: abandon all returned inputs after coordinator
  // mutation and reconstruct the coordinator/store from the durable database.
  // No graceful settle or consume is performed at the fault point.
  async function pollPersistedHistory(before: any, after: any) {
    const { createSessionsHandler } = await import('../../openai-agents-compat/src/sessions');
    const { normalizeAgentConfig } = await import('../../openai-agents-compat/src/resources');
    const controller = new AbortController();
    let loads = 0;
    let snapshot = false;
    const base: any = { id: 'session_01', object: 'agent.session', created_at: 1, last_active_at: 1,
      agent: { ...normalizeAgentConfig({ model: 'test' }), id: 'agent' }, environment: { type: 'none' },
      status: 'idle', error: null, metadata: {}, required_actions: [], usage: null, vault_ids: [] };
    const handler = createSessionsHandler({ workspaceId: 'w', pollMs: 0,
      sessions: { retrieveSession: async () => ({ type: 'found', session: { id: 'session_01', createdAt: at(0) } }) } as any,
      sessionEvents: {} as any, mapping: { sessionView: async () => base } as any,
      history: { loadSessionRuntimeHistory: async () => {
        const selected = snapshot || loads++ > 0 ? after : before;
        if (!snapshot && loads > 4) controller.abort();
        return { type: 'found', ...selected };
      } },
    });
    const request: any = { operation: 'sessions.events.stream', params: { session_id: 'session_01' },
      query: { order: 'asc' }, body: {}, headers: new Headers(), signal: controller.signal };
    const response = await handler.execute(request);
    const events: any[] = [];
    for await (const event of response.stream!) events.push(event);
    snapshot = true;
    const items: any = (await handler.execute({ ...request, operation: 'sessions.items.list' })).body;
    const turns: any = (await handler.execute({ ...request, operation: 'sessions.turns.list' })).body;
    expect(new Set(events.map(e => e.event_id)).size).toBe(events.length);
    return { events, items: items.data, turns: turns.data };
  }

  it('crash after claim before consume recovers the input once with snapshot/stream agreement', async () => {
    const coordinator = await coordinated();
    await append([message('X')], at(1));
    const dead = await coordinator.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'dead', attemptId: 'dead-attempt', claimedAt: at(2), leaseTtlMs: 1000 });
    expect(dead.type).toBe('claimed');
    const history = new SqlSessionRuntimeHistorySource(client);
    const before = await history.load({ workspaceId: 'w', sessionId: 'session_01' });
    // Crash: discard dead.execution.events without invoking consumeSessionInputs.
    store = new SqlSessionEventStore(client, { executionOutbox: true });
    const restarted = new SqlSessionExecutionStore(client);
    const recovered = await restarted.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'new', attemptId: 'new-attempt', claimedAt: at(5), leaseTtlMs: 30000 });
    if (recovered.type !== 'claimed') throw new Error('input not recovered');
    expect(recovered.execution.events.map(e => e.id)).toEqual(['X']);
    await consume(recovered.execution.events, recovered.execution.id, at(6));
    await consume(recovered.execution.events, 'must-not-rebind', at(7));
    const after = await history.load({ workspaceId: 'w', sessionId: 'session_01' });
    const projected = await pollPersistedHistory(before, after);
    expect(await facts('X')).toMatchObject({ executionId: 'X', consumedByExecutionId: 'X', event: { processedAt: at(6) } });
    expect(projected.items).toHaveLength(1);
    expect(projected.turns).toHaveLength(1);
    expect(projected.events.filter(e => e.type === 'agent.session.turn.item.added').map(e => e.item)).toEqual(projected.items);
    expect(projected.events.find(e => e.type === 'agent.session.turn.created')?.turn).toEqual(projected.turns[0]);
    console.log('CRASH_CLAIM', JSON.stringify({ facts: await facts('X'), attemptCount: recovered.execution.attemptCount, projected }));
  });

  it('crash after steer before re-emit retains atomic consumption and snapshot/stream agreement', async () => {
    const coordinator = await coordinated();
    await append([message('Y')], at(1));
    const y = await coordinator.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'dead', attemptId: 'dead-attempt', claimedAt: at(2), leaseTtlMs: 2000 });
    if (y.type !== 'claimed') throw new Error('Y not claimed');
    const history = new SqlSessionRuntimeHistorySource(client);
    const before = await history.load({ workspaceId: 'w', sessionId: 'session_01' });
    await consume(y.execution.events, 'Y', at(2));
    await append([message('S')], at(3));
    const stolen = await takeQueuedSteeringInputs(coordinator, { workspaceId: 'w', sessionId: 'session_01', laneId: 'sthr_primary', steeredAt: at(3), consumer: y.fence });
    expect(stolen.map(e => e.id)).toEqual(['S']);
    // Crash here: no re-emit/harness delivery, but S and its B2 fact committed together.
    store = new SqlSessionEventStore(client, { executionOutbox: true });
    const restarted = new SqlSessionExecutionStore(client);
    const recovered = await restarted.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'new', attemptId: 'new-attempt', claimedAt: at(5), leaseTtlMs: 30000 });
    if (recovered.type !== 'claimed') throw new Error('Y not recovered');
    await consume(recovered.execution.events, recovered.execution.id, at(6));
    const steered = await takeQueuedSteeringInputs(restarted, { workspaceId: 'w', sessionId: 'session_01', laneId: 'sthr_primary', steeredAt: at(6), consumer: recovered.fence });
    await consume(steered, 'Y', at(6));
    await restarted.settle({ fence: recovered.fence, settledAt: at(7), outcome: 'completed' });
    const next = await restarted.claim({ workspaceId: 'w', sessionId: 'session_01', ownerId: 'new', attemptId: 'next', claimedAt: at(8), leaseTtlMs: 30000 });
    const after = await history.load({ workspaceId: 'w', sessionId: 'session_01' });
    const projected = await pollPersistedHistory(before, after);
    console.log('CRASH_STEER', JSON.stringify({ S: await facts('S'), coordinatorS: await restarted.find({ workspaceId: 'w', executionId: 'S' }), recoveredInputs: recovered.execution.events.map(e => e.id), steered, next, projected }));
    expect(await facts('S')).toMatchObject({ consumedByExecutionId: 'Y', event: { processedAt: at(3) } });
    expect(next.type).toBe('empty');
    expect(projected.items.map((item: any) => item.id)).toEqual(['Y', 'S']);
    expect(projected.turns).toHaveLength(1);
    expect(projected.events.filter(e => e.type === 'agent.session.turn.item.added').map(e => e.item)).toEqual(projected.items);
    expect(projected.items.every((item: any) => item.turn_id === projected.turns[0].id)).toBe(true);
  });

});
