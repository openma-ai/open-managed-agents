import { describe, expect, it } from 'vitest';
import { applyManagedEvents, createProjectionState, executionTurnId, type ManagedProjectionEvent } from '../src/projection';

import { resourcesFixture } from './helpers/resources';
import { encodeResourceMetadata } from '../src/resource-metadata';
import { createNodeOpenAIArtifactPublisher } from '../../control-plane-node/src/openai-artifact-publication';

// B1/B2 are internal event-log metadata, never public event fields.
// consumedByExecutionId is the proposed decoded source_position field; the raw
// envelope is also retained here to make the fixture independent of its spelling
// in the future decoder. No execution table or projection cache is consulted.
type Row = { event: ManagedProjectionEvent; executionId?: string; consumedByExecutionId?: string; initial?: boolean };
const msg = (id: string, text = id, extra = {}) => ({ id, type: 'user.message', content: [{ type: 'text', text }], ...extra });
const out = (id: string, text = id, extra = {}) => ({ id, type: 'agent.message', content: [{ type: 'text', text }], ...extra });
const running = (id: string, extra = {}) => ({ id, type: 'session.status_running', ...extra });
const idle = (id: string, reason = 'end_turn', extra = {}) => ({ id, type: 'session.status_idle', stopReason: { type: reason }, ...extra });
const input = (event: ManagedProjectionEvent, executionId = event.id!, consumedByExecutionId = executionId): Row => ({
  event: { ...event, source_position: { revision: 1, index: 0, execution_id: executionId, consumed_by_execution_id: consumedByExecutionId } },
  executionId, consumedByExecutionId,
});
const exec = (executionId: string, ...events: ManagedProjectionEvent[]): Row[] => events.map(event => ({ event, executionId }));


