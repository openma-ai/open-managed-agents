import { describe, expect, it, vi } from "vitest";
import { createCostAttributionPort } from "@open-managed-agents/cost-attribution-blaxel";

const PERIOD = { start: "2026-09-12", end: "2026-09-13", days: 2 };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Blaxel cost attribution adapter", () => {
  it("paginates resource usage without summing the repeated account summary", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.blaxel.ai/v0/accounts/acct_123/metrics");
      expect(url.searchParams.get("startTime")).toBe("2026-09-12T00:00:00.000Z");
      expect(url.searchParams.get("endTime")).toBe("2026-09-14T00:00:00.000Z");
      expect(url.searchParams.get("groupBy")).toBe("resource_uuid");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(new Headers(init?.headers).get("blaxel-version")).toBe("2026-04-16");
      expect(init?.signal).toBe(abort.signal);
      if (!url.searchParams.has("cursor")) {
        return response({
          startTime: "2026-09-12T00:00:00Z",
          endTime: "2026-09-14T00:00:00Z",
          resolution: "hourly",
          summary: { totalCost: 3.5 },
          data: [{ resourceUuid: "sb_1", resourceType: "sandbox", summary: { cost: 2 } }],
          meta: { hasMore: true, nextCursor: "next" },
        });
      }
      return response({
        startTime: "2026-09-12T00:00:00Z",
        endTime: "2026-09-14T00:00:00Z",
        resolution: "hourly",
        summary: { totalCost: 3.5 },
        data: [{ resourceUuid: "sb_2", resourceType: "sandbox", summary: { cost: 1.5 } }],
        meta: { hasMore: false, nextCursor: "" },
      });
    });

    const port = createCostAttributionPort({
      token: "secret",
      accountId: "acct_123",
      fetch: fetcher as typeof fetch,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const report = await port.report({
      period: PERIOD,
      scope: { type: "account", id: "acct_123" },
      signal: abort.signal,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      total_cost: 3.5,
      currency: "USD",
      resources: [{ resourceUuid: "sb_1" }, { resourceUuid: "sb_2" }],
      attribution: {
        provider: "blaxel",
        source: "provider_metered",
        granularity: "account",
        is_invoice_grade: false,
        data_completeness: "complete",
        reconciled_at: "2026-09-13T12:00:00.000Z",
        warnings: ["provider_metering_delay"],
      },
    });
  });

  it("maps workspace and resource scopes to provider filters", async () => {
    const urls: URL[] = [];
    const port = createCostAttributionPort({
      token: "secret",
      accountId: "acct_123",
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        urls.push(new URL(String(input)));
        return response({
          summary: { totalCost: 0 },
          data: [],
          meta: { hasMore: false, nextCursor: "" },
        });
      }) as typeof fetch,
    });

    await port.report({ period: PERIOD, scope: { type: "workspace", id: "production" } });
    await port.report({ period: PERIOD, scope: { type: "resource", id: "sandbox_uuid" } });

    expect(urls[0].searchParams.get("workspace")).toBe("production");
    expect(urls[1].searchParams.get("resourceUuid")).toBe("sandbox_uuid");
  });

  it("fails closed on provider errors and invalid pagination", async () => {
    const forbidden = createCostAttributionPort({
      token: "secret",
      accountId: "acct_123",
      fetch: vi.fn(async () => response({ error: "denied" }, 403)) as typeof fetch,
    });
    await expect(forbidden.report({
      period: PERIOD,
      scope: { type: "workspace", id: "production" },
    })).rejects.toMatchObject({
      code: "permission_denied",
      provider: "blaxel",
      status: 403,
      retryable: false,
    });

    const invalidCursor = createCostAttributionPort({
      token: "secret",
      accountId: "acct_123",
      fetch: vi.fn(async () => response({
        summary: { totalCost: 1 },
        data: [],
        meta: { hasMore: true, nextCursor: "" },
      })) as typeof fetch,
    });
    await expect(invalidCursor.report({
      period: PERIOD,
      scope: { type: "account", id: "acct_123" },
    })).rejects.toThrow(/missing next cursor/i);

    const offline = createCostAttributionPort({
      token: "secret",
      accountId: "acct_123",
      fetch: vi.fn(async () => { throw new Error("socket closed"); }) as typeof fetch,
    });
    await expect(offline.report({
      period: PERIOD,
      scope: { type: "account", id: "acct_123" },
    })).rejects.toMatchObject({
      code: "provider_unavailable",
      provider: "blaxel",
      retryable: true,
    });

    let page = 0;
    const changedSummary = createCostAttributionPort({
      token: "secret",
      accountId: "acct_123",
      fetch: vi.fn(async () => response({
        summary: { totalCost: ++page },
        data: [],
        meta: page === 1
          ? { hasMore: true, nextCursor: "next" }
          : { hasMore: false },
      })) as typeof fetch,
    });
    await expect(changedSummary.report({
      period: PERIOD,
      scope: { type: "account", id: "acct_123" },
    })).rejects.toMatchObject({
      code: "pagination_invariant",
      provider: "blaxel",
      retryable: true,
    });
  });
});
