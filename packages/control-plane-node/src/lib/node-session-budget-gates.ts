import {
  modelEgress,
  type ModelEgress,
  type SessionBudgetGate,
} from "@open-managed-agents/domain/sessions";

/**
 * Live SessionBudgetGate instances for in-flight Node turns. Sandbox
 * inference-proxy and Pi share this gate → domain modelEgress only.
 */
type Scope = { workspaceId: string; sessionId: string };
const GATES = new Map<string, { gate: SessionBudgetGate; token: object }>();
const key = (scope: Scope) => JSON.stringify([scope.workspaceId, scope.sessionId]);

export function registerNodeSessionBudgetGate(
  scope: Scope,
  gate: SessionBudgetGate | null | undefined,
): () => void {
  if (!gate) return () => {};
  const identity = key(scope);
  const token = {};
  GATES.set(identity, { gate, token });
  return () => {
    if (GATES.get(identity)?.token === token) GATES.delete(identity);
  };
}

/** Domain ModelEgress for the session's live gate, or null when inactive. */
export function nodeSessionModelEgress(scope: Scope): ModelEgress | null {
  return modelEgress(GATES.get(key(scope))?.gate ?? null);
}
