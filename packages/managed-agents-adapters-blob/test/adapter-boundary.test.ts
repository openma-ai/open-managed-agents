import { describe, expect, it } from "vitest";

const adapterSources = import.meta.glob("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents blob adapter boundary", () => {
  it("depends only on the application Port and runtime-neutral blob Port", () => {
    expect(Object.keys(adapterSources).sort()).toEqual([
      "../src/blob-file-content-store.ts",
      "../src/index.ts",
    ]);

    for (const source of Object.values(adapterSources)) {
      expect(source).not.toMatch(/@open-managed-agents\/managed-agents-api/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/@open-managed-agents\/db-schema/);
      expect(source).not.toMatch(/from ["'](?:hono|zod|drizzle-orm)/);
      expect(source).not.toMatch(/from ["'](?:better-sqlite3|postgres)/);
      expect(source).not.toMatch(/@cloudflare\/workers-types/);
      expect(source).not.toMatch(/(?:CfR2|S3|LocalFs)BlobStore/);
    }
  });
});
