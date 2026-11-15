# Explicit database authority gates

These gates run real database clients and require dedicated loopback databases
named `openma_custom_test_*`. They are excluded from the default test command;
missing configuration throws instead of silently skipping a gate.

From `packages/managed-agents-adapters-sql`:

```sh
CUSTOM_INVOCATIONS_PG_URL=postgres://.../openma_custom_test_local \
  node ../../node_modules/vitest/vitest.mjs run --config vitest.custom-pg.config.ts
CUSTOM_INVOCATIONS_MYSQL_URL=mysql://.../openma_custom_test_local \
  node ../../node_modules/vitest/vitest.mjs run --config vitest.custom-mysql.config.ts
```

Use disposable task-owned databases, never production/staging. PostgreSQL uses
an isolated schema and removes that test schema. MySQL resets the authority and canonical-event test
tables in the explicitly named database. Both gates check persisted receipt
CAS, concurrent original-ID uniqueness, long IDs, current holder/generation,
and expiry while blocked on Session, Work and receipt rows. The MySQL test
account also needs read access to `performance_schema.data_lock_waits` to prove
that the operation really blocked. No account credentials belong in git/logs.

`SqlCustomToolInvocations` now accepts an explicit dialect and requires verified
connection-bound row-lock authority for PostgreSQL/MySQL. MySQL authority
identifiers compare as binary bytes even on a case-insensitive database. The
schema's native-ID digest index rejects collisions; identity still comes from
the full stored ID, never from the digest.

The targeted authority gates also exercise canonical cancellation: exact holder
bytes, expiry before the append, expiry while waiting for a receipt lock, and
one correlated durable error result. MySQL additionally validates the native
receipt schema and rejects changed generated-column semantics.

Production composition supplies the dialect, installs PostgreSQL migration0035
or the verified native MySQL schema, and includes receipt publication/answer
consumption/cancellation in the canonical transactions. The representative
official-process gate is in apps/main-node/test/core-custom-mcp-work.native.test.ts:

```sh
CORE_MCP_DATABASE_URL=postgres://.../openma_custom_test_local \
OMA_PI_ACP_ENTRY=/isolated/official-pi-0.1.8/dist/index.js \
  node ../../node_modules/vitest/vitest.mjs run --config vitest.mcp-native.config.ts \
  -t 'Core MCP first with HTTP'
```

Run from apps/main-node, with an official complete Pi distribution. Use the
same command with the dedicated MySQL URL; the cancel-recovery name filter
checks the affected canonical interruption path. These use deterministic local
Messages inference fixtures, not paid inference or provider certification.
SQLite/D1 supplementary gates do not replace either real database gate.
