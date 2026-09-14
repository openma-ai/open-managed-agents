import { describe, expect, it } from "vitest";
import {
  CostAttributionError,
  CostAttributionRegistry,
  costAttributionHttpError,
  costAttributionProviderError,
  normalizeFocusCostAndUsage,
  validateCostPeriod,
  type CostAttributionPort,
  type CostAttributionReport,
} from "@open-managed-agents/cost-attribution";

function fakePort(provider: string, totalCost: number): CostAttributionPort {
  return {
    provider,
    capabilities: () => ({
      sources: ["provider_billed"],
      granularities: ["account"],
      supports_reconciliation: true,
    }),
    report: async (query): Promise<CostAttributionReport> => ({
      period: query.period,
      scope: query.scope,
      attribution: {
        provider,
        source: "provider_billed",
        granularity: query.scope.type,
        is_invoice_grade: true,
        data_completeness: "complete",
        reconciled_at: "2026-09-13T12:00:00.000Z",
        warnings: [],
      },
      total_cost: totalCost,
    }),
  };
}

describe("CostAttributionRegistry", () => {
  it("selects interchangeable provider adapters through one contract", async () => {
    const registry = new CostAttributionRegistry([
      fakePort("cloudflare", 1.25),
      fakePort("modal", 2.5),
    ]);

    expect(registry.list()).toEqual([
      {
        provider: "cloudflare",
        capabilities: {
          sources: ["provider_billed"],
          granularities: ["account"],
          supports_reconciliation: true,
        },
      },
      {
        provider: "modal",
        capabilities: {
          sources: ["provider_billed"],
          granularities: ["account"],
          supports_reconciliation: true,
        },
      },
    ]);

    const query = {
      period: { start: "2026-09-12", end: "2026-09-13", days: 2 },
      scope: { type: "account" as const, id: "acct_123" },
    };

    await expect(registry.report("cloudflare", query)).resolves.toMatchObject({
      total_cost: 1.25,
      attribution: { provider: "cloudflare" },
    });
    await expect(registry.report("modal", query)).resolves.toMatchObject({
      total_cost: 2.5,
      attribution: { provider: "modal" },
    });
  });

  it("rejects duplicate provider registrations and unknown providers", async () => {
    expect(
      () => new CostAttributionRegistry([fakePort("cloudflare", 1), fakePort("cloudflare", 2)]),
    ).toThrow(/duplicate cost attribution provider: cloudflare/i);

    const registry = new CostAttributionRegistry([fakePort("cloudflare", 1)]);
    registry.register(fakePort("modal", 2));
    await expect(
      registry.report("missing", {
        period: { start: "2026-09-13", end: "2026-09-13", days: 1 },
        scope: { type: "account", id: "acct_123" },
      }),
    ).rejects.toThrow(/unknown cost attribution provider: missing/i);
  });
});

describe("FOCUS cost normalization", () => {
  it("is reusable by any provider and only sums one complete currency", () => {
    expect(normalizeFocusCostAndUsage([
      { BilledCost: 1.25, BillingCurrency: "USD" },
      { BilledCost: 0.75, BillingCurrency: "USD" },
    ], { isInvoiceGrade: true })).toMatchObject({
      schema: "FOCUS/1.3",
      source: "provider_billed",
      total_billed_cost: 2,
      currency: "USD",
      is_invoice_grade: true,
      warnings: [],
    });
  });

  it("does not undercount partial cost fields or mixed currencies", () => {
    expect(normalizeFocusCostAndUsage([
      { BilledCost: 1, BillingCurrency: "USD" },
      { BillingCurrency: "USD" },
    ])).toMatchObject({
      source: "provider_metered",
      total_billed_cost: null,
      warnings: ["provider_cost_unavailable"],
    });

    expect(normalizeFocusCostAndUsage([
      { BilledCost: 1, BillingCurrency: "USD" },
      { BilledCost: 1, BillingCurrency: "EUR" },
    ])).toMatchObject({
      source: "provider_metered",
      total_billed_cost: null,
      warnings: ["mixed_billing_currencies"],
    });

    expect(normalizeFocusCostAndUsage([
      { BilledCost: 1, BillingCurrency: "USD" },
      { BilledCost: 1 },
    ])).toMatchObject({
      source: "provider_metered",
      total_billed_cost: null,
      currency: null,
      warnings: ["billing_currency_unavailable"],
    });
  });
});

describe("cost attribution failures", () => {
  it.each([
    [{ start: "2026-02-30", end: "2026-03-01", days: 1 }, /invalid UTC date/i],
    [{ start: "2026-03-02", end: "2026-03-01", days: 0 }, /must not be after/i],
    [{ start: "2026-03-01", end: "2026-03-02", days: 1 }, /days does not match/i],
  ] as const)("classifies an invalid period (%j)", (period, message) => {
    expect(() => validateCostPeriod(period, "acme")).toThrow(message);
    try {
      validateCostPeriod(period, "acme");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_query",
        provider: "acme",
        retryable: false,
      });
    }
  });

  it.each([
    [401, "authentication_failed", false],
    [403, "permission_denied", false],
    [429, "provider_unavailable", true],
    [500, "provider_unavailable", true],
    [400, "invalid_query", false],
  ] as const)("classifies provider HTTP %s", (status, code, retryable) => {
    const error = costAttributionHttpError("acme", status);
    expect(error).toBeInstanceOf(CostAttributionError);
    expect(error).toMatchObject({ provider: "acme", status, code, retryable });
    expect(error.message).toBe(`Acme cost attribution request failed (${status})`);
  });

  it("supports stable non-HTTP invariant failures", () => {
    expect(new CostAttributionError({
      code: "pagination_invariant",
      provider: "acme",
      message: "cursor repeated",
      retryable: false,
    })).toMatchObject({
      name: "CostAttributionError",
      code: "pagination_invariant",
      provider: "acme",
      status: null,
      retryable: false,
    });
  });

  it("normalizes SDK and network failures without double-wrapping typed errors", () => {
    const cause = new Error("socket closed");
    expect(costAttributionProviderError("acme", cause)).toMatchObject({
      code: "provider_unavailable",
      provider: "acme",
      retryable: true,
      cause,
    });

    const typed = costAttributionHttpError("acme", 403);
    expect(costAttributionProviderError("acme", typed)).toBe(typed);
  });
});
