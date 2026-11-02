import { describe, expect, it } from "vitest";

import { openPostgresDatabase } from "../src/index.js";

// postgres.js and pg connect on first query, so opening needs no server.
describe("openPostgresDatabase", () => {
  it("describes the database without credentials", async () => {
    const database = await openPostgresDatabase({ url: "postgres://oma:s3cret@db.internal:6543/oma" });
    expect(database.dialect).toBe("postgres");
    expect(database.description).toBe("postgres db.internal:6543/oma");
    expect(database.description).not.toContain("s3cret");
  });

  it("gives Better Auth its own pool and shares the SqlClient for its schema", async () => {
    const database = await openPostgresDatabase({ url: "postgres://oma@db.internal/oma" });
    expect(database.description).toBe("postgres db.internal:5432/oma");
    const auth = await database.openAuthDatabase!({ sqlitePath: "unused" });
    expect(auth.sql).toBe(database.sql);
    expect(auth.database).toHaveProperty("connect");
    await auth.stop?.();
  });
});
