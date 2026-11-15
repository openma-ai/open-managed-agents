// Model-visible Session resource guidance for one turn (design §0.7: Session
// inputs / resource mounting), one derivation for the Cloudflare SessionDO and
// the Node runner; the Work supervisor renders the same facts in the sandbox.
// Hosts pass what they actually materialized or mounted. The workspace root
// comes from the prepared sandbox. Outputs are always attached at the Session
// outputs path, which the platform guidance already states, so only the
// workspace, Skill and Memory reminders are added here.

import { workspaceRootOf, type SandboxPort } from "@open-managed-agents/sandbox";
import {
  SESSION_OUTPUTS_PATH,
  sessionResourceFacts,
  sessionResourceReminders,
  type SessionMemoryResourceFact,
  type SessionResourceFacts,
  type SessionResourceReminder,
  type SessionSkillResourceFact,
} from "@open-managed-agents/runtime-resource-contract";

export interface SessionTurnResourceGuidance {
  facts: SessionResourceFacts;
  reminders: SessionResourceReminder[];
}

export async function sessionTurnResourceGuidance(input: {
  sandbox: Pick<SandboxPort, "resolveWorkspaceRoot">;
  skills: readonly SessionSkillResourceFact[];
  memoryStores: readonly SessionMemoryResourceFact[];
}): Promise<SessionTurnResourceGuidance> {
  const facts = sessionResourceFacts({
    workspaceRoot: await workspaceRootOf(input.sandbox),
    skills: input.skills,
    memoryStores: input.memoryStores,
    outputs: { path: SESSION_OUTPUTS_PATH },
  });
  return { facts, reminders: sessionResourceReminders(facts, { outputsGuidedByPlatform: true, includeWorkspace: true }) };
}
