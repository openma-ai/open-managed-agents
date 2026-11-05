// Target regressions replacing the exploratory current-behavior assertions.
// Original evidence preserved in /tmp/oma-523-current-repro-original.test.ts.
// Publication integration is in projection-oai-parity.test.ts; these isolate
// executionTurnId from the publisher so failures cannot mask attribution checks.
import { describe, expect, it } from 'vitest';
import { applyManagedEvents, createProjectionState, executionTurnId, type ManagedProjectionEvent } from '../src/projection';

type Row = { event: ManagedProjectionEvent; executionId?: string; consumedByExecutionId?: string };
const message = (id: string) => ({ id, type: 'user.message', content: [{ type: 'text', text: id }] });
const run = (id: string) => ({ id, type: 'session.status_running' });
const end = (id: string, reason = 'end_turn') => ({ id, type: 'session.status_idle', stopReason: { type: reason } });
const rows = (executionId: string, ...events: ManagedProjectionEvent[]): Row[] => events.map(event => ({ event, executionId }));
function replay(history: Row[]) {
  let state = createProjectionState({ sessionId: 's', agentId: 'a', createdAt: 1 });
  for (const row of history) state = applyManagedEvents(state, [row.event], { observedAt: 1, ...row }).state;
  return state;
}
const initial = () => rows('A', message('A'), run('r'), end('done'));

describe('#519 target ownership regressions (independent of artifact publisher)', () => {
  // R03 contract-gap: owner #3; baseline §6 L3_final.json, parent stays completed.
  it('R03 late child delivery leaves executionTurnId on original parent turn', () => {
    const before = replay(initial());
    const after = replay([...initial(), ...rows('A', { id: 'late', type: 'agent.thread_message_received', fromSessionThreadId: 'child', content: 'BANANA' })]);
    expect(executionTurnId(after, 'root', 'A')).toBe(executionTurnId(before, 'root', 'A'));
    expect(after.turnOrder).toEqual(before.turnOrder);
    expect(after.items).toEqual(before.items);
  });
  // R06 contract-gap: owner #6; baseline §4 terminal isolation analogy, not a budget API run.
  it('R06 budget continuation owns a new completed turn', () => {
    const state = replay([...rows('A', message('A'), run('r'), end('budget', 'budget_reached')),
      ...rows('R', { id: 'R', type: 'session.updated', resume: true }, run('resume'), end('resumed'))]);
    const original = executionTurnId(state, 'root', 'A')!, resumed = executionTurnId(state, 'root', 'R')!;
    expect(resumed).not.toBe(original);
    expect(state.turns[original].status).toBe('failed'); expect(state.turns[resumed].status).toBe('completed');
  });
  // R07 contract-gap: owner #7; baseline §5 new goal as new input analogy.
  it('R07 outcome execution never borrows the old completed turn', () => {
    const state = replay([...initial(), ...rows('D', { id: 'D', type: 'user.define_outcome', description: 'goal', rubric: 'ok', max_iterations: 1 }, run('goal'), end('goal_done'))]);
    expect(executionTurnId(state, 'root', 'D')).not.toBe(executionTurnId(state, 'root', 'A'));
    expect(state.turnOrder.map(id => state.turns[id].status)).toEqual(['completed', 'completed']);
  });
  // R09 contract-gap: owner B2; boundary/results.jsonl line 5 (off=2000).
  it('R09 independently consumed boundary message owns its own execution turn', () => {
    const state = replay([...rows('Y', message('Y'), run('r')), { event: message('X'), executionId: 'X', consumedByExecutionId: 'X' },
      ...rows('Y', end('y_done')), ...rows('X', run('x_run'), end('x_done'))]);
    expect(executionTurnId(state, 'root', 'X')).not.toBe(executionTurnId(state, 'root', 'Y'));
    expect(state.items.X.turn_id).toBe(executionTurnId(state, 'root', 'X'));
    expect(state.turnOrder.map(id => state.turns[id].status)).toEqual(['completed', 'completed']);
  });
  // R04: owner #4 + baseline §3 tool results resume originating turn.
  it('R04 tool continuation can resolve ownership without any prior publisher query', () => {
    const state = replay([...rows('A', message('A'), run('r'), { id: 'call', type: 'agent.custom_tool_use', name: 'lookup', input: {} }, end('wait', 'requires_action')),
      ...rows('R', { id: 'R', type: 'user.custom_tool_result', customToolUseId: 'call', content: 'ok' }, run('resume'), end('finished'))]);
    expect(executionTurnId(state, 'root', 'R')).toBe(executionTurnId(state, 'root', 'A'));
    expect(state.turnOrder.map(id => state.turns[id].status)).toEqual(['completed']);
  });
});
