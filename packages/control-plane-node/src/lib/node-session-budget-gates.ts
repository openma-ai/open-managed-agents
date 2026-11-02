import {
  modelEgress,
  type ModelEgress,
  type SessionBudgetGate,
} from "@open-managed-agents/domain/sessions";

/**
 * Live SessionBudgetGate instances for in-flight Node turns. Sandbox
 * inference-proxy and Pi share this gate → domain modelEgress only.
 */
const GATES = new Map<string, SessionBudgetGate>();

export function registerNodeSessionBudgetGate(
  sessionId: string,
  gate: SessionBudgetGate | null | undefined,
): void {
  if (!gate) {
    GATES.delete(sessionId);
    return;
  }
  GATES.set(sessionId, gate);
}

export function clearNodeSessionBudgetGate(sessionId: string): void {
  GATES.delete(sessionId);
}

/** Domain ModelEgress for the session's live gate, or null when inactive. */
export function nodeSessionModelEgress(sessionId: string): ModelEgress | null {
  return modelEgress(GATES.get(sessionId) ?? null);
}
