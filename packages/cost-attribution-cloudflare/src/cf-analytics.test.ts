import { describe, expect, it, vi } from "vitest";
import { generateCostReport } from "./cf-analytics";

function accountFor(query: string): Record<string, unknown> {
  if (query.includes("workersInvocationsAdaptive"))
    return { workersInvocationsAdaptive: [] };
  if (query.includes("durableObjectsInvocationsAdaptiveGroups"))
    return { durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 2_000_000 } }] };
  if (query.includes("durableObjectsPeriodicGroups"))
    return { durableObjectsPeriodicGroups: [{ sum: { duration: 1_400_000, rowsRead: 0, rowsWritten: 0 } }] };
  if (query.includes("durableObjectsSqlStorageGroups"))
    return { durableObjectsSqlStorageGroups: [{ max: { storedBytes: 0 } }] };
  if (query.includes("durableObjectsStorageGroups"))
    return { durableObjectsStorageGroups: [{ max: { storedBytes: 0 } }] };
  if (query.includes("kvOperationsAdaptiveGroups"))
    return { kvOperationsAdaptiveGroups: [] };
  if (query.includes("kvStorageAdaptiveGroups"))
    return { kvStorageAdaptiveGroups: [] };
  if (query.includes("r2OperationsAdaptiveGroups"))
    return { r2OperationsAdaptiveGroups: [] };
  if (query.includes("r2StorageAdaptiveGroups"))
    return { r2StorageAdaptiveGroups: [] };
  if (query.includes("d1AnalyticsAdaptiveGroups"))
    return { d1AnalyticsAdaptiveGroups: [] };
  if (query.includes("d1StorageAdaptiveGroups"))
    return { d1StorageAdaptiveGroups: [] };
  if (query.includes("aiInferenceAdaptiveGroups"))
    return {
      aiInferenceAdaptiveGroups: [
        { sum: { totalNeurons: 2_000 }, dimensions: { modelId: "model" } },
      ],
    };
  if (query.includes("browserRenderingApiAdaptiveGroups"))
    return {
      browserRenderingApiAdaptiveGroups: [{ count: 7 }],
      browserRenderingBrowserTimeUsageAdaptiveGroups: [
        { sum: { totalSessionDurationMs: 72_000_000 } },
      ],
    };
  if (query.includes("containersMetricsAdaptiveGroups"))
    return {
      containersMetricsAdaptiveGroups: [
        { sum: { allocatedCpu: 30_000, allocatedMemory: 100_000 * 1024 ** 3 } },
      ],
    };
  throw new Error(`Unexpected Cloudflare query: ${query}`);
}

describe("generateCostReport", () => {
  it("uses the current Cloudflare analytics schema and cost units", async () => {
    const queries: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/billable/usage"))
        return new Response(null, { status: 403 });

      const query = JSON.parse(String(init?.body)).query as string;
      queries.push(query);
      return Response.json({
        data: { viewer: { accounts: [accountFor(query)] } },
      });
    });

    const report = await generateCostReport(
      "account",
      "token",
      30,
      undefined,
      { fetch: fetcher, now: new Date("2026-09-22T12:00:00Z") },
    );

    expect(queries.join("\n")).not.toMatch(
      /objectName|wallTime|sum \{ neurons|modelName|durationMs|cpuTimeUs|memoryGiBSeconds/,
    );
    expect(report.attribution.data_completeness).toBe("complete");
    expect(report.attribution.warnings).toEqual(["provider_billing_unavailable"]);
    expect(report.services.durable_objects).toMatchObject({
      usage: { requests: 2_000_000, duration_gb_seconds: 1_400_000 },
      cost: 12.65,
      status: "available",
    });
    expect(report.services.workers_ai).toMatchObject({
      usage: { neurons: 2_000 },
      cost: 0.022,
      status: "available",
    });
    expect(report.services.browser_rendering).toMatchObject({
      usage: { requests: 7, hours: 20 },
      status: "available",
    });
    expect(report.services.browser_rendering.cost).toBeCloseTo(0.9);
    expect(report.services.containers).toMatchObject({
      usage: { cpu_seconds: 30_000, memory_gib_seconds: 100_000 },
      status: "available",
    });
    expect(report.services.containers.cost).toBeCloseTo(0.175);
    expect(report.total_estimated_cost).toBe(18.75);
  });
});
