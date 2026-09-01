import { describe, expect, it } from "vitest";
import sessionBundleSource from "../src/managed-sessions-api.ts?raw";

const officialSessionContractSources = import.meta.glob(
  "../src/contracts/{agent-input-components,agent-response-components,session-event-inputs,session-events,session-resources,session-threads,sessions}.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("Managed Agents Sessions API shape boundary", () => {
  it("does not replace official discriminated shapes with opaque object or array checks", () => {
    expect(Object.keys(officialSessionContractSources)).toHaveLength(7);
    for (const [path, source] of Object.entries(officialSessionContractSources)) {
      expect(source, path).not.toMatch(/\.custom\s*</);
      expect(source, path).not.toMatch(/\.custom\s*\(/);
      expect(source, path).not.toContain("Array.isArray");
    }
  });

  it("composes the Sessions surface from application Port sources only", () => {
    expect(sessionBundleSource).not.toMatch(
      /managed-agents-adapters|sql-client|SessionRegistry|NodeSessionRouter|http-routes/,
    );
    expect(sessionBundleSource).toContain("ManagedAgentsApplicationPorts");
    expect(sessionBundleSource).toContain("ApplicationPortSource");
  });
});
