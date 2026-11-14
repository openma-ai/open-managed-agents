/** Execution authority and sandbox-token validity share this lease. */
export const DEFAULT_SESSION_EXECUTION_LEASE_TTL_MS = 90_000;
export function sessionExecutionLeaseTtlMs(value?: string | number): number {
  const ttl = value === undefined ? DEFAULT_SESSION_EXECUTION_LEASE_TTL_MS : Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 3) throw new Error("OMA_SESSION_EXECUTION_LEASE_TTL_MS must be an integer >= 3");
  return ttl;
}
