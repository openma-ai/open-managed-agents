/** Diagnostic projection only: never serialize SDK requests, headers or Work secrets. */
export function describeWorkDispatchError(error: unknown, secretValues: readonly string[] = []) {
  const scrub = (text: string) => {
    for (const secret of secretValues) if (secret.length > 3) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/https?:\/\/[^\s"'<>]+/g, value => {
        try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
        catch { return "[URL]"; }
      })
      .replace(/\b(?:sk-ant-|e2b_)[A-Za-z0-9._-]+/g, "[REDACTED]")
      .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
      .slice(0, 2048);
  };
  const causes: Array<{ name: string; message: string; frames: string[] }> = [];
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && causes.length < 4 && !seen.has(current); current = current.cause) {
    seen.add(current);
    causes.push({ name: scrub(current.name), message: scrub(current.message),
      frames: (current.stack ?? "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 6).map(scrub) });
  }
  return { causes, ...(causes.length === 0 ? { thrownType: typeof error } : {}) };
}
