/** Diagnostics for Session error boundaries. Preserve phase, class and causes;
 * an SDK Error with no message must still explain which boundary failed. */
export function sessionErrorMessage(error: unknown, phase: string): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  for (;;) {
    if (seen.has(current)) { parts.push("[cyclic cause]"); break; }
    seen.add(current);
    if (current instanceof Error) {
      parts.push(`${current.name.trim() || current.constructor.name || "Error"}: ${current.message.trim() || "(empty message)"}`);
      if (current.cause === undefined) break;
      current = current.cause;
    } else {
      parts.push(`${typeof current}: ${String(current).trim() || "(empty message)"}`);
      break;
    }
  }
  return `${phase.trim() || "session"}: ${parts.join("; caused by ")}`;
}
