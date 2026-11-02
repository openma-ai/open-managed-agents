// Shared token-usage accumulator for Node harness runtimes. Mirrors the
// creditUsageToThread semantics in apps/agent SessionDO: input/output via
// reportUsage, cache buckets from span.model_request_end.

export interface NodeHarnessUsageLedger {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export function createNodeHarnessUsageLedger(): NodeHarnessUsageLedger {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
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
  ledger.input_tokens += delta.input_tokens || 0;
  ledger.output_tokens += delta.output_tokens || 0;
  ledger.cache_read_input_tokens += delta.cache_read_input_tokens || 0;
  ledger.cache_creation_input_tokens += delta.cache_creation_input_tokens || 0;
}

export function creditCacheTokensFromSpanEnd(
  ledger: NodeHarnessUsageLedger,
  event: { type?: string; model_usage?: Record<string, number | undefined> },
): void {
  if (event.type !== "span.model_request_end") return;
  const usage = event.model_usage;
  if (!usage) return;
  const cc = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  if (cc === 0 && cr === 0) return;
  creditHarnessUsage(ledger, {
    cache_creation_input_tokens: cc,
    cache_read_input_tokens: cr,
  });
}

export function ledgerToManagedSessionUsage(ledger: NodeHarnessUsageLedger): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreation?: { ephemeralFiveMinuteInputTokens: number };
} {
  return {
    inputTokens: ledger.input_tokens,
    outputTokens: ledger.output_tokens,
    ...(ledger.cache_read_input_tokens > 0 && {
      cacheReadInputTokens: ledger.cache_read_input_tokens,
    }),
    ...(ledger.cache_creation_input_tokens > 0 && {
      cacheCreation: {
        ephemeralFiveMinuteInputTokens: ledger.cache_creation_input_tokens,
      },
    }),
  };
}

export function ledgerToApiTokenUsage(ledger: NodeHarnessUsageLedger): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} {
  return {
    input_tokens: ledger.input_tokens,
    output_tokens: ledger.output_tokens,
    ...(ledger.cache_read_input_tokens > 0 && {
      cache_read_input_tokens: ledger.cache_read_input_tokens,
    }),
    ...(ledger.cache_creation_input_tokens > 0 && {
      cache_creation_input_tokens: ledger.cache_creation_input_tokens,
    }),
  };
}

export function aggregateSpanModelUsageFromEvents(
  events: Array<{ type?: string; model_usage?: Record<string, number | undefined> }>,
): NodeHarnessUsageLedger {
  const ledger = createNodeHarnessUsageLedger();
  for (const event of events) {
    if (event.type !== "span.model_request_end") continue;
    const u = event.model_usage;
    if (!u) continue;
    creditHarnessUsage(ledger, {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
    });
  }
  return ledger;
}
