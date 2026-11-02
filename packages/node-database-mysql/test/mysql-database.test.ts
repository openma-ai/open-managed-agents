import { describe, expect, it } from "vitest";

import { openMysqlDatabase } from "../src/index.js";

// mysql2 pools connect on first query, so opening needs no server.
describe("openMysqlDatabase", () => {
  it("describes the database without credentials and shares one pool with Better Auth", async () => {
    const database = await openMysqlDatabase({ url: "mysql://oma:s3cret@db.internal/oma" });
    try {
      expect(database.dialect).toBe("mysql");
      expect(database.description).toBe("mysql db.internal:3306/oma");
      const auth = await database.openAuthDatabase!({ sqlitePath: "unused" });
      expect(auth.sql).toBe(database.sql);
      expect(auth.stop).toBeUndefined();
      expect(auth.database).toHaveProperty("getConnection");
    } finally {
      await database.stop?.();
    }
  });
});
