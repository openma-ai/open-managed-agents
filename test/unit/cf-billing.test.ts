import { describe, expect, it, vi } from "vitest";
import {
  createCostAttributionPort,
  generateCostReport,
  mergeCfPricing,
  normalizeCloudflareBillableUsage,
  splitCloudflareBillingPeriod,
  type CloudflareBillableUsageRow,
} from "@open-managed-agents/cost-attribution-cloudflare";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function focusRow(
  overrides: Partial<CloudflareBillableUsageRow> = {},
): CloudflareBillableUsageRow {
  return {
    BillingAccountId: "acct_123",
    ChargeCategory: "Usage",
    ChargePeriodStart: "2026-09-12T00:00:00Z",
    ChargePeriodEnd: "2026-09-13T00:00:00Z",
    ConsumedQuantity: 12,
    ConsumedUnit: "requests",
    ServiceName: "Workers",
    x_BillableMetricId: "workers_requests",
    x_BillableMetricName: "Workers Requests",
    ...overrides,
  };
}

function emptyAnalyticsAccount(): Record<string, unknown[]> {
  return {
    workersInvocationsAdaptive: [],
    durableObjectsInvocationsAdaptiveGroups: [],
    durableObjectsPeriodicGroups: [],
    durableObjectsStorageGroups: [],
    durableObjectsSqlStorageGroups: [],
    kvOperationsAdaptiveGroups: [],
    kvStorageAdaptiveGroups: [],
    r2OperationsAdaptiveGroups: [],
    r2StorageAdaptiveGroups: [],
    d1AnalyticsAdaptiveGroups: [],
    d1StorageAdaptiveGroups: [],
    aiInferenceAdaptiveGroups: [],
    browserRenderingApiAdaptiveGroups: [],
    containersMetricsAdaptiveGroups: [],
  };
}

describe("Cloudflare billable usage normalization", () => {
  it("splits long reports into non-overlapping windows accepted by the provider API", () => {
    expect(splitCloudflareBillingPeriod({
      start: "2026-06-16",
      end: "2026-09-13",
      days: 90,
    })).toEqual([
      { start: "2026-06-16", end: "2026-07-16", days: 31 },
      { start: "2026-07-17", end: "2026-08-16", days: 31 },
      { start: "2026-08-17", end: "2026-09-13", days: 28 },
    ]);
  });

  it("uses provider-reported billed cost without presenting alpha data as invoice-grade", () => {
    const result = normalizeCloudflareBillableUsage([
      focusRow({ BilledCost: 1.25, BillingCurrency: "USD" }),
      focusRow({
        x_BillableMetricId: "workers_cpu",
        x_BillableMetricName: "Workers CPU",
        ConsumedQuantity: 4,
        ConsumedUnit: "milliseconds",
        BilledCost: 0.5,
        BillingCurrency: "USD",
      }),
    ]);

    expect(result).toMatchObject({
      schema: "FOCUS/1.3",
      source: "provider_billed",
      total_billed_cost: 1.75,
      currency: "USD",
      is_invoice_grade: false,
    });
  });

  it("distinguishes provider-metered usage from provider-billed cost", () => {
    const result = normalizeCloudflareBillableUsage([focusRow()]);

    expect(result).toMatchObject({
      source: "provider_metered",
      total_billed_cost: null,
      currency: null,
      is_invoice_grade: false,
    });
  });
});

describe("Cloudflare fallback price card", () => {
  it("merges a valid partial update without mutating defaults", () => {
    const merged = mergeCfPricing(undefined, {
      workers: { requests: 0.42 },
    });

    expect(merged.workers.requests).toBe(0.42);
    expect(merged.workers.cpu_ms).toBe(0.02);
    expect(mergeCfPricing().workers.requests).toBe(0.3);
  });

  it.each([
    [{ workers: { requests: -1 } }, "non-negative finite number"],
    [{ workers: { requests: "free" } }, "non-negative finite number"],
    [{ workers: { typo: 1 } }, "unknown Cloudflare pricing rate"],
    [{ typo: { requests: 1 } }, "unknown Cloudflare pricing service"],
  ])("rejects invalid or unknown pricing (%j)", (patch, message) => {
    expect(() => mergeCfPricing(undefined, patch)).toThrow(message);
  });
});

