import { describe, expect, it } from "vitest";

const persistencePortSources = import.meta.glob("../src/application/**/persistence.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents persistence port boundary", () => {
  it("is owned by the inner application and stays protocol independent", () => {
    expect(Object.keys(persistencePortSources).sort()).toEqual([
      "../src/application/credentials/persistence.ts",
      "../src/application/deployment-runs/persistence.ts",
      "../src/application/deployments/persistence.ts",
      "../src/application/dreams/persistence.ts",
      "../src/application/environment-work/persistence.ts",
      "../src/application/environments/persistence.ts",
      "../src/application/files/persistence.ts",
      "../src/application/memories/persistence.ts",
      "../src/application/memory-stores/persistence.ts",
      "../src/application/session-resources/persistence.ts",
      "../src/application/session-thread-events/persistence.ts",
      "../src/application/session-threads/persistence.ts",
      "../src/application/skills/persistence.ts",
      "../src/application/tunnels/persistence.ts",
      "../src/application/user-profiles/persistence.ts",
      "../src/application/vaults/persistence.ts",
    ]);

    for (const source of Object.values(persistencePortSources)) {
      const externalImports = [...source.matchAll(/from ["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier?.startsWith("."));
      expect(externalImports).toEqual([]);
      expect(source).not.toMatch(/@open-managed-agents\/(?:agent|credential|deployment(?:-run)?|dream|environment|file|session(?:-event)?|vault)-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/memory-store-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/memory-document-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/skill-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/tunnel-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/user-profile-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/environment-work-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/session-thread-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/session-resource-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/managed-agents-api/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/from ["']hono["']/);
      expect(source).not.toMatch(/from ["']zod["']/);
      expect(source).not.toMatch(/\b(?:Drizzle|D1|Postgres|SQLite|SQL)\b/);
      expect(source).not.toMatch(/\b(?:any|unknown)\b/);
      expect(source).not.toMatch(/^\s*[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\??\s*:/m);
    }
  });
});
