/**
 * Linear's mapping for a missing or unassigned issue. Terminal rows use
 * `inactive`, which is Linear's own end state (not Slack's `completed`).
 */
export const linearAccessLossCatalog = {
  provider: "linear",
  serverNames: ["linear"],
  scopeLost: [
    { code: "issue_not_found", resourceType: "issue" },
    { code: "issue_unassigned", resourceType: "issue" },
  ],
  credentialLost: [] as readonly string[],
  phrases: [
    { phrase: "could not find referenced issue", code: "issue_not_found", resourceType: "issue" },
    { phrase: "issue not found", code: "issue_not_found", resourceType: "issue" },
    { phrase: "you are not assigned", code: "issue_unassigned", resourceType: "issue" },
  ],
  table: "linear_issue_sessions",
  terminalStatus: "inactive",
  clearPendingScan: false,
} as const;
