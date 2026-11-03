# @openma/stores-sql

SQL adapters for every [`@openma/core`](https://www.npmjs.com/package/@openma/core)
storage Port. The stores talk to a driver-neutral `SqlClient`; client factories
for SQLite, Postgres and MySQL load their driver on demand.

```sh
npm install @openma/stores-sql better-sqlite3   # or: postgres, mysql2
```

```ts
import { createBetterSqlite3SqlClient, sqlStores } from "@openma/stores-sql";

const sql = await createBetterSqlite3SqlClient("./openma.db");
const stores = sqlStores(sql, {
  credentialCipher,      // seals Credential documents at rest
  deploymentCipher,      // seals Deployment resource secrets
  environmentWorkCipher, // seals Environment Work bearer secrets
  sessionSecrets,        // seals Session resource secrets
});
```

A missing cipher or sealer fails closed: writes that need it reject instead of
storing plaintext.

The adapters expect the OpenMA Node control-plane schema and do not create
tables. The Node control plane applies it when it starts against a database;
the migrations live in `apps/main-node/migrations` (Postgres) and
`apps/main-node/migrations-sqlite` (SQLite; MySQL is derived from it) in the
[repository](https://github.com/openma-ai/open-managed-agents).

Pass the result to [`@openma/server`](https://www.npmjs.com/package/@openma/server):
`nodeDefaults({ workspaceId, stores })`.
