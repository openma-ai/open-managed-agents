/**
 * Subagent roster selection from the Session's pinned agent snapshot.
 *
 * Both platforms resolve children only from the immutable Session snapshot,
 * never a mutable agent registry. Platform field spelling differs (Cloudflare
 * snake_case `predefined_agents`, Node camelCase `predefinedAgents`), so the
 * caller passes the normalized roster; each platform maps the rejection kind
 * to its existing error text.
 */
export interface SubagentRoster<Agent> {
  /** `subagents.type === "enabled"` on the pinned multiagent snapshot. */
  enabled: boolean;
  inlineEnabled: boolean;
  members: ReadonlyArray<{ id: string; agent: Agent }>;
}

export type SubagentSelection<Agent> =
  | { type: "member"; agent: Agent }
  | { type: "inline" }
  | { type: "disabled" }
  | { type: "not_in_roster" }
  | { type: "inline_disabled" };

/** The inline (general-purpose) child id on both platforms. */
export const GENERAL_SUBAGENT_ID = "general";

export function selectSubagent<Agent>(
  roster: SubagentRoster<Agent> | null | undefined,
  agentId: string | undefined,
): SubagentSelection<Agent> {
  if (!roster?.enabled) return { type: "disabled" };
  if (agentId !== undefined && agentId !== GENERAL_SUBAGENT_ID) {
    const member = roster.members.find((candidate) => candidate.id === agentId);
    return member === undefined ? { type: "not_in_roster" } : { type: "member", agent: member.agent };
  }
  return roster.inlineEnabled ? { type: "inline" } : { type: "inline_disabled" };
}
