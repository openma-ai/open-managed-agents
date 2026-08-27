import { describe, expect, it } from "vitest";

const inboundPortSources = import.meta.glob("../src/**/port.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const resourcePortSources = import.meta.glob("../src/ports/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents inbound port boundary", () => {
  it("is application-owned and contains only semantic use-case types", () => {
    expect(Object.keys(inboundPortSources).sort()).toEqual([
      "../src/agents/port.ts",
      "../src/dreams/port.ts",
      "../src/session-execution/port.ts",
    ]);
    expect(Object.keys(resourcePortSources).sort()).toEqual([
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

    for (const source of [
      ...Object.values(inboundPortSources),
      ...Object.values(resourcePortSources),
    ]) {
      expect(source).not.toMatch(/from ["'](?!\.)/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/\b(?:Request|Response|Headers|Hono|Zod)\b/);
      expect(source).not.toMatch(/(?:Http|http)[A-Z]/);
      expect(source).not.toMatch(/\b(?:Drizzle|D1|Postgres|SQLite|SQL)\b/);
      expect(source).not.toMatch(/\b(?:any|unknown)\b/);
      expect(source).not.toMatch(/^\s*[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\??\s*:/m);
    }
  });

  it("makes semantic cursor rejection explicit on every list port", () => {
    const cursorResults = [
      ["../src/ports/deployment-runs.ts", "ListDeploymentRunsResult"],
      ["../src/ports/deployments.ts", "ListDeploymentsResult"],
      ["../src/ports/dreams.ts", "ListDreamsResult"],
      ["../src/ports/environment-work.ts", "ListEnvironmentWorkResult"],
      ["../src/ports/skill-versions.ts", "ListSkillVersionsResult"],
      ["../src/ports/skills.ts", "ListSkillsResult"],
      ["../src/ports/tunnel-certificates.ts", "ListTunnelCertificatesResult"],
      ["../src/ports/tunnels.ts", "ListTunnelsResult"],
    ] as const;

    for (const [path, resultName] of cursorResults) {
      const source = resourcePortSources[path];
      expect(source).toBeDefined();
      const declaration = source?.match(
        new RegExp(
          `export type ${resultName}\\s*=[\\s\\S]*?(?=\\nexport (?:type|interface))`,
        ),
      )?.[0];
      expect(declaration, resultName).toContain(
        '{ type: "invalid_request"; message: string }',
      );
    }
  });
});
