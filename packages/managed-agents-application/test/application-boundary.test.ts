import { describe, expect, it } from "vitest";

const applicationSources = import.meta.glob("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents application boundary", () => {
  it("depends only on domain interfaces and never imports an adapter package", () => {
    expect(Object.keys(applicationSources).length).toBeGreaterThan(0);

    for (const source of Object.values(applicationSources)) {
      const externalImports = [...source.matchAll(/from ["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier?.startsWith("."));
      expect(externalImports.every((specifier) =>
        specifier === "@open-managed-agents/agent-store"
        || specifier === "@open-managed-agents/credential-store"
        || specifier === "@open-managed-agents/deployment-store"
        || specifier === "@open-managed-agents/deployment-run-store"
        || specifier === "@open-managed-agents/dream-store"
        || specifier === "@open-managed-agents/domain"
        || specifier === "@open-managed-agents/domain/agents"
        || specifier === "@open-managed-agents/domain/credentials"
        || specifier === "@open-managed-agents/domain/deployments"
        || specifier === "@open-managed-agents/domain/dreams"
        || specifier === "@open-managed-agents/domain/environments"
        || specifier === "@open-managed-agents/domain/environment-work"
        || specifier === "@open-managed-agents/domain/files"
        || specifier === "@open-managed-agents/domain/memory-stores"
        || specifier === "@open-managed-agents/domain/memories"
        || specifier === "@open-managed-agents/domain/sessions"
        || specifier === "@open-managed-agents/domain/skills"
        || specifier === "@open-managed-agents/domain/tunnels"
        || specifier === "@open-managed-agents/domain/user-profiles"
        || specifier === "@open-managed-agents/domain/vaults"
        || specifier === "@open-managed-agents/environment-store"
        || specifier === "@open-managed-agents/environment-work-store"
        || specifier === "@open-managed-agents/file-content-store"
        || specifier === "@open-managed-agents/file-store"
        || specifier === "@open-managed-agents/memory-store-store"
        || specifier === "@open-managed-agents/memory-document-store"
        || specifier === "@open-managed-agents/session-event-store"
        || specifier === "@open-managed-agents/session-resource-store"
        || specifier.startsWith("@open-managed-agents/session-runtime")
        || specifier === "@open-managed-agents/session-store"
        || specifier === "@open-managed-agents/session-thread-store"
        || specifier === "@open-managed-agents/skill-store"
        || specifier === "@open-managed-agents/tunnel-store"
        || specifier === "@open-managed-agents/user-profile-store"
        || specifier === "@open-managed-agents/vault-store",
      )).toBe(true);
      expect(source).not.toMatch(/@open-managed-agents\/managed-agents-api/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/from ["']hono["']/);
      expect(source).not.toMatch(/from ["']zod["']/);
      expect(source).not.toMatch(/from ["']drizzle-orm(?:\/[^"']*)?["']/);
      expect(source).not.toMatch(/@open-managed-agents\/db-schema/);
      expect(source).not.toMatch(/@open-managed-agents\/sql-client/);
      expect(source).not.toMatch(/@open-managed-agents\/memory-document-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/skill-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/tunnel-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/user-profile-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/environment-work-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/session-thread-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/session-resource-store-(?:memory|sql)/);
      expect(source).not.toMatch(/from ["']better-sqlite3["']/);
      expect(source).not.toMatch(/from ["']postgres["']/);
    }
  });
});