const short = (id: string | null | undefined) => id ? decodeURIComponent(id.split(':').at(-1)!) : null;
function replay(rows: Row[]) {
  let state = createProjectionState({ sessionId: 's', agentId: 'agent', createdAt: 1 });
  const events: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    const event = row.event.source_position ? { ...row.event, source_position: { ...(row.event.source_position as object), index } } : row.event;
    const result = applyManagedEvents(state, [event], { observedAt: 1, ...row });
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

/** Exercise the actual #519 publisher twice: one immutable file, correct
 * completed-turn provenance, and no duplicate publication on retry.
 * Source: owner #519; OpenAPI SessionArtifactResource.turn_id describes the
 * completed turn that published the artifact. Real runs used environment:none and therefore
 * establish turn semantics only, NOT hosted artifact publication behavior. */
async function publication(rows: Row[], executionId: string, expectedTurn: string | null, reason?: string) {
  const f = resourcesFixture();
  const session: any = { id: 's', environmentId: 'env', agent: { id: 'agent' }, createdAt: new Date(1000).toISOString(),
    metadata: encodeResourceMetadata({}, 'session', { sealed: await f.secrets.seal(JSON.stringify({ agent: {}, environment: { type: 'openai_hosted' }, environmentId: 'env' })) }) };
  const skipped: string[] = [];
  const log = (fields: any) => { if (fields.reason) skipped.push(fields.reason); };
  const publisher = createNodeOpenAIArtifactPublisher({
    historyForWorkspace: () => ({ loadSessionRuntimeHistory: async () => ({
      type: 'found', revision: 1, initialEvents: rows.filter(r => r.initial).map(r => r.event),
      events: rows.filter(r => !r.initial).map(r => r.event),
      orderedEvents: rows.filter(r => !r.initial).map((r, index) => ({ ...r, position: { revision: 1, index } })),
    }) }) as any,
    filesForWorkspace: () => f.files, secrets: f.secrets, isFenceActive: async () => true,
    environmentId: () => 'env', logger: { debug: log, info: log, warn: log },
  });
  let reads = 0;
  const request: any = { workspaceId: 'workspace_a', session,
    executionFence: { workspaceId: 'workspace_a', sessionId: 's', executionId },
    sandbox: { setEnvVars: async () => {}, exec: async () => Buffer.from('./outputs/result.txt\0').toString('base64'),
      readFileBytes: async () => { reads++; return new Uint8Array([0, 255, 42]); } },
  };
  await publisher(request);
  await publisher(request);
  const files = await f.files.listFiles({ scopeId: 's' });
  if (files.type !== 'page') throw new Error(files.message);
  if (reason) {
    expect(files.page.files).toEqual([]);
    expect(skipped).toEqual([reason, reason]);
    expect(reads).toBe(0);
  } else {
    expect(skipped).toEqual([]);
    expect(files.page.files).toHaveLength(1);
    expect(reads).toBe(1);
    const file = files.page.files[0]!;
    expect(file.origin).toMatchObject({ type: 'session_output', sessionId: 's', environmentId: 'env', turnId: expectedTurn });
    expect(await f.files.downloadFile({ fileId: file.id })).toMatchObject({ type: 'found', file: { content: new Uint8Array([0, 255, 42]) } });
  }
}
async function check(rows: Row[], executionId: string, expected: { turns: string[]; owner: string; items?: Record<string, string>; skip?: string }) {
  const { state, events } = replay(rows);
  // Assert publication first so an expected failure proves the #519 gate too.
  const actualTurn = executionTurnId(state, 'root', executionId);
  // New-turn identity is opaque: owner decisions specify isolation, not which
  // native running/input event supplies the public turn ID.
  const target = state.turnOrder.find(id => expected.owner === '@new'
    ? state.turns[id].subagent_id === null && !['A', 'Y'].includes(short(id)!)
    : short(id) === expected.owner) ?? null;
  const label = (id: string | null | undefined) => expected.owner === '@new' && id === target ? '@new' : short(id);
  await publication(rows, executionId, target, expected.skip);
  expect(label(actualTurn)).toBe(expected.owner);
  expect(state.turnOrder.map(id => `${label(id)}:${state.turns[id].status}`)).toEqual(expected.turns);
  for (const [item, owner] of Object.entries(expected.items ?? {})) expect(label(state.items[item]?.turn_id)).toBe(owner);
  const publicJson = JSON.stringify({ events, turns: state.turns, items: state.items });
  for (const field of ['source_position', 'execution_id', 'consumed_by_execution_id', 'consumedByExecutionId']) expect(publicJson).not.toContain(field);
  return state;
}
const done = (e: string, id = e) => exec(e, running(`run_${id}`), out(`answer_${id}`), idle(`done_${id}`));
const outcome = (id: string) => ({ id, type: 'user.define_outcome', description: 'tests pass', rubric: '1. ok', max_iterations: 1 });

describe('OpenAI target turn attribution and #519 publication (event log only)', () => {
  // P01/P02: baseline §1; log-luna.jsonl L1, idle follow-up opens its own turn.
  it('P01 initial execution publishes once', async () => {
    await check([input(msg('A')), ...done('A')], 'A', { turns: ['A:completed'], owner: 'A', items: { A: 'A', answer_A: 'A' } });
  });
  it('P02 idle follow-up preserves both completed turns', async () => {
    const rows = [input(msg('A')), ...done('A'), input(msg('B')), ...done('B')];
    for (const e of ['A', 'B']) await check(rows, e, { turns: ['A:completed', 'B:completed'], owner: e, items: { answer_A: 'A', answer_B: 'B' } });
  });
  // P03: owner #5 bootstrap define_outcome before message; paper #5.
  it('P03 bootstrap execution may start with define_outcome', async () => {
    await check([
      ...[input(outcome('bootstrap_s:0')), input(msg('bootstrap_s:1'), 'bootstrap_s:0')].map(row => ({ ...row, initial: true })),
      ...done('bootstrap_s:0'),
    ], 'bootstrap_s:0', {
      turns: ['bootstrap_s:1:completed'], owner: 'bootstrap_s:1', items: { 'answer_bootstrap_s:0': 'bootstrap_s:1' },
    });
  });
  // P04: owner B1/#5': execution identity is not necessarily a message id.
  it('P04 batch input execution_id binds an execution whose first input is unmapped', async () => {
    await check([input(outcome('D'), 'E'), input(msg('M'), 'E'), ...done('E'), input(msg('N')), ...done('N')], 'E', {
      turns: ['M:completed', 'N:completed'], owner: 'M', items: { answer_E: 'M', answer_N: 'N' },
    });
  });
  // P05: baseline §2 (L1_steer.json), boundary results.jsonl line 2 (off=300).
  it('P05 steer consumed by Y stays in Y turn', async () => {
    await check([input(msg('Y')), ...exec('Y', running('run')), input(msg('X'), 'X', 'Y'), ...exec('Y', out('steered'), idle('end'))], 'Y', {
      turns: ['Y:completed'], owner: 'Y', items: { X: 'Y', steered: 'Y' },
    });
  });
  // P06 contract-gap: boundary results.jsonl line 5, off=2000: 202, distinct turn.
  it('P06 boundary input consumed by itself opens a new completed turn', async () => {
    const rows = [input(msg('Y')), ...exec('Y', running('run')), input(msg('X')), ...exec('Y', out('y'), idle('end')), ...done('X')];
    for (const e of ['Y', 'X']) await check(rows, e, { turns: ['Y:completed', 'X:completed'], owner: e, items: { X: 'X', y: 'Y', answer_X: 'X' } });
  });
  // P07/P08 contract-gap: owner B2 markProcessed + absorbHeldIntoUnheldAdmissions.
  // Held is a scheduler property; authoritative post-consumption history records B2.
  it('P07 held input absorbed into a later unheld execution belongs to its consumer', async () => {
    await check([input(msg('Y')), ...exec('Y', running('run')), input(msg('H'), 'H', 'X'), input(msg('X')), ...exec('Y', idle('end')), ...done('X')], 'X', {
      turns: ['Y:completed', '@new:completed'], owner: '@new', items: { H: '@new', X: '@new', answer_X: '@new' },
    });
  });
  it('P08 held input absorbed by the active execution is a steer', async () => {
    await check([input(msg('Y')), ...exec('Y', running('run')), input(msg('H'), 'H', 'Y'), input(msg('X'), 'X', 'Y'), ...exec('Y', out('absorbed'), idle('end'))], 'Y', {
      turns: ['Y:completed'], owner: 'Y', items: { H: 'Y', X: 'Y', absorbed: 'Y' },
    });
  });
  // P09 contract-gap: boundary sweep 2 off=3500, results.jsonl line 9 + owner B2.
  it('P09 steer followed by boundary input does not absorb the latter into Y', async () => {
    await check([input(msg('Y')), ...exec('Y', running('run')), input(msg('S'), 'S', 'Y'), input(msg('X')), ...exec('Y', out('s'), idle('end')), ...done('X')], 'X', {
      turns: ['Y:completed', 'X:completed'], owner: 'X', items: { S: 'Y', X: 'X', s: 'Y', answer_X: 'X' },
    });
  });
  // P10/P11: baseline §3 L2_req1 / L2_after_false / L2_after_true.json.
  it.each([false, true])('P10 custom tool isError=%s returns to the originating turn', async isError => {
    const rows = [input(msg('A')), ...exec('A', running('r'), { id: 'call', type: 'agent.custom_tool_use', name: 'lookup', input: {} }, idle('wait', 'requires_action')),
      input({ id: 'R', type: 'user.custom_tool_result', customToolUseId: 'call', isError, content: [{ type: 'text', text: 'XYZZY' }] }), ...done('R')];
    const state = await check(rows, 'R', { turns: ['A:completed'], owner: 'A', items: { call: 'A', R: 'A', answer_R: 'A' } });
    expect(state.items.call).toMatchObject({ status: isError ? 'failed' : 'completed' });
    expect(state.items.R).toMatchObject({ status: isError ? 'failed' : 'completed' });
  });
  it('P11 failed tool retry and success all remain in one turn', async () => {
    const call = (id: string) => ({ id, type: 'agent.custom_tool_use', name: 'lookup', input: {} });
    const result = (id: string, customToolUseId: string, isError: boolean) => input({ id, type: 'user.custom_tool_result', customToolUseId, isError, content: [{ type: 'text', text: 'XYZZY' }] });
    const rows = [input(msg('A')), ...exec('A', running('r'), call('c1'), idle('w1', 'requires_action')), result('R1', 'c1', true),
      ...exec('R1', running('r1'), call('c2'), idle('w2', 'requires_action')), result('R2', 'c2', false), ...done('R2')];
    const state = await check(rows, 'R2', { turns: ['A:completed'], owner: 'A', items: { c1: 'A', R1: 'A', c2: 'A', R2: 'A' } });
    expect(state.items.c1).toMatchObject({ status: 'failed' }); expect(state.items.c2).toMatchObject({ status: 'completed' });
    await publication(rows.slice(0, 8), 'R1', state.turnOrder[0], 'turn_not_completed');
  });
  // P12: owner #4; tool_confirmation itself was NOT available in the real-run API.
  it.each(['allow', 'deny'])('P12 tool confirmation %s resumes originating turn', async result => {
    await check([input(msg('A')), ...exec('A', running('r'), { id: 'tool', type: 'agent.tool_use', name: 'bash', input: { command: 'ls' } }, idle('wait', 'requires_action')),
      input({ id: 'C', type: 'user.tool_confirmation', toolUseId: 'tool', result }),
      ...exec('C', running('r2'), { id: 'result', type: 'agent.tool_result', toolUseId: 'tool', isError: result === 'deny', content: 'ok' }, out('final'), idle('end'))], 'C', {
      turns: ['A:completed'], owner: 'A', items: { tool: 'A', final: 'A' },
    });
  });
  // P13/P14 contract-gap: owner #6/#7; baseline §4/§5 are analogies, not native runs.
  it('P13 budget resume opens a new turn and leaves failed items unchanged', async () => {
    const rows = [input(msg('A')), ...exec('A', running('r'), out('partial'), idle('budget', 'budget_reached')),
      input({ id: 'R', type: 'session.updated', resume: true }), ...done('R')];
    const state = await check(rows, 'R', { turns: ['A:failed', '@new:completed'], owner: '@new', items: { partial: 'A', answer_R: '@new' } });
    await publication(rows, 'A', state.turnOrder[0], 'turn_not_completed');
  });
  it('P14 define_outcome after completion opens a new turn', async () => {
    await check([input(msg('A')), ...done('A'), input(outcome('D')), ...done('D')], 'D', {
      turns: ['A:completed', '@new:completed'], owner: '@new', items: { answer_A: 'A', answer_D: '@new' },
    });
  });
  // P15: baseline §4 L1c_cancel.json + L1c_resumed.json.
  it('P15 cancel then new input preserves cancelled turn and publishes only new turn', async () => {
    const rows = [input(msg('A')), ...exec('A', running('r')), input({ id: 'cancel', type: 'user.interrupt' }, 'A'), ...exec('A', idle('end')), input(msg('B')), ...done('B')];
    await check(rows, 'A', { turns: ['A:cancelled', 'B:completed'], owner: 'A', skip: 'turn_not_completed' });
    await check(rows, 'B', { turns: ['A:cancelled', 'B:completed'], owner: 'B', items: { B: 'B', answer_B: 'B' } });
  });
});

function childRows(wait: boolean): Row[] {
  return [input(msg('A')), ...exec('A', running('r'), { id: 'open', type: 'session.thread_created', sessionThreadId: 'child' },
    ...(wait ? [] : [out('ack'), idle('parent_done')]),
    { id: 'recv', type: 'agent.thread_message_received', sessionThreadId: 'child', fromSessionThreadId: 'sthr_primary', content: 'go' },
    { id: 'cr', type: 'session.thread_status_running', sessionThreadId: 'child' }, out('child_out', 'BANANA', { sessionThreadId: 'child' }),
    { id: 'ci', type: 'session.thread_status_idle', sessionThreadId: 'child', stopReason: { type: 'end_turn' } },
    { id: 'return', type: 'agent.thread_message_received', fromSessionThreadId: 'child', content: 'BANANA' },
    ...(wait ? [out('final'), idle('parent_done')] : []))];
}
describe('root/subagent isolation', () => {
  // P16 contract-gap: baseline §6 L3_final.json + owner #3; late root delivery is synthetic.
  it('P16 late child result cannot rebind root artifact ownership', async () => {
    const state = await check(childRows(false), 'A', { turns: ['A:completed', 'recv:completed'], owner: 'A', items: { child_out: 'recv', ack: 'A' } });
    expect(state.items.return).toBeUndefined();
  });
  // P17: owner #3 waiting-parent rule; only mini control observed, not luna evidence.
  it('P17 waiting parent receives result in the same turn', async () => {
    await check(childRows(true), 'A', { turns: ['A:completed', 'recv:completed'], owner: 'A', items: { return: 'A', final: 'A', child_out: 'recv' } });
  });
  // P18: paper #2, Node shared fence; #519 root artifact must remain root-owned.
  it('P18 two child turns sharing root fence do not steal root artifacts', async () => {
    const rows = childRows(true);
    rows.push(...exec('A', { id: 'recv2', type: 'agent.thread_message_received', sessionThreadId: 'child', fromSessionThreadId: 'sthr_primary', content: 'again' },
      { id: 'cr2', type: 'session.thread_status_running', sessionThreadId: 'child' }, out('co2', 'ok', { sessionThreadId: 'child' }),
      { id: 'ci2', type: 'session.thread_status_idle', sessionThreadId: 'child', stopReason: { type: 'end_turn' } }));
    await check(rows, 'A', { turns: ['A:completed', 'recv:completed', 'recv2:completed'], owner: 'A', items: { co2: 'recv2', final: 'A' } });
  });
  // P19: owner B1/B2 privacy; public OpenAI turn/item/event schemas have no storage fields.
  it('P19 internal attribution fields never leak into public projection events', () => {
    const { state, events } = replay([input(msg('A')), ...done('A')]);
    const json = JSON.stringify({ events, turns: state.turns, items: state.items });
    for (const key of ['source_position', 'execution_id', 'consumed_by_execution_id']) expect(json).not.toContain(key);
  });
  // P20: owner #519 completed-turn gate; no claim that OpenAI creates artifacts for waiting turns.
  it.each(['requires_action', 'budget_reached'])('P20 genuinely noncompleted %s skips publication', async reason => {
    await check([input(msg('A')), ...exec('A', running('r'), idle('end', reason))], 'A', {
      turns: [`A:${reason === 'requires_action' ? 'waiting' : 'failed'}`], owner: 'A', skip: 'turn_not_completed',
    });
  });
});

describe('additional event-log and publication boundaries', () => {
  // P21: paper #2b and owner #519: ACP work_item child ownership is lane-local.
  it('P21 ACP work_item output never replaces the root artifact turn', async () => {
    const common = (event_id: string, type: string, data: unknown, envelope = {}) => ({ schema_version: 'oma.event.v1', event_id, type, session_id: 's', occurred_at: '2026-11-04T00:00:00Z', source: { kind: 'harness', harness: 'acp' }, data, ...envelope });
    await check([input(msg('A')), ...exec('A', running('r'), { id: 'delegate', type: 'agent.tool_use', name: 'create_subagent', input: {} },
      common('child_start', 'work_item.started', { kind: 'agent' }, { work_item_id: 'child', parent_id: 'delegate' }),
      common('nested', 'agent.message', { text: 'Facts' }, { parent_id: 'delegate' }),
      common('child_complete', 'work_item.completed', {}, { work_item_id: 'child', parent_id: 'delegate' }),
      { id: 'result', type: 'agent.tool_result', toolUseId: 'delegate', content: 'Facts' }, out('final'), idle('end'))], 'A', {
      turns: ['A:completed', 'child_start:completed'], owner: 'A', items: { nested: 'child_start', final: 'A' },
    });
  });
  // P22 contract-gap: owner B2: consumption must survive storage decoding, but
  // public Managed events must still omit ALL source_position metadata.
  it('P22 B2 consumption survives decoding without leaking into public events', async () => {
    const { decodeSessionEventDocument } = await import('../../session-runtime-contract/src/history');
    const decoded = decodeSessionEventDocument(JSON.stringify({ ...msg('H'), source_position: {
      revision: 2, index: 3, execution_id: 'H', consumed_by_execution_id: 'Y',
    } }));
    expect(decoded).toMatchObject({ executionId: 'H', consumedByExecutionId: 'Y', position: { revision: 2, index: 3 } });
    expect(decoded.event).toEqual(msg('H'));
  });
  // P23: owner B1: execution_id is internal and already roundtrips today.
  it('P23 B1 execution identity survives decoding but is absent from public Managed event', async () => {
    const { decodeSessionEventDocument } = await import('../../session-runtime-contract/src/history');
    const decoded = decodeSessionEventDocument(JSON.stringify({ ...msg('M'), source_position: { revision: 2, index: 1, execution_id: 'E' } }));
    expect(decoded).toEqual({ event: msg('M'), position: { revision: 2, index: 1 }, executionId: 'E' });
  });
  // P24: owner #519 completion must be credited to the publishing execution.
  it('P24 original waiting execution cannot publish a turn completed by its continuation', async () => {
    const rows = [input(msg('A')), ...exec('A', running('r'), { id: 'call', type: 'agent.custom_tool_use', name: 'lookup', input: {} }, idle('wait', 'requires_action')),
      input({ id: 'R', type: 'user.custom_tool_result', customToolUseId: 'call', content: 'ok' }), ...done('R')];
    await check(rows, 'A', { turns: ['A:completed'], owner: 'A', skip: 'turn_not_completed_by_execution' });
    await check(rows, 'R', { turns: ['A:completed'], owner: 'A' });
  });
  // P25 contract-gap: owner #7 applies to ANY terminal predecessor, not only completed.
  it.each(['failed', 'cancelled'])('P25 outcome execution after %s cannot append to the terminal turn', async terminal => {
    const rows = [input(msg('A')), ...exec('A', running('r'), ...(terminal === 'cancelled' ? [{ id: 'cancel', type: 'user.interrupt' }] : []),
      idle('end', terminal === 'failed' ? 'budget_reached' : 'end_turn')), input(outcome('D')), ...done('D')];
    await check(rows, 'D', { turns: [`A:${terminal}`, '@new:completed'], owner: '@new', items: { answer_D: '@new' } });
  });
  // P26: owner event-log authority; reconstruction must not require prior process state.
  it('P26 fresh and duplicate-delivery replay preserve turn ownership', () => {
    const rows = [input(msg('A')), ...done('A'), input(msg('B')), ...done('B')];
    const first = replay(rows), fresh = replay(rows);
    expect(fresh).toEqual(first);
    let state = JSON.parse(JSON.stringify(first.state));
    for (const row of rows) {
      const result = applyManagedEvents(state, [row.event], { observedAt: 1, ...row });
      expect(result.events).toEqual([]); state = result.state;
    }
    expect(state.turns).toEqual(first.state.turns); expect(state.items).toEqual(first.state.items);
    for (const e of ['A', 'B']) expect(executionTurnId(state, 'root', e)).toBe(executionTurnId(fresh.state, 'root', e));
  });
  // P27: paper #8 + owner #4/B1. A confirmation execution can emit a late
  // observability tail after another input has already opened a queued turn.
  // That tail must not change either execution's artifact attribution.
  it('P27 late continuation tail stays with originating turn after a new queued input', async () => {
    const history = [input(msg('A')), ...exec('A', running('r'), { id: 'tool', type: 'agent.tool_use', name: 'bash', input: { command: 'ls' } }, idle('wait', 'requires_action')),
      input({ id: 'C', type: 'user.tool_confirmation', toolUseId: 'tool', result: 'allow' }),
      ...exec('C', running('cr'), { id: 'result', type: 'agent.tool_result', toolUseId: 'tool', content: 'ok' }, out('final'), idle('done')),
      input(msg('B')), ...exec('C', { id: 'late_span', type: 'span.model_request_end' }), ...done('B')];
    await check(history, 'C', { turns: ['A:completed', 'B:completed'], owner: 'A', items: { final: 'A', answer_B: 'B' } });
    await check(history, 'B', { turns: ['A:completed', 'B:completed'], owner: 'B' });
  });

});

// FIRST implementation gate: exercise the real polling loop, including the
// mutation of an already observed event. No timing-based execution inference.
describe('snapshot / polling stream consumption parity', () => {
  it.each(['Y', 'X'])('B2 polling observes X consumed by %s exactly once', async consumer => {
    const { createSessionsHandler } = await import('../src/sessions');
    const { normalizeAgentConfig } = await import('../src/resources');
    const y = [input(msg('Y')), ...exec('Y', running('run_Y'))];
    const queued: Row = { event: { ...msg('X'), processedAt: null }, executionId: 'X' };
    const consumed = { ...input(msg('X'), 'X', consumer), event: { ...msg('X'), processedAt: '1970-01-01T00:00:01.000Z' } };
    const final = [...y, consumed, ...exec('Y', out('answer_Y'), idle('done_Y')), ...(consumer === 'X' ? done('X') : [])];
    const rounds = [[...y, queued], [...y, consumed], final];
    const controller = new AbortController();
    let loads = 0;
    let fixed = false;
    const base: any = { id: 's', object: 'agent.session', created_at: 1, last_active_at: 1,
      agent: { ...normalizeAgentConfig({ model: 'test' }), id: 'agent' }, environment: { type: 'none' },
      status: 'idle', error: null, metadata: {}, required_actions: [], usage: null, vault_ids: [] };
    const handler = createSessionsHandler({ workspaceId: 'workspace_a', pollMs: 0,
      sessions: { retrieveSession: async () => ({ type: 'found', session: { id: 's', createdAt: '1970-01-01T00:00:01.000Z' } }) } as any,
      sessionEvents: {} as any,
      mapping: { sessionView: async () => base } as any,
      history: { loadSessionRuntimeHistory: async () => {
        const rows = fixed ? final : rounds[Math.min(loads++, rounds.length - 1)]!;
        if (!fixed && loads > rounds.length + 1) controller.abort();
        return { type: 'found', revision: 1, initialEvents: [], events: rows.map(r => r.event),
          orderedEvents: rows.map((r, index) => ({ ...r, position: { revision: 1, index } })) } as any;
      } },
    });
    const request: any = { operation: 'sessions.events.stream', params: { session_id: 's' }, query: { order: 'asc' }, body: {}, headers: new Headers(), signal: controller.signal };
    const streamed: any[] = [];
    const response = await handler.execute(request);
    for await (const event of response.stream!) streamed.push(event);
    fixed = true;
    const turns: any = (await handler.execute({ ...request, operation: 'sessions.turns.list' })).body;
    const items: any = (await handler.execute({ ...request, operation: 'sessions.items.list' })).body;
    const completed = streamed.filter(e => e.type === 'agent.session.turn.completed').map(e => e.turn);
    expect(completed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...turns.data].sort((a, b) => a.id.localeCompare(b.id)));
    const expectedTurn = turns.data.find((t: any) => short(t.id) === consumer).id;
    expect(items.data.find((i: any) => i.id === 'X').turn_id).toBe(expectedTurn);
    const delivered = streamed.filter(e => e.type === 'agent.session.turn.item.added' && e.item.id === 'X');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].item).toEqual(items.data.find((i: any) => i.id === 'X'));
    expect(new Set(streamed.map(e => e.event_id)).size).toBe(streamed.length);
    for (const field of ['source_position', 'execution_id', 'consumed_by_execution_id', 'consumedByExecutionId']) expect(JSON.stringify(streamed)).not.toContain(field);
    await publication(final, consumer, expectedTurn);
  });
});
