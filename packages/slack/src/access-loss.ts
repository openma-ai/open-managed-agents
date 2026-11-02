/**
 * Slack's mapping from a hosted MCP failure onto the access-loss effect.
 * The managed MCP proxy stays provider-neutral and only interprets this
 * catalog. `not_in_channel` / `channel_not_found` close the one channel
 * scope. Account-wide token failures pause the credential instead.
 */
export const slackAccessLossCatalog = {
  provider: "slack",
  serverNames: ["slack"],
  scopeLost: [
    { code: "not_in_channel", resourceType: "channel" },
    { code: "channel_not_found", resourceType: "channel" },
  ],
  credentialLost: ["token_revoked", "account_inactive"],
  phrases: [] as ReadonlyArray<{ phrase: string; code: string; resourceType: string }>,
  table: "slack_thread_sessions",
  terminalStatus: "completed",
  clearPendingScan: true,
} as const;
