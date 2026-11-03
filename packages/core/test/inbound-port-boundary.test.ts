import { describe, expect, it } from "vitest";

const inboundPortSources = import.meta.glob("../src/application/**/port.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const resourcePortSources = import.meta.glob("../src/application/ports/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents inbound port boundary", () => {
  it("is application-owned and contains only semantic use-case types", () => {
    expect(Object.keys(inboundPortSources).sort()).toEqual([
      "../src/application/agents/port.ts",
      "../src/application/dreams/port.ts",
      "../src/application/session-execution/port.ts",
    ]);
    expect(Object.keys(resourcePortSources).sort()).toEqual([
      "../src/application/ports/agents.ts",
      "../src/application/ports/common.ts",
      "../src/application/ports/credentials.ts",
      "../src/application/ports/deployment-runs.ts",
      "../src/application/ports/deployments.ts",
      "../src/application/ports/dreams.ts",
      "../src/application/ports/environment-work.ts",
      "../src/application/ports/environments.ts",
      "../src/application/ports/files.ts",
      "../src/application/ports/memories.ts",
      "../src/application/ports/memory-stores.ts",
      "../src/application/ports/memory-versions.ts",
      "../src/application/ports/models.ts",
      "../src/application/ports/session-events.ts",
      "../src/application/ports/session-resources.ts",
      "../src/application/ports/session-thread-events.ts",
      "../src/application/ports/session-threads.ts",
      "../src/application/ports/sessions.ts",
      "../src/application/ports/skill-versions.ts",
      "../src/application/ports/skills.ts",
      "../src/application/ports/tunnel-certificates.ts",
      "../src/application/ports/tunnels.ts",
      "../src/application/ports/user-profiles.ts",
      "../src/application/ports/vaults.ts",
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
      ["../src/application/ports/deployment-runs.ts", "ListDeploymentRunsResult"],
      ["../src/application/ports/deployments.ts", "ListDeploymentsResult"],
      ["../src/application/ports/dreams.ts", "ListDreamsResult"],
      ["../src/application/ports/environment-work.ts", "ListEnvironmentWorkResult"],
      ["../src/application/ports/skill-versions.ts", "ListSkillVersionsResult"],
      ["../src/application/ports/skills.ts", "ListSkillsResult"],
      ["../src/application/ports/tunnel-certificates.ts", "ListTunnelCertificatesResult"],
      ["../src/application/ports/tunnels.ts", "ListTunnelsResult"],
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
