import { describe, expect, it } from "vitest";
import rootSource from "../src/ports.ts?raw";

const portModuleSources = import.meta.glob("../src/ports/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const applicationPortModuleSources = import.meta.glob(
  "../../managed-agents-application/src/ports/*.ts",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

const routeSources = import.meta.glob("../src/routes/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents API application port boundary", () => {
  it("keeps inbound port ownership in the application package", () => {
    expect(Object.keys(portModuleSources).sort()).toEqual([
      "../src/ports/agents.ts",
      "../src/ports/common.ts",
      "../src/ports/credentials.ts",
      "../src/ports/deployment-runs.ts",
      "../src/ports/deployments.ts",
      "../src/ports/dreams.ts",
      "../src/ports/environment-work.ts",
      "../src/ports/environments.ts",
      "../src/ports/files.ts",
      "../src/ports/memories.ts",
      "../src/ports/memory-stores.ts",
      "../src/ports/memory-versions.ts",
      "../src/ports/models.ts",
      "../src/ports/session-events.ts",
      "../src/ports/session-resources.ts",
      "../src/ports/session-thread-events.ts",
      "../src/ports/session-threads.ts",
      "../src/ports/sessions.ts",
      "../src/ports/skill-versions.ts",
      "../src/ports/skills.ts",
      "../src/ports/tunnel-certificates.ts",
      "../src/ports/tunnels.ts",
      "../src/ports/user-profiles.ts",
      "../src/ports/vaults.ts",
    ]);

    expect(Object.keys(applicationPortModuleSources).sort()).toEqual(
      Object.keys(portModuleSources)
        .map((path) =>
          path.replace(
            "../src/ports/",
            "../../managed-agents-application/src/ports/",
          ),
        )
        .sort(),
    );

    expect(rootSource).not.toMatch(/\b(?:interface|type)\s+[A-Z]/);
    for (const source of Object.values(portModuleSources)) {
      expect(source).not.toMatch(/\b(?:interface|type)\s+[A-Z]/);
      expect(source).toContain(
        "@open-managed-agents/managed-agents-application/ports/",
      );
    }

    for (const source of Object.values(applicationPortModuleSources)) {
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/from ["']hono["']/);
      expect(source).not.toMatch(/from ["']zod["']/);
      expect(source).not.toMatch(/from ["'].+contracts\//);
      expect(source).not.toMatch(/\b(?:any|unknown)\b/);
      expect(source).not.toMatch(/^\s*[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\??\s*:/m);
    }
  });

  it("keeps HTTP routes behind the API-local inbound Port facade", () => {
    expect(Object.keys(routeSources).length).toBeGreaterThan(0);

    for (const [path, source] of Object.entries(routeSources)) {
      const imports = [...source.matchAll(/from ["']([^"']+)["']/g)].map(
        (match) => match[1]!,
      );
      expect(imports.some((specifier) => specifier.startsWith("../ports")), path)
        .toBe(true);
      for (const specifier of imports) {
        if (specifier.startsWith(".")) {
          expect(
            specifier,
            `${path} imports outside its presentation-layer collaborators`,
          ).toMatch(
            /^\.\.\/(?:application-port-source|beta|contracts\/|errors|mappers\/|ports(?:\/|$))/,
          );
        } else {
          expect(["hono", "hono/streaming"], path).toContain(specifier);
        }
      }
      expect(source, path).not.toMatch(
        /@open-managed-agents\/managed-agents-(?:application|adapters)/,
      );
      expect(source, path).not.toMatch(
        /\b(?:PersistencePort|SqlClient|D1Database|ApplicationService)\b/,
      );
    }
  });

  it("keeps API-local Port modules as type-only facades", () => {
    for (const [path, source] of Object.entries(portModuleSources)) {
      const name = path.slice(path.lastIndexOf("/") + 1, -3);
      expect(source.trim(), path).toBe(
        `// Compatibility surface for HTTP adapter consumers. The application core owns this port.\n` +
          `export type * from "@open-managed-agents/managed-agents-application/ports/${name}";`,
      );
    }
  });
});
