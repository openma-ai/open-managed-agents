import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@open-managed-agents/shared";
import costReportRoutes, {
  resolveCloudflareCostReport,
} from "../../apps/main/src/routes/cost-report";

afterEach(() => vi.unstubAllGlobals());

describe("cost report route", () => {
  it("rejects a tenant credential from the account-scoped report", async () => {
    const response = await costReportRoutes.request(
      "/",
      { headers: { "x-api-key": "tenant-key" } },
      { API_KEY: "operator-key" } as Env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Operator API key required for account-scoped cost reports",
    });
  });

  it("reports missing provider configuration explicitly to the operator", async () => {
    const response = await costReportRoutes.request(
      "/",
      { headers: { "x-api-key": "operator-key" } },
      { API_KEY: "operator-key" } as Env,
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required",
    });
  });

  it("returns the provider-neutral provenance envelope from the configured adapter", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(abort.signal);
      return new Response(JSON.stringify({
      success: true,
      result: [{
        BillingAccountId: "acct_123",
        ChargeCategory: "Usage",
        ChargePeriodStart: "2026-09-13T00:00:00Z",
        ChargePeriodEnd: "2026-09-14T00:00:00Z",
        ConsumedQuantity: 42,
        ConsumedUnit: "Requests",
        x_BillableMetricId: "workers_requests",
        x_BillableMetricName: "Workers Requests",
        x_ProductFamilyName: "Workers",
        BilledCost: 0.25,
        BillingCurrency: "USD",
      }],
      }), { status: 200 });
    });

    const report = await resolveCloudflareCostReport({
      accountId: "acct_123",
      token: "token",
      days: 1,
      pricingJson: null,
      fetch: fetcher as typeof fetch,
      now: new Date("2026-09-13T12:00:00.000Z"),
      signal: abort.signal,
    });

    expect(report).toMatchObject({
      scope: { type: "account", id: "acct_123" },
      attribution: {
        provider: "cloudflare",
        source: "provider_billed",
        granularity: "account",
        is_invoice_grade: false,
      },
      total_cost: 0.25,
    });
  });
});
