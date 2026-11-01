import {
  gateExhausted,
  recordModelEgress,
  type SessionBudgetGate,
  type TokenUsage,
} from "@open-managed-agents/domain/sessions";
import type { HostedInferenceBudgetHooks } from "@open-managed-agents/inference-proxy";

/**
 * Live SessionBudgetGate instances for in-flight Node turns. The harness-in-
 * sandbox inference proxy meters through these so list_cost_pico stays ONE
 * counter with the Pi / parent path (same domain gate + store port).
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

export function nodeHostedInferenceBudgetHooks(
  sessionId: string,
): HostedInferenceBudgetHooks | null {
  const gate = GATES.get(sessionId);
  if (!gate) return null;
  return {
    allowRequest: () => {
      if (gateExhausted(gate)) {
        gate.reached = true;
        return false;
      }
      return true;
    },
    recordUsage: (usage: TokenUsage) => {
      recordModelEgress(gate, usage);
      if (gateExhausted(gate)) gate.reached = true;
    },
  };
}
