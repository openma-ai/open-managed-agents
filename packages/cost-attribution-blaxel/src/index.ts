import type {
  CostAttributionPort,
  CostAttributionQuery,
  CostAttributionReport,
} from "@open-managed-agents/cost-attribution";
import {
  CostAttributionError,
  costAttributionHttpError,
  costAttributionProviderError,
  validateCostPeriod,
} from "@open-managed-agents/cost-attribution";

const API_BASE = "https://api.blaxel.ai";
const API_VERSION = "2026-04-16";
export interface BlaxelCostSummary {
  cost?: number;
  usage?: number;
}

export interface BlaxelCostTimeseriesPoint {
  timestamp?: string;
  cost?: number;
  usage?: number;
}

export interface BlaxelCostResource {
  workspace?: string;
  resourceType?: string;
  resourceName?: string;
  resourceUuid?: string;
  billingDimension?: string;
  summary: BlaxelCostSummary;
  timeseries?: BlaxelCostTimeseriesPoint[];
}

interface BlaxelMetricsPage {
  startTime?: string;
  endTime?: string;
  resolution?: string;
  summary: { totalCost: number; totalUsage?: number };
  data: BlaxelCostResource[];
  meta: { hasMore: boolean; nextCursor?: string };
}

export interface BlaxelCostAttributionReport extends CostAttributionReport {
  currency: "USD";
  resolution: string | null;
  resources: BlaxelCostResource[];
}

export interface BlaxelCostAttributionOptions {
  token: string;
  accountId: string;
  fetch?: typeof fetch;
  now?: () => Date;
  apiBase?: string;
  maxPages?: number;
}

function timeBounds(query: CostAttributionQuery): { startTime: string; endTime: string } {
  const { start, endExclusive } = validateCostPeriod(query.period, "blaxel");
  return {
    startTime: start.toISOString(),
    endTime: endExclusive.toISOString(),
  };
}

function assertPage(value: unknown): asserts value is BlaxelMetricsPage {
  const page = value as Partial<BlaxelMetricsPage> | null;
  if (
    typeof page !== "object"
    || page === null
    || !Array.isArray(page.data)
    || typeof page.summary?.totalCost !== "number"
    || !Number.isFinite(page.summary.totalCost)
    || typeof page.meta?.hasMore !== "boolean"
  ) {
    throw new CostAttributionError({
      code: "invalid_response",
      provider: "blaxel",
      message: "Invalid Blaxel billing response",
      retryable: false,
    });
  }
}

function applyScope(url: URL, query: CostAttributionQuery, accountId: string): void {
  switch (query.scope.type) {
    case "account":
      if (query.scope.id !== accountId) {
        throw new CostAttributionError({
          code: "scope_mismatch",
          provider: "blaxel",
          message: "Blaxel cost attribution only supports its configured account scope",
          retryable: false,
        });
      }
      return;
    case "workspace":
      url.searchParams.set("workspace", query.scope.id);
      return;
    case "resource":
      url.searchParams.set("resourceUuid", query.scope.id);
      return;
    default:
      throw new CostAttributionError({
        code: "invalid_query",
        provider: "blaxel",
        message: `Blaxel cost attribution does not support ${query.scope.type} scope`,
        retryable: false,
      });
  }
}

async function fetchMetrics(
  options: BlaxelCostAttributionOptions,
  query: CostAttributionQuery,
): Promise<{ totalCost: number; resolution: string | null; resources: BlaxelCostResource[] }> {
  const fetcher = options.fetch ?? fetch;
  const { startTime, endTime } = timeBounds(query);
  const resources: BlaxelCostResource[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let totalCost: number | undefined;
  let resolution: string | null = null;

  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 1_000); pageNumber += 1) {
    const url = new URL(
      `/v0/accounts/${encodeURIComponent(options.accountId)}/metrics`,
      options.apiBase ?? API_BASE,
    );
    url.searchParams.set("startTime", startTime);
    url.searchParams.set("endTime", endTime);
    url.searchParams.set("groupBy", "resource_uuid");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    applyScope(url, query, options.accountId);

    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Blaxel-Version": API_VERSION,
          Accept: "application/json",
        },
        signal: query.signal,
      });
    } catch (cause) {
      throw costAttributionProviderError("blaxel", cause);
    }
    if (!response.ok) throw costAttributionHttpError("blaxel", response.status);
    const payload: unknown = await response.json();
    assertPage(payload);
    if (totalCost === undefined) totalCost = payload.summary.totalCost;
    else if (payload.summary.totalCost !== totalCost) {
      throw new CostAttributionError({
        code: "pagination_invariant",
        provider: "blaxel",
        message: "Blaxel billing summary changed while paginating",
        retryable: true,
      });
    }
    resolution ??= payload.resolution ?? null;
    resources.push(...payload.data);
    if (!payload.meta.hasMore) return { totalCost, resolution, resources };

    const nextCursor = payload.meta.nextCursor;
    if (!nextCursor) {
      throw new CostAttributionError({
        code: "pagination_invariant",
        provider: "blaxel",
        message: "Blaxel billing response is missing next cursor",
        retryable: false,
      });
    }
    if (seenCursors.has(nextCursor)) {
      throw new CostAttributionError({
        code: "pagination_invariant",
        provider: "blaxel",
        message: "Blaxel billing pagination cursor repeated",
        retryable: false,
      });
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new CostAttributionError({
    code: "pagination_invariant",
    provider: "blaxel",
    message: "Blaxel billing pagination exceeded its safety limit",
    retryable: false,
  });
}

export function createCostAttributionPort(
  options: BlaxelCostAttributionOptions,
): CostAttributionPort<BlaxelCostAttributionReport> {
  return {
    provider: "blaxel",
    capabilities: () => ({
      sources: ["provider_metered"],
      granularities: ["account", "workspace", "resource"],
      supports_reconciliation: false,
    }),
    report: async (query) => {
      const result = await fetchMetrics(options, query);
      return {
        period: query.period,
        scope: query.scope,
        attribution: {
          provider: "blaxel",
          source: "provider_metered",
          granularity: query.scope.type,
          is_invoice_grade: false,
          data_completeness: "complete",
          reconciled_at: (options.now?.() ?? new Date()).toISOString(),
          warnings: ["provider_metering_delay"],
        },
        total_cost: result.totalCost,
        currency: "USD",
        resolution: result.resolution,
        resources: result.resources,
      };
    },
  };
}
