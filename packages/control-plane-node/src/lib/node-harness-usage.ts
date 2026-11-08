// Node harness token-usage helpers. The rules are the application's ONE usage
// implementation (packages/managed-agents-application/src/sessions/budget.ts,
// shared with Cloudflare SessionDO); this module only keeps the mutable
// ledger shape used by the legacy registry / router.
import {
  addSessionTokenUsage,
  cacheTokenUsageFromModelSpan,
  emptySessionTokenTotals,
  sessionUsageSnapshot,
  sumModelSpanUsage,
  tokenTotalsToApiUsage,
  type SessionTokenTotals,
} from "@open-managed-agents/managed-agents-application";

export type NodeHarnessUsageLedger = SessionTokenTotals;

export function createNodeHarnessUsageLedger(): NodeHarnessUsageLedger {
  return emptySessionTokenTotals();
}

export function creditHarnessUsage(
  ledger: NodeHarnessUsageLedger,
  delta: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): void {
  Object.assign(ledger, addSessionTokenUsage(ledger, delta));
}

export function creditCacheTokensFromSpanEnd(
  ledger: NodeHarnessUsageLedger,
  event: { type?: string; model_usage?: Record<string, number | undefined> },
): void {
  const cache = cacheTokenUsageFromModelSpan(event);
  if (cache !== null) creditHarnessUsage(ledger, cache);
}

export function ledgerToManagedSessionUsage(ledger: NodeHarnessUsageLedger) {
  return sessionUsageSnapshot(ledger, null);
}

export function ledgerToApiTokenUsage(ledger: NodeHarnessUsageLedger) {
  return tokenTotalsToApiUsage(ledger);
}

export function aggregateSpanModelUsageFromEvents(
  events: Array<{ type?: string; model_usage?: Record<string, number | undefined> }>,
): NodeHarnessUsageLedger {
  return sumModelSpanUsage(events);
}
