import { describe, expect, it, vi } from "vitest";
import { createCostAttributionPort } from "@open-managed-agents/cost-attribution-vercel";

const PERIOD = { start: "2026-09-12", end: "2026-09-13", days: 2 };

describe("Vercel cost attribution adapter", () => {
  it("streams official FOCUS JSONL using an exclusive provider end and preserves provenance", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.vercel.com/v1/billing/charges");
      expect(url.searchParams.get("teamId")).toBe("team_123");
      expect(url.searchParams.get("from")).toBe("2026-09-12T00:00:00.000Z");
      expect(url.searchParams.get("to")).toBe("2026-09-14T00:00:00.000Z");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(init?.signal).toBe(abort.signal);
      return new Response([
        JSON.stringify({ BilledCost: 1.25, BillingCurrency: "USD", ServiceName: "Sandbox" }),
        JSON.stringify({ BilledCost: 0.75, BillingCurrency: "USD", ServiceName: "Functions" }),
        "",
      ].join("\n"));
    });

    const port = createCostAttributionPort({
      token: "secret",
      teamId: "team_123",
      fetch: fetcher as typeof fetch,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const report = await port.report({
      period: PERIOD,
      scope: { type: "account", id: "team_123" },
      signal: abort.signal,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      total_cost: 2,
      currency: "USD",
      attribution: {
        provider: "vercel",
        source: "provider_billed",
        granularity: "account",
        is_invoice_grade: false,
        data_completeness: "complete",
        reconciled_at: "2026-09-13T12:00:00.000Z",
        warnings: ["provider_billed_cost_not_final_invoice"],
      },
      focus: { schema: "FOCUS/1.3", rows: [{ ServiceName: "Sandbox" }, { ServiceName: "Functions" }] },
    });
  });

  it("does not sum mixed currencies and rejects a different configured account", async () => {
    const port = createCostAttributionPort({
      token: "secret",
      teamId: "team_123",
      fetch: vi.fn(async () => new Response([
        JSON.stringify({ BilledCost: 1, BillingCurrency: "USD" }),
        JSON.stringify({ BilledCost: 1, BillingCurrency: "EUR" }),
      ].join("\n"))) as typeof fetch,
    });

    await expect(port.report({
      period: PERIOD,
      scope: { type: "account", id: "team_other" },
    })).rejects.toThrow(/configured team scope/i);

    await expect(port.report({
      period: PERIOD,
      scope: { type: "account", id: "team_123" },
    })).resolves.toMatchObject({
      total_cost: null,
      currency: null,
      attribution: {
        source: "provider_metered",
        data_completeness: "partial",
        warnings: ["provider_billed_cost_not_final_invoice", "mixed_billing_currencies"],
      },
    });
  });

  it("surfaces provider and malformed JSONL failures instead of returning zero", async () => {
    const failed = createCostAttributionPort({
      token: "secret",
      teamId: "team_123",
      fetch: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
    });
    await expect(failed.report({
      period: PERIOD,
      scope: { type: "account", id: "team_123" },
    })).rejects.toMatchObject({
      code: "permission_denied",
      provider: "vercel",
      status: 403,
      retryable: false,
    });

    const malformed = createCostAttributionPort({
      token: "secret",
      teamId: "team_123",
      fetch: vi.fn(async () => new Response("not-json\n")) as typeof fetch,
    });
    await expect(malformed.report({
      period: PERIOD,
      scope: { type: "account", id: "team_123" },
    })).rejects.toThrow(/invalid Vercel FOCUS JSONL row 1/i);

    const offline = createCostAttributionPort({
      token: "secret",
      teamId: "team_123",
      fetch: vi.fn(async () => { throw new Error("socket closed"); }) as typeof fetch,
    });
    await expect(offline.report({
      period: PERIOD,
      scope: { type: "account", id: "team_123" },
    })).rejects.toMatchObject({
      code: "provider_unavailable",
      provider: "vercel",
      retryable: true,
    });
  });

  it("splits periods beyond the provider maximum and treats a successful empty stream as zero", async () => {
    const fetcher = vi.fn(async () => new Response(""));
    const port = createCostAttributionPort({
      token: "secret",
      teamId: "team_123",
      fetch: fetcher as typeof fetch,
    });

    const report = await port.report({
      period: { start: "2025-01-01", end: "2026-01-01", days: 366 },
      scope: { type: "account", id: "team_123" },
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      total_cost: 0,
      currency: "USD",
      attribution: {
        source: "provider_billed",
        data_completeness: "complete",
      },
    });
  });
});
