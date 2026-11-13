import type { SqlRunResult, SqlStatement, SqlTransaction } from "./ports";

/** Guards both the client and statements retained beyond the callback. */
export function transactionScope(
  execute: (sql: string, params: unknown[]) => Promise<SqlRunResult<unknown>>,
): { client: SqlTransaction; close(): Promise<void> } {
  let active = true;
  const pending = new Set<Promise<SqlRunResult<unknown>>>();
  const run = (sql: string, params: unknown[]) => {
    assertActive();
    const operation = execute(sql, params);
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const assertActive = () => {
    if (!active) throw new Error("SQL transaction scope is closed");
  };
  const statement = (sql: string, params: unknown[] = []): SqlStatement => ({
    bind(...values) { assertActive(); return statement(sql, values); },
    async run<T>() {
      assertActive();
      return await run(sql, params) as SqlRunResult<T>;
    },
    async first<T>() {
      assertActive();
      const result = await run(sql, params);
      return (result.results?.[0] ?? null) as T | null;
    },
    async all<T>() {
      assertActive();
      return await run(sql, params) as SqlRunResult<T>;
    },
  });
  return {
    client: { prepare(sql) { assertActive(); return statement(sql); } },
    async close() {
      active = false;
      const outstanding = [...pending];
      // Drain before rollback/release: RETURNING emulation can issue a readback
      // after its UPDATE resolves. It must never run beyond the transaction.
      await Promise.allSettled(outstanding);
      if (outstanding.length) throw new Error("SQL transaction callback left unawaited statements");
    },
  };
}
