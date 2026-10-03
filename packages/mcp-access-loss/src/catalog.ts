import { githubAccessLossCatalog } from "@open-managed-agents/github";
import { linearAccessLossCatalog } from "@open-managed-agents/linear";
import { slackAccessLossCatalog } from "@open-managed-agents/slack";

export interface AccessLossCode {
  code: string;
  resourceType: string;
}

export interface AccessLossPhrase {
  phrase: string;
  code: string;
  resourceType: string;
}

/**
 * Provider-owned description of which upstream failures are terminal.
 * The proxy does not hard-code Slack/Linear/GitHub error strings.
 */
export interface AccessLossCatalog {
  provider: string;
  serverNames: readonly string[];
  scopeLost: readonly AccessLossCode[];
  credentialLost: readonly string[];
  phrases: readonly AccessLossPhrase[];
  table: string;
  terminalStatus: string;
  clearPendingScan: boolean;
}

export const integrationAccessLossCatalogs: readonly AccessLossCatalog[] = [
  slackAccessLossCatalog,
  linearAccessLossCatalog,
  githubAccessLossCatalog,
];

const ALLOWED_TABLES = new Set([
  "slack_thread_sessions",
  "linear_issue_sessions",
  "github_issue_sessions",
]);

const ALLOWED_STATUSES = new Set(["completed", "inactive"]);

export function catalogForProvider(provider: string): AccessLossCatalog | null {
  return integrationAccessLossCatalogs.find((catalog) => catalog.provider === provider) ?? null;
}

export function assertCloseableCatalog(catalog: AccessLossCatalog): void {
  if (!ALLOWED_TABLES.has(catalog.table)) {
    throw new Error(`refusing to close unknown scope table ${catalog.table}`);
  }
  if (!ALLOWED_STATUSES.has(catalog.terminalStatus)) {
    throw new Error(`refusing to write unknown scope status ${catalog.terminalStatus}`);
  }
}
