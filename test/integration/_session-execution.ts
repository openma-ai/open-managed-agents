import { env } from "cloudflare:workers";

/** Wait for accepted inputs, not the session's initial idle snapshot.
 * Mirrors the execution-store tests' durable terminal-state checks and the
 * characterization tests' terminal event boundary. Does not run alarms itself. */
export async function waitForSessionExecution(sessionId: string, timeoutMs = 15_000): Promise<void> {
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
  const deadline = Date.now() + timeoutMs;
  let observed: unknown;
  while (Date.now() < deadline) {
    const response = await stub.fetch(new Request("http://internal/events?limit=1000"));
    const { data } = await response.json() as { data: Array<{ seq: number | null; type: string; data: Record<string, unknown> }> };
    const inputs = data.filter(row => row.type === "user.message");
    const executions = await env.MAIN_DB.prepare("SELECT state FROM managed_session_executions WHERE session_id=?")
      .bind(sessionId).all<{ state: string }>();
    const statuses = data.filter(row => row.type === "session.status_idle" || row.type === "session.status_running");
    observed = { inputs: inputs.map(row => row.seq), executions: executions.results.map(row => row.state), lastStatus: statuses.at(-1)?.type };
    if (inputs.length > 0 && inputs.every(row => row.seq !== null)
      && executions.results.length > 0 && executions.results.every(row => ["completed", "failed", "cancelled"].includes(row.state))
      && statuses.at(-1)?.type === "session.status_idle") return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${sessionId} did not finish its accepted inputs: ${JSON.stringify(observed)}`);
}
