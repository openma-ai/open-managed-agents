import { describe, expect, it } from 'vitest';
import { consumeSessionInputs } from '../src/coordination';

describe('shared host input consumption boundary', () => {
  it('uses the consumer rather than the first held input and emits only after the canonical CAS resolves', async () => {
    const order: string[] = [];
    const consumed = [{ id: 'H', processedAt: '2026-11-04T00:00:00Z' }, { id: 'X', processedAt: '2026-11-04T00:00:00Z' }];
    const result = await consumeSessionInputs({ markProcessed: async command => {
      expect(command).toEqual({ workspaceId: 'w', sessionId: 's', eventIds: ['H', 'X'], consumedByExecutionId: 'X', processedAt: '2026-11-04T00:00:00Z' });
      await Promise.resolve(); order.push('persisted'); return consumed;
    } }, { workspaceId: 'w', sessionId: 's', inputs: [{ id: 'H' }, { id: 'X' }, { id: 'H' }], consumingExecutionId: 'X', processedAt: '2026-11-04T00:00:00Z' }, async events => {
      expect(order).toEqual(['persisted']); expect(events).toEqual(consumed); order.push('emitted');
    });
    expect(result).toEqual(consumed); expect(order).toEqual(['persisted', 'emitted']);
  });
  it('propagates persistence failure without emitting or pretending consumption succeeded', async () => {
    let emitted = false;
    await expect(consumeSessionInputs({ markProcessed: async () => { throw new Error('CAS unavailable'); } },
      { workspaceId: 'w', sessionId: 's', inputs: [{ id: 'X' }], consumingExecutionId: 'Y', processedAt: '2026-11-04T00:00:00Z' },
      () => { emitted = true; })).rejects.toThrow('CAS unavailable');
    expect(emitted).toBe(false);
  });
});
