/** Shared by every Session host. */
export const DEFAULT_SANDBOX_IDLE_PAUSE_MS = 5 * 60_000;
export function sandboxIdlePauseMs(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_SANDBOX_IDLE_PAUSE_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("SANDBOX_IDLE_PAUSE_MS must be a positive integer of milliseconds, got " + JSON.stringify(value));
  return ms;
}
