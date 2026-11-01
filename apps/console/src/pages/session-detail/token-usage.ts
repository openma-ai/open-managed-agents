// Session token consumption (input/output/cache) read from the wire `usage`.
// The session page shows tokens only; dollar spend lives on the Budget page.
export interface TokenUsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readTokenUsage(usage: unknown): TokenUsageView | null {
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const cc = u.cache_creation;
  const creation = cc !== null && typeof cc === "object"
    ? num((cc as Record<string, unknown>).ephemeral_5m_input_tokens)
      + num((cc as Record<string, unknown>).ephemeral_1h_input_tokens)
      + num((cc as Record<string, unknown>).ephemeral_five_minute_input_tokens)
      + num((cc as Record<string, unknown>).ephemeral_one_hour_input_tokens)
    : 0;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: creation + num(u.cache_creation_input_tokens),
  };
}

export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}
