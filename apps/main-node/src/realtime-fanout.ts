export type SqlDialect = "sqlite" | "postgres" | "mysql";

/**
 * How live Session events reach SSE subscribers attached to other replicas.
 *
 *  - `memory`:   in-process only. Correct for a single replica (SQLite).
 *  - `pg-notify`: Postgres LISTEN/NOTIFY for the legacy `/v1/oma` stream,
 *                plus SQL tailing for the official `/v1/sessions` stream.
 *  - `sql-poll`: SQL tailing for both streams. Works on any shared SQL
 *                database; the default for MySQL.
 */
export type RealtimeFanoutMode = "memory" | "pg-notify" | "sql-poll";

export interface RealtimeFanoutConfig {
  mode: RealtimeFanoutMode;
  pollIntervalMs: number;
}

type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_POLL_INTERVAL_MS = 300;

export function resolveRealtimeFanout(
  environment: ProcessEnvironment,
  dialect: SqlDialect,
): RealtimeFanoutConfig {
  const raw = environment.OMA_REALTIME_FANOUT?.trim() || "auto";
  let mode: RealtimeFanoutMode;
  if (raw === "auto") {
    mode = dialect === "postgres" ? "pg-notify" : dialect === "mysql" ? "sql-poll" : "memory";
  } else if (raw === "memory" || raw === "pg-notify" || raw === "sql-poll") {
    mode = raw;
  } else {
    throw new TypeError(
      `OMA_REALTIME_FANOUT must be "auto", "memory", "pg-notify" or "sql-poll"; received ${JSON.stringify(raw)}`,
    );
  }
  if (mode === "pg-notify" && dialect !== "postgres") {
    throw new TypeError("OMA_REALTIME_FANOUT=pg-notify requires a postgres:// DATABASE_URL");
  }

  const rawInterval = environment.OMA_REALTIME_POLL_INTERVAL_MS?.trim();
  const pollIntervalMs = rawInterval ? Number(rawInterval) : DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50) {
    throw new TypeError(
      `OMA_REALTIME_POLL_INTERVAL_MS must be an integer >= 50; received ${JSON.stringify(rawInterval)}`,
    );
  }
  return { mode, pollIntervalMs };
}
