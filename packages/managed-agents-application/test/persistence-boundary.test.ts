import { describe, expect, it } from "vitest";

const persistencePortSources = import.meta.glob("../src/**/persistence.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents persistence port boundary", () => {
  it("is owned by the inner application and stays protocol independent", () => {
    expect(Object.keys(persistencePortSources).sort()).toEqual([
      "../src/credentials/persistence.ts",
      "../src/deployment-runs/persistence.ts",
      "../src/deployments/persistence.ts",
      "../src/dreams/persistence.ts",
      "../src/environment-work/persistence.ts",
      "../src/environments/persistence.ts",
      "../src/files/persistence.ts",
      "../src/memories/persistence.ts",
      "../src/memory-stores/persistence.ts",
      "../src/session-resources/persistence.ts",
      "../src/session-thread-events/persistence.ts",
      "../src/session-threads/persistence.ts",
      "../src/skills/persistence.ts",
      "../src/tunnels/persistence.ts",
      "../src/user-profiles/persistence.ts",
      "../src/vaults/persistence.ts",
    ]);

    for (const source of Object.values(persistencePortSources)) {
      const externalImports = [...source.matchAll(/from ["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier?.startsWith("."));
      expect(externalImports.every((specifier) =>
        specifier === "@open-managed-agents/agent-store"
        || specifier === "@open-managed-agents/credential-store"
        || specifier === "@open-managed-agents/deployment-store"
        || specifier === "@open-managed-agents/deployment-run-store"
        || specifier === "@open-managed-agents/dream-store"
        || specifier === "@open-managed-agents/environment-store"
        || specifier === "@open-managed-agents/environment-work-store"
        || specifier === "@open-managed-agents/file-store"
        || specifier === "@open-managed-agents/memory-store-store"
        || specifier === "@open-managed-agents/memory-document-store"
        || specifier === "@open-managed-agents/session-event-store"
        || specifier === "@open-managed-agents/session-resource-store"
        || specifier === "@open-managed-agents/session-store"
        || specifier === "@open-managed-agents/session-thread-store"
        || specifier === "@open-managed-agents/skill-store"
        || specifier === "@open-managed-agents/tunnel-store"
        || specifier === "@open-managed-agents/user-profile-store"
        || specifier === "@open-managed-agents/vault-store",
      )).toBe(true);
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
