import { describe, expect, it } from "vitest";
import cloudflareComposition from "../../apps/main/src/index.ts?raw";
import nodeComposition from "../../packages/control-plane-node/src/modules/node-http.ts?raw";
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
    `^\\s*${receiver}\\.(?:route|get|post|put|patch|delete)\\("${
      receiver === "app" ? "/v1/" : "/"
    }([^/"?]+)`,
    "gmu",
  );
  return [...source.matchAll(expression)].map((match) => match[1]!);
}

// OpenMA-only route builders that must never be mounted on an official
// top-level segment, keyed by the identifier used in the composition roots.
const OMA_ONLY_ROUTES = ["managedCapCliDeviceFlowRoutes"];

function officialMounts(source: string, receiver: "app" | "v1"): string[] {
  const expression = new RegExp(
    `^\\s*${receiver}\\.route\\("${receiver === "app" ? "/v1/" : "/"}([^/"?]+)[^"]*",\\s*([A-Za-z_$][\\w$]*)`,
    "gmu",
  );
  return [...source.matchAll(expression)]
    .filter((match) => match[1] !== "oma" && OFFICIAL_TOP_LEVEL.has(match[1]!))
    .map((match) => match[2]!);
}

describe("official /v1 namespace", () => {
  it("parses mounts from both composition roots", () => {
    expect(mountedSegments(cloudflareComposition, "app")).toContain("oma");
    expect(mountedSegments(nodeComposition, "v1")).toContain("oma");
    expect(officialMounts(cloudflareComposition, "app")).toContain("managedVaultsRoutes");
    expect(officialMounts(nodeComposition, "v1")).toContain("managedVaultsRoutes");
  });

  it("mounts OpenMA-only route builders under /v1/oma", () => {
    for (const name of OMA_ONLY_ROUTES) {
      expect(officialMounts(cloudflareComposition, "app")).not.toContain(name);
      expect(officialMounts(nodeComposition, "v1")).not.toContain(name);
    }
    expect(cloudflareComposition).toContain('app.route("/v1/oma/vaults", managedCapCliDeviceFlowRoutes)');
    expect(nodeComposition).toContain('v1.route("/oma/vaults", managedCapCliDeviceFlowRoutes)');
  });

  it("keeps every production caller off OpenMA extensions under official resource paths", () => {
    const officialExtensionPath = /\/v1\/vaults\/[^'"`\s]*cap_cli_device_flow/u;
    for (const [path, source] of Object.entries(productionSources)) {
      expect(source, path).not.toMatch(officialExtensionPath);
    }
  });

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

  it("uses the official skills API, including version content preview", () => {
    expect(nodeComposition).toContain('v1.route("/skills", managedSkillsRoutes)');
    expect(nodeComposition).toContain('v1.route("/oma/skills", buildNodeSkillsRoutes');
    expect(nodeComposition).not.toContain('v1.route("/skills", buildNodeSkillsRoutes');
    expect(skillsConsole).toContain('const SKILLS_API = "/v1/skills"');
    expect(skillsConsole).not.toContain("/v1/oma/skills");
  });

  it("keeps every production caller off removed bare OMA aliases", () => {
    const bareOmaPath = /\/v1\/(?:oauth|cap-cli|model_cards|models\/list|clawhub|api_keys|me|tenants|evals|cost_report|integrations|runtimes|stats|mcp-proxy|inference-proxy|internal)(?=\/|[?'"`]|$)/u;
    for (const [path, source] of Object.entries(productionSources)) {
      expect(source, path).not.toMatch(bareOmaPath);
    }
  });
});
