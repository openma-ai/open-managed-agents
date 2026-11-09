import { env } from "cloudflare:workers";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";

type Row = { seq: number | null; type: string; data: Record<string, unknown> };
/** Wait for a fixed accepted-input set and its actual consumers, never initial idle.
 * Canonical inputs use consumed_by_execution_id; legacy OMA inputs use the real
 * execution events_json payload. Unlinked legacy steering fails closed. No alarms are run. */
export async function waitForSessionExecution(sessionId: string, inputIds: readonly string[], timeoutMs = 15_000): Promise<void> {
  const accepted = [...new Set(inputIds)];
  if (!accepted.length || accepted.some(id => typeof id !== "string" || !id)) throw new Error("Accepted input IDs are required");
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
  const deadline = Date.now() + timeoutMs;
  let observed: unknown;
  while (Date.now() < deadline) {
    const response = await stub.fetch(new Request("http://internal/events?limit=1000"));
    const { data } = await response.json() as { data: Row[] };
    const executions = await env.MAIN_DB.prepare("SELECT id,state,events_json,lane_id FROM managed_session_executions WHERE session_id=?")
      .bind(sessionId).all<{ id: string; state: string; events_json: string; lane_id: string }>();
    const canonical = await env.MAIN_DB.prepare("SELECT id,document FROM managed_session_events WHERE session_id=?")
      .bind(sessionId).all<{ id: string; document: string }>();
    const checks = accepted.map(id => {
      const input = data.find(row => row.type === "user.message" && row.data.id === id);
      const document = canonical.results.find(row => row.id === id);
      const decoded = document ? decodeSessionEventDocument(document.document) : undefined;
      const steering = data.find(row => row.type === "system.user_message_steered" && row.data.event_id === id);
      const lane = input?.data.session_thread_id ?? "sthr_primary";
      const consumerId = decoded?.consumedByExecutionId;
      const consumers = consumerId ? executions.results.filter(row => row.id === consumerId)
        : document || steering ? [] : executions.results.filter(row => (JSON.parse(row.events_json) as Array<{ id: string }>).some(event => event.id === id));
      // A steering marker alone names no consumer; never accept its completed admission instead.
      const terminalSeq = steering?.seq ?? input?.seq;
      const idle = data.find(row => row.type === "session.status_idle" && row.seq !== null && terminalSeq != null && row.seq > terminalSeq
        && (row.data.session_thread_id ?? "sthr_primary") === lane);
      const terminal = consumers.length > 0 && consumers.every(row => ["completed", "failed", "cancelled"].includes(row.state));
      return { id, seq: input?.seq, consumerId, consumers: consumers.map(row => ({ id: row.id, state: row.state })), idle: idle?.seq,
        done: input?.seq != null && (!decoded || decoded.event.processedAt != null) && terminal && idle !== undefined };
    });
    observed = checks;
    if (checks.every(check => check.done)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${sessionId} did not finish its accepted inputs: ${JSON.stringify(observed)}`);
}
