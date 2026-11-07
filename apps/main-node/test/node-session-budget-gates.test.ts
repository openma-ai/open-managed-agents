import { describe, expect, it } from "vitest";
import type { SessionBudgetGate } from "@open-managed-agents/domain/sessions";
import { nodeSessionModelEgress, registerNodeSessionBudgetGate } from "../../../packages/control-plane-node/src/lib/node-session-budget-gates";

describe("attempt-owned Node budget gate registrations", () => {
  it("keeps the successor's gate when an old attempt releases its registration", () => {
    const scope = { workspaceId: "workspace-budget", sessionId: "session" };
    const gate = {} as SessionBudgetGate;
    const old = registerNodeSessionBudgetGate(scope, gate);
    const current = registerNodeSessionBudgetGate(scope, gate);
    old(); expect(nodeSessionModelEgress(scope)).not.toBeNull();
    current(); expect(nodeSessionModelEgress(scope)).toBeNull();
  });

  it("scopes identical Session IDs to their workspace and null gates cannot revoke another owner", () => {
    const a = { workspaceId: "workspace-a", sessionId: "same-session" };
    const b = { workspaceId: "workspace-b", sessionId: "same-session" };
    const release = registerNodeSessionBudgetGate(a, {} as SessionBudgetGate);
    expect(nodeSessionModelEgress(b)).toBeNull();
    registerNodeSessionBudgetGate(a, null)();
    expect(nodeSessionModelEgress(a)).not.toBeNull();
    release();
  });
});
