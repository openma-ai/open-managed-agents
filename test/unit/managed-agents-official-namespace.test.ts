import { describe, expect, it } from "vitest";
import cloudflareComposition from "../../apps/main/src/index.ts?raw";
import nodeComposition from "../../apps/main-node/src/index.ts?raw";
import skillsConsole from "../../apps/console/src/pages/SkillsList.tsx?raw";

const productionSources = import.meta.glob(
  [
    "../../apps/*/src/**/*.{ts,tsx}",
    "../../packages/*/src/**/*.{ts,tsx}",
    "../../scripts/*.{js,mjs}",
  ],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const OFFICIAL_TOP_LEVEL = new Set([
  "agents",
  "deployment_runs",
  "deployments",
  "dreams",
  "environments",
  "files",
  "memory_stores",
  "models",
  "oma",
  "sessions",
  "skills",
  "tunnels",
  "user_profiles",
  "vaults",
]);

function mountedSegments(source: string, receiver: "app" | "v1"): string[] {
  const expression = new RegExp(
    `^${receiver}\\.(?:route|get|post|put|patch|delete)\\("${
      receiver === "app" ? "/v1/" : "/"
    }([^/"?]+)`,
    "gmu",
  );
  return [...source.matchAll(expression)].map((match) => match[1]!);
}

describe("official /v1 namespace", () => {
  it("keeps Cloudflare OMA extensions behind /v1/oma", () => {
    expect(
      mountedSegments(cloudflareComposition, "app").filter(
        (segment) => !OFFICIAL_TOP_LEVEL.has(segment),
      ),
    ).toEqual([]);
  });

  it("keeps Node OMA extensions behind /v1/oma", () => {
    expect(
      mountedSegments(nodeComposition, "v1").filter(
        (segment) => !OFFICIAL_TOP_LEVEL.has(segment),
      ),
    ).toEqual([]);
  });

  it("uses the official skills API while keeping file preview as an OMA extension", () => {
    expect(nodeComposition).toContain('v1.route("/skills", managedSkillsRoutes)');
    expect(nodeComposition).toContain('v1.route("/oma/skills", buildNodeSkillsRoutes');
    expect(nodeComposition).not.toContain('v1.route("/skills", buildNodeSkillsRoutes');
    expect(skillsConsole).toContain('const SKILLS_API = "/v1/skills"');
    expect(skillsConsole).toContain('const SKILLS_PREVIEW_API = "/v1/oma/skills"');
  });

  it("keeps every production caller off removed bare OMA aliases", () => {
    const bareOmaPath = /\/v1\/(?:oauth|cap-cli|model_cards|models\/list|clawhub|api_keys|me|tenants|evals|cost_report|integrations|runtimes|stats|mcp-proxy|internal)(?=\/|[?'"`]|$)/u;
    for (const [path, source] of Object.entries(productionSources)) {
      expect(source, path).not.toMatch(bareOmaPath);
    }
  });
});
