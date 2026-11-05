import { describe, expect, it, vi } from 'vitest';
import { applyManagedEvents, applyManagedEventsInPlace, createProjectionState, executionTurnId } from '../src/projection';

const fresh = () => createProjectionState({ sessionId: 's', agentId: 'a', createdAt: 1 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => {
  const executionId = `input_${Math.floor(i / 4)}`;
  const types = ['user.message', 'session.status_running', 'agent.message', 'session.status_idle'];
  return { event: { id: i % 4 ? `event_${i}` : executionId, type: types[i % 4], content: 'text', stopReason: { type: 'end_turn' } },
    context: { observedAt: 1, executionId, ...(i % 4 === 0 ? { consumedByExecutionId: executionId } : {}) } };
});

describe('Projection accumulator and indexes', () => {
  it('matches immutable replay and keeps already emitted events detached', () => {
    let immutable = fresh();
    const accumulator = fresh();
    const emitted: unknown[] = [];
    const originals: string[] = [];
    for (const { event, context } of rows(100)) {
      const old = JSON.stringify(immutable);
      const result = applyManagedEvents(immutable, [event], context);
      expect(JSON.stringify(immutable)).toBe(old);
      immutable = result.state;
      const mutable = applyManagedEventsInPlace(accumulator, [event], context);
      expect(mutable.state).toBe(accumulator);
      expect(mutable.events).toEqual(result.events);
      emitted.push(...mutable.events);
      originals.push(...mutable.events.map(e => JSON.stringify(e)));
    }
    expect(accumulator).toEqual(immutable);
    expect(emitted.map(e => JSON.stringify(e))).toEqual(originals);
  });

  it('does not clone or scan event history for a 10k-event duplicate poll or turn lookup', () => {
    const state = fresh(), source = rows(10000);
    for (const { event, context } of source) applyManagedEventsInPlace(state, [event], context);
    // Read operations must use the replay indexes, not iterate the source log.
    state.eventLog = new Proxy(state.eventLog, { get() { throw new Error('Unexpected event-log scan'); } });
    const cloning = vi.spyOn(globalThis, 'structuredClone');
    try {
      for (const { event, context } of source) {
        const result = applyManagedEvents(state, [event], context);
        expect(result.state).toBe(state);
        expect(result.events).toEqual([]);
        expect(executionTurnId(state, 'root', context.executionId)).toBe(`turn_s:root:${context.executionId}`);
      }
      expect(cloning).not.toHaveBeenCalled();
    } finally { cloning.mockRestore(); }
  });
});
