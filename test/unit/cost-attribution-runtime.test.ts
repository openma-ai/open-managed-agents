import { describe, expect, it, vi } from "vitest";
import {
  createCostAttributionPort,
  createRuntimeUsageReader,
} from "@open-managed-agents/cost-attribution-runtime";

const PERIOD = { start: "2026-09-12", end: "2026-09-13", days: 2 };

describe("OpenMA runtime ledger cost attribution adapter", () => {
  it("pages immutable usage records and applies a versioned rate card", async () => {
    const abort = new AbortController();
    const list = vi.fn(async ({ afterId }: { afterId: number }) => afterId === 0
      ? [
          { id: 1, tenantId: "tenant_1", sessionId: "s1", kind: "sandbox_active_seconds", value: 120, createdAt: 1 },
          { id: 2, tenantId: "tenant_1", sessionId: "s1", kind: "session_alive_seconds", value: 60, createdAt: 2 },
        ]
      : []);
    const port = createCostAttributionPort({
      tenantId: "tenant_1",
      list,
      rateCard: {
        id: "selfhost-2026-09",
        rates: {
          sandbox_active_seconds: { price: 0.01, unit: 60, currency: "USD" },
          session_alive_seconds: { price: 0.005, unit: 60, currency: "USD" },
        },
      },
      pageSize: 2,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    const result = await port.report({
      period: PERIOD,
      scope: { type: "tenant", id: "tenant_1" },
      signal: abort.signal,
    });

    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tenantId: "tenant_1",
      afterId: 0,
      limit: 2,
      startMs: Date.parse("2026-09-12T00:00:00.000Z"),
      endMs: Date.parse("2026-09-14T00:00:00.000Z"),
      signal: abort.signal,
    }));
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterId: 2 }));
    expect(result).toMatchObject({
      total_cost: 0.025,
      currency: "USD",
      rate_card_id: "selfhost-2026-09",
      usage: { sandbox_active_seconds: 120, session_alive_seconds: 60 },
      attribution: {
        provider: "openma-runtime",
        source: "openma_metered",
        granularity: "tenant",
        is_invoice_grade: false,
        data_completeness: "complete",
        warnings: [],
      },
    });
  });

  it("never undercounts missing rates or mixed currencies", async () => {
    const rows = [
      { id: 1, tenantId: "tenant_1", sessionId: "s1", kind: "sandbox_active_seconds", value: 60, createdAt: 1 },
      { id: 2, tenantId: "tenant_1", sessionId: "s1", kind: "unknown_seconds", value: 60, createdAt: 2 },
    ];
    const missing = createCostAttributionPort({
      tenantId: "tenant_1",
      list: async ({ afterId }) => afterId === 0 ? rows : [],
      rateCard: {
        id: "rates",
        rates: { sandbox_active_seconds: { price: 1, unit: 60, currency: "USD" } },
      },
    });
    await expect(missing.report({
      period: PERIOD,
      scope: { type: "tenant", id: "tenant_1" },
    })).resolves.toMatchObject({
      total_cost: null,
      attribution: {
        data_completeness: "partial",
        warnings: ["missing_rate:unknown_seconds"],
      },
    });

    const mixedRows = [
      rows[0],
      { id: 2, tenantId: "tenant_1", sessionId: "s1", kind: "session_alive_seconds", value: 60, createdAt: 2 },
    ];
    const mixed = createCostAttributionPort({
      tenantId: "tenant_1",
      list: async ({ afterId }) => afterId === 0 ? mixedRows : [],
      rateCard: {
        id: "rates",
        rates: {
          sandbox_active_seconds: { price: 1, unit: 60, currency: "USD" },
          session_alive_seconds: { price: 1, unit: 60, currency: "EUR" },
        },
      },
    });
    await expect(mixed.report({
      period: PERIOD,
      scope: { type: "tenant", id: "tenant_1" },
    })).resolves.toMatchObject({
      total_cost: null,
      currency: null,
      attribution: {
        data_completeness: "partial",
        warnings: ["mixed_billing_currencies"],
      },
    });
  });

  it("passes session scope to the reader and rejects cross-tenant queries", async () => {
    const list = vi.fn(async () => []);
    const port = createCostAttributionPort({
      tenantId: "tenant_1",
      list,
      rateCard: { id: "rates", rates: {} },
    });
    await port.report({ period: PERIOD, scope: { type: "session", id: "s1" } });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));

    await expect(port.report({
      period: PERIOD,
      scope: { type: "tenant", id: "tenant_other" },
    })).rejects.toThrow(/configured tenant scope/i);
  });

  it("adapts the platform UsageStore row shape without coupling to its implementation", async () => {
    const listUsage = vi.fn(async () => [{
      id: 7,
      tenant_id: "tenant_1",
      session_id: "s1",
      agent_id: "agent_1",
      kind: "session_alive_seconds",
      value: 60,
      created_at: 1234,
      billed_at: 5678,
    }]);

    const reader = createRuntimeUsageReader({ listUsage });
    await expect(reader({
      tenantId: "tenant_1",
      sessionId: "s1",
      startMs: 1000,
      endMs: 2000,
      afterId: 0,
      limit: 100,
    })).resolves.toEqual([{
      id: 7,
      tenantId: "tenant_1",
      sessionId: "s1",
      agentId: "agent_1",
      kind: "session_alive_seconds",
      value: 60,
      createdAt: 1234,
    }]);
    expect(listUsage).toHaveBeenCalledWith({
      tenantId: "tenant_1",
      sessionId: "s1",
      startMs: 1000,
      endMs: 2000,
      afterId: 0,
      limit: 100,
    });
  });

  it("normalizes storage failures as retryable provider failures", async () => {
    const port = createCostAttributionPort({
      tenantId: "tenant_1",
      list: async () => { throw new Error("database unavailable"); },
      rateCard: { id: "rates", rates: {} },
    });
    await expect(port.report({
      period: PERIOD,
      scope: { type: "tenant", id: "tenant_1" },
    })).rejects.toMatchObject({
      code: "provider_unavailable",
      provider: "openma-runtime",
      retryable: true,
    });
  });
});
