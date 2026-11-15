/** Provider I/O double; the real outcome evaluator still parses and applies the verdict. */
export function revisionJudgeResponse(): Response {
  const events = [
    { type: "message_start", message: { id: "msg_parity_judge", type: "message", role: "assistant", content: [], model: "parity-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify({ result: "needs_revision", explanation: "Try again." }) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
