import type {
  CostAttributionPort,
  CostAttributionQuery,
  CostAttributionReport,
  FocusCostAndUsageRow,
  NormalizedFocusCostAndUsage,
} from "@open-managed-agents/cost-attribution";
import {
  CostAttributionError,
  costAttributionHttpError,
  costAttributionProviderError,
  normalizeFocusCostAndUsage,
  validateCostPeriod,
} from "@open-managed-agents/cost-attribution";

const API_BASE = "https://api.vercel.com";
const MAX_WINDOW_DAYS = 365;
const DAY_MS = 86_400_000;

export interface VercelFocusRow extends FocusCostAndUsageRow {
  EffectiveCost?: number;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ConsumedQuantity?: number | null;
  ConsumedUnit?: string | null;
  RegionId?: string;
  RegionName?: string;
  ServiceName?: string;
  ServiceCategory?: string;
  ServiceProviderName?: string;
  Tags?: Record<string, string>;
  PricingCategory?: string;
  PricingCurrency?: string;
  PricingQuantity?: number;
  PricingUnit?: string;
}

export interface VercelCostAttributionReport extends CostAttributionReport {
  currency: string | null;
  focus: NormalizedFocusCostAndUsage<VercelFocusRow>;
}

export interface VercelCostAttributionOptions {
  token: string;
  teamId: string;
  fetch?: typeof fetch;
  now?: () => Date;
  apiBase?: string;
}

interface ProviderWindow {
  from: string;
  to: string;
}

function providerWindows(query: CostAttributionQuery): ProviderWindow[] {
  const { start, endExclusive: overallEndExclusive } = validateCostPeriod(
    query.period,
    "vercel",
  );
  const windows: ProviderWindow[] = [];
  let cursor = start;
  while (cursor < overallEndExclusive) {
    const candidate = new Date(cursor.getTime() + MAX_WINDOW_DAYS * DAY_MS);
    const end = candidate < overallEndExclusive ? candidate : overallEndExclusive;
    windows.push({ from: cursor.toISOString(), to: end.toISOString() });
    cursor = end;
  }
  return windows;
}

export function parseVercelFocusJsonl(body: string): VercelFocusRow[] {
  const rows: VercelFocusRow[] = [];
  let rowNumber = 0;
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    rowNumber += 1;
    try {
      const parsed = JSON.parse(rawLine) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      rows.push(parsed as VercelFocusRow);
    } catch {
      throw new CostAttributionError({
        code: "invalid_response",
        provider: "vercel",
        message: `Invalid Vercel FOCUS JSONL row ${rowNumber}`,
        retryable: false,
      });
    }
  }
  return rows;
}

async function fetchVercelFocusRows(
  options: VercelCostAttributionOptions,
  query: CostAttributionQuery,
): Promise<VercelFocusRow[]> {
  const fetcher = options.fetch ?? fetch;
  const rows: VercelFocusRow[] = [];
  for (const window of providerWindows(query)) {
    const url = new URL("/v1/billing/charges", options.apiBase ?? API_BASE);
    url.searchParams.set("teamId", options.teamId);
    url.searchParams.set("from", window.from);
    url.searchParams.set("to", window.to);
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/x-ndjson, application/json",
        },
        signal: query.signal,
      });
    } catch (cause) {
      throw costAttributionProviderError("vercel", cause);
    }
    if (!response.ok) throw costAttributionHttpError("vercel", response.status);
    rows.push(...parseVercelFocusJsonl(await response.text()));
  }
  return rows;
}

export function createCostAttributionPort(
  options: VercelCostAttributionOptions,
): CostAttributionPort<VercelCostAttributionReport> {
  return {
    provider: "vercel",
    capabilities: () => ({
      sources: ["provider_billed", "provider_metered"],
      granularities: ["account"],
      supports_reconciliation: true,
    }),
    report: async (query) => {
      if (query.scope.type !== "account" || query.scope.id !== options.teamId) {
        throw new CostAttributionError({
          code: "scope_mismatch",
          provider: "vercel",
          message: "Vercel cost attribution only supports its configured team scope",
          retryable: false,
        });
      }
      const rows = await fetchVercelFocusRows(options, query);
      const focus: NormalizedFocusCostAndUsage<VercelFocusRow> = rows.length === 0
        ? {
            schema: "FOCUS/1.3",
            source: "provider_billed",
            total_billed_cost: 0,
            currency: "USD",
            is_invoice_grade: false,
            rows,
            warnings: ["provider_billed_cost_not_final_invoice"],
          }
        : normalizeFocusCostAndUsage(rows, {
            isInvoiceGrade: false,
            warnings: ["provider_billed_cost_not_final_invoice"],
          });
      const complete = focus.source === "provider_billed";
      return {
        period: query.period,
        scope: query.scope,
        attribution: {
          provider: "vercel",
          source: focus.source,
          granularity: query.scope.type,
          is_invoice_grade: focus.is_invoice_grade,
          data_completeness: complete ? "complete" : "partial",
          reconciled_at: (options.now?.() ?? new Date()).toISOString(),
          warnings: focus.warnings,
        },
        total_cost: focus.total_billed_cost,
        currency: focus.currency,
        focus,
      };
    },
  };
}
