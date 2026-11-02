import type { AcpStatefulAgentSpec } from "@open-managed-agents/acp-runtime/native-state";

export function matchesAgentIdentity(
  agent: AcpStatefulAgentSpec,
  ids: readonly string[],
): boolean {
  const commandBase = agent.command.split("/").pop() ?? agent.command;
  const candidates = new Set([
    agent.id,
    commandBase,
    ...(agent.args ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0));
  return ids.some((id) => candidates.has(id));
}