describe("generateCostReport", () => {
  it("propagates cancellation to the provider request", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(abort.signal);
      return jsonResponse({
        success: true,
        result: [focusRow({ BilledCost: 1, BillingCurrency: "USD" })],
      });
    });
    const port = createCostAttributionPort({
      accountId: "acct_123",
      token: "token",
      fetch: fetcher as typeof fetch,
    });

    await port.report({
      period: { start: "2026-09-12", end: "2026-09-12", days: 1 },
      scope: { type: "account", id: "acct_123" },
      signal: abort.signal,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("prefers Cloudflare billable cost and exposes account-scoped provenance", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/accounts/acct_123/billable/usage");
      expect(url).toContain("from=2026-09-12");
      expect(url).toContain("to=2026-09-13");
      return jsonResponse({
        success: true,
        result: [focusRow({ BilledCost: 3.25, BillingCurrency: "USD" })],
      });
    });

    const report = await generateCostReport(
      "acct_123",
      "token",
      2,
      undefined,
      { fetch: fetcher as typeof fetch, now: NOW },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      period: { start: "2026-09-12", end: "2026-09-13", days: 2 },
      scope: { type: "account", id: "acct_123" },
      attribution: {
        provider: "cloudflare",
        source: "provider_billed",
        granularity: "account",
        is_invoice_grade: false,
        data_completeness: "complete",
      },
      platform_fee: 0,
      total_cost: 3.25,
      total_estimated_cost: 3.25,
    });
  });

  it("falls back to the price-card estimator when billable usage is unavailable", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/billable/usage")) {
        return jsonResponse({ success: false, errors: [{ message: "forbidden" }] }, 403);
      }
      return jsonResponse({
        data: { viewer: { accounts: [emptyAnalyticsAccount()] } },
      });
    });

    const report = await generateCostReport(
      "acct_123",
      "token",
      2,
      undefined,
      { fetch: fetcher as typeof fetch, now: NOW },
    );

    expect(report).toMatchObject({
      attribution: {
        provider: "cloudflare",
        source: "estimated",
        granularity: "account",
        is_invoice_grade: false,
        data_completeness: "complete",
      },
      platform_fee: 5,
      total_cost: null,
      total_estimated_cost: 5,
    });
    expect(report.attribution.warnings).toContain("provider_billing_unavailable");
  });

  it("calculates a complete non-zero estimate from every supported Analytics dataset", async () => {
    const gib = 1024 ** 3;
    const analyticsAccount = {
      workersInvocationsAdaptive: [{
        sum: { requests: 11_000_000, errors: 2, subrequests: 0 },
        quantiles: { cpuTimeP50: 1, cpuTimeP99: 3 },
        dimensions: { scriptName: "main" },
      }],
      durableObjectsInvocationsAdaptiveGroups: [{
        sum: { requests: 2_000_000 },
        dimensions: { objectName: "SessionDO" },
      }],
      durableObjectsPeriodicGroups: [{
        sum: { cpuTime: 0 },
        max: { wallTime: 0, activeTime: 0 },
      }],
      durableObjectsStorageGroups: [{ max: { storedBytes: 6 * gib } }],
      durableObjectsSqlStorageGroups: [{
        sum: { rowsRead: 0, rowsWritten: 0 },
        max: { databaseSizeBytes: 0 },
      }],
      kvOperationsAdaptiveGroups: [{
        sum: { requests: 11_000_000 },
        dimensions: { actionType: "read" },
      }],
      kvStorageAdaptiveGroups: [{ max: { byteCount: gib } }],
      r2OperationsAdaptiveGroups: [{
        sum: { requests: 2_000_000 },
        dimensions: { actionType: "PutObject", bucketName: "files" },
      }],
      r2StorageAdaptiveGroups: [{
        max: { payloadSize: 10 * gib, objectCount: 1 },
        dimensions: { bucketName: "files" },
      }],
      d1AnalyticsAdaptiveGroups: [{
        sum: { rowsRead: 26_000_000_000, rowsWritten: 0 },
      }],
      d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 5 * gib } }],
      aiInferenceAdaptiveGroups: [{
        sum: { neurons: 1_000 },
        dimensions: { modelName: "test-model" },
      }],
      browserRenderingApiAdaptiveGroups: [{
        sum: { requests: 1, durationMs: 11 * 3_600_000 },
      }],
      containersMetricsAdaptiveGroups: [{
        sum: {
          cpuTimeUs: 23_500 * 1_000_000,
          memoryGiBSeconds: 90_000,
          diskGBSeconds: 0,
        },
      }],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/billable/usage")) {
        return jsonResponse({ success: true, result: [focusRow()] });
      }
      return jsonResponse({ data: { viewer: { accounts: [analyticsAccount] } } });
    });

    const report = await generateCostReport(
      "acct_123",
      "token",
      2,
      undefined,
      { fetch: fetcher as typeof fetch, now: NOW },
    );

    expect(report.attribution).toMatchObject({
      source: "estimated",
      data_completeness: "complete",
    });
    expect(report.total_cost).toBeNull();
    expect(report.total_estimated_cost).toBe(11.77);
    expect(report.services).toMatchObject({
      workers: { status: "available", cost: 0.3 },
      durable_objects: { status: "available", cost: 0.35 },
      kv: { status: "available", cost: 0.5 },
      r2: { status: "available", cost: 4.5 },
      d1: { status: "available", cost: 1 },
      workers_ai: { status: "available", cost: 0.011 },
      browser_rendering: { status: "available", cost: 0.09 },
      containers: { status: "available", cost: 0.02 },
    });
  });

  it("marks a failed analytics dataset unavailable instead of silently reporting zero", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/billable/usage")) {
        return jsonResponse({ success: true, result: [focusRow()] });
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("workersInvocationsAdaptive")) {
        return jsonResponse({ errors: [{ message: "dataset forbidden" }] });
      }
      return jsonResponse({
        data: { viewer: { accounts: [emptyAnalyticsAccount()] } },
      });
    });

    const report = await generateCostReport(
      "acct_123",
      "token",
      2,
      undefined,
      { fetch: fetcher as typeof fetch, now: NOW },
    );

    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.attribution.warnings).toContain("analytics_dataset_unavailable:workers");
    expect(report.services.workers).toMatchObject({
      status: "unavailable",
      usage: {},
      included: {},
      cost: null,
    });
  });
});
