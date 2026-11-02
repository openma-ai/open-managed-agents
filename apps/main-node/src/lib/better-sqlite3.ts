import type BetterSqlite3 from "better-sqlite3";

export type BetterSqlite3Constructor = typeof BetterSqlite3;

type Importer = () => Promise<{ default: BetterSqlite3Constructor }>;

/**
 * Load better-sqlite3 on demand.
 *
 * It is an optional dependency: only SQLite storage needs it, so MySQL and
 * Postgres deployments can install without compiling the native addon. When
 * SQLite is selected but the module (or its compiled binding) is missing,
 * fail with an actionable message instead of a bare import error.
 */
export async function loadBetterSqlite3(
  importer: Importer = () => import("better-sqlite3"),
): Promise<BetterSqlite3Constructor> {
  try {
    return (await importer()).default;
  } catch (err) {
    if (isMissingBetterSqlite3(err)) {
      throw new Error(
        "SQLite storage needs the optional dependency 'better-sqlite3', which is not installed " +
          "or failed to build. Install it (pnpm add better-sqlite3), or set DATABASE_URL to a " +
          "MySQL or Postgres database.",
        { cause: err },
      );
    }
    throw err;
  }
}

function isMissingBetterSqlite3(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  // Installed without a compiled addon (optional build skipped or failed).
  return typeof message === "string" && message.includes("Could not locate the bindings file");
}
