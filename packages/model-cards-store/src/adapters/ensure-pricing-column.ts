/** Idempotent additive migration for optional `model_cards.pricing`.
 *
 * Pricing is nullable: NULL means the card is unpriced and budget gates that
 * need list prices stay inactive. The Drizzle SQL migrations add the column;
 * this helper repairs local/CI D1 databases that started before that migration
 * was present so create-without-pricing keeps working.
 *
 * Safe on fake/non-D1 handles (construction-time smoke tests): missing
 * `.prepare` is a no-op rather than an unhandled rejection.
 */
export async function ensureModelCardsPricingColumn(
  db: D1Database,
): Promise<void> {
  if (typeof (db as { prepare?: unknown } | null)?.prepare !== "function") {
    return;
  }
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM pragma_table_info('model_cards') WHERE name = 'pricing' LIMIT 1",
      )
      .first();
    if (row) return;
  } catch {
    // Fall through to ADD — older D1 builds may not expose pragma_table_info
    // as a selectable table the same way. Missing model_cards table also
    // lands here; the ALTER below then no-ops via the catch.
  }
  try {
    await db.prepare("ALTER TABLE model_cards ADD pricing text").run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate column/i.test(message)) return;
    // Table may not exist yet in unit-test fakes or pre-migration DBs.
    if (/no such table/i.test(message)) return;
    throw err;
  }
}
