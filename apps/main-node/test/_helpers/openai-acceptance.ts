import assert from "node:assert/strict";

/** Shared by deterministic and opt-in live-model acceptance. */
export function assertSingleFunctionSettlement(items: Array<{ type: string; [key: string]: unknown }>, callId: string, turnId: string, expectedOutput: string): void {
  const calls = items.filter(item => item.type === "function_call" && item.call_id === callId);
  const outputs = items.filter(item => item.type === "function_call_output" && item.call_id === callId);
  assert.equal(calls.length, 1, "one durable function call");
  assert.equal(outputs.length, 1, "one durable function result");
  assert.equal(calls[0]!.status, "completed");
  assert.equal(calls[0]!.turn_id, turnId);
  assert.equal(outputs[0]!.turn_id, turnId);
  assert.equal(outputs[0]!.status, "completed", "successful durable result");
  assert.equal(outputs[0]!.error, null, "result has no error");
  assert.deepEqual(outputs[0]!.output, [{ type: "input_text", text: expectedOutput }], "exact submitted tool output");
}

export function assertUniqueIds(rows: Array<{ id: string | null }>): void {
  assert(rows.every(row => typeof row.id === "string" && row.id.length > 0), "durable rows have identities");
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "pagination must not duplicate identities");
}
