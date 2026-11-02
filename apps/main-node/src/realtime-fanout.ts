// OMA_REALTIME_FANOUT / OMA_REALTIME_POLL_INTERVAL_MS → RealtimeFanoutConfig.
// The modes themselves are documented with the type in the control plane.

import type { RealtimeFanoutConfig, RealtimeFanoutMode } from "@open-managed-agents/control-plane-node";

export type { RealtimeFanoutConfig, RealtimeFanoutMode };

export type SqlDialect = "sqlite" | "postgres" | "mysql";

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
