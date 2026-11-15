import type { SessionEvent, Env } from "@open-managed-agents/shared";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { stampEvent } from "@open-managed-agents/agent-harness";

/** CF infrastructure only: the shared failed-attempt proof is checked by the
 * same SQL projection as Node, before local history or WebSocket publication.
 * Do not route through broadcastEvent, which would project a second time. */
export async function appendStaleTurnEvent(
  input: { binding: Env["MAIN_MCP"]; workspaceId: string; sessionId: string;
    append(event: SessionEvent): void; sockets(): WebSocket[] },
  event: SessionEvent,
  executionFence: SessionExecutionFence,
): Promise<boolean> {
  if (!input.binding) throw new Error("Stale turn settlement requires the canonical projection binding");
  stampEvent(event);
  const result = await input.binding.managedSessionEventProduced({
    workspaceId: input.workspaceId, sessionId: input.sessionId,
    event: JSON.stringify(event), executionFence,
  });
  if (result.type === "execution_fence_lost" || result.type === "not_found") return false;
  if (result.type === "version_conflict") throw new Error("Stale turn projection revision conflict; retry required");
  input.append(event);
  if (result.type === "recorded") {
    const data = JSON.stringify(event);
    for (const socket of input.sockets()) { try { socket.send(data); } catch { /* closed */ } }
  }
  return true;
}

/** Canonical facts survive loss of execution ownership. Reconcile before
 * recovery and history reads, even when there is no failed candidate left. */
export async function backfillStaleTurnEvents(input: {
  binding: Env["MAIN_MCP"]; workspaceId: string; sessionId: string;
  history: { reconcileCanonicalEvents(events: SessionEvent[]): SessionEvent[] | Promise<SessionEvent[]> }; sockets(): WebSocket[];
}): Promise<void> {
  if (!input.binding?.managedSessionCanonicalEvents) return;
  const events = await input.binding.managedSessionCanonicalEvents({ workspaceId: input.workspaceId, sessionId: input.sessionId });
  for (const event of await input.history.reconcileCanonicalEvents(events)) {
    const data = JSON.stringify(event);
    for (const socket of input.sockets()) { try { socket.send(data); } catch { /* closed */ } }
  }
}
