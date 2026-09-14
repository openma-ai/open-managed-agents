import type {
  CostPeriod,
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

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_BILLABLE_USAGE_DAYS = 31;

export interface CloudflareBillableUsageRow extends FocusCostAndUsageRow {
  BillingAccountId?: string;
  BillingAccountName?: string;
  BillingCurrency?: string;
  BilledCost?: number;
  EffectiveCost?: number;
  ListCost?: number;
  ChargeCategory?: string;
  ChargeDescription?: string;
  ChargeFrequency?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ConsumedQuantity?: number;
  ConsumedUnit?: string;
  ServiceName?: string;
  RegionId?: string;
  RegionName?: string;
  Tags?: Record<string, string> | Array<{ Key?: string; Value?: string }>;
  x_BillableMetricId?: string;
  x_BillableMetricName?: string;
  x_ProductFamilyId?: string;
  x_ProductFamilyName?: string;
  [key: string]: unknown;
}

interface CloudflareApiEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

export type NormalizedCloudflareBillableUsage =
  NormalizedFocusCostAndUsage<CloudflareBillableUsageRow> & {
    is_invoice_grade: false;
  };

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

/** Cloudflare's billable usage endpoint accepts at most 31 calendar days. */
export function splitCloudflareBillingPeriod(period: CostPeriod): CostPeriod[] {
  const { start: overallStart, end: overallEnd } = validateCostPeriod(period, "cloudflare");

  const windows: CostPeriod[] = [];
  let cursor = overallStart;
  while (cursor <= overallEnd) {
    const candidateEnd = addUtcDays(cursor, MAX_BILLABLE_USAGE_DAYS - 1);
    const windowEnd = candidateEnd < overallEnd ? candidateEnd : overallEnd;
    const days = Math.round((windowEnd.getTime() - cursor.getTime()) / 86_400_000) + 1;
    windows.push({ start: formatUtcDate(cursor), end: formatUtcDate(windowEnd), days });
    cursor = addUtcDays(windowEnd, 1);
  }
  return windows;
}

export async function fetchCloudflareBillableUsage(
  accountId: string,
  token: string,
  period: CostPeriod,
  fetcher: typeof fetch = fetch,
): Promise<CloudflareBillableUsageRow[]> {
  const rows: CloudflareBillableUsageRow[] = [];
  for (const window of splitCloudflareBillingPeriod(period)) {
    const url = new URL(
      `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/billable/usage`,
    );
    url.searchParams.set("from", window.start);
    url.searchParams.set("to", window.end);
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (cause) {
      throw costAttributionProviderError("cloudflare", cause);
    }
    if (!response.ok) {
      throw costAttributionHttpError("cloudflare", response.status);
    }
    const payload = (await response.json()) as CloudflareApiEnvelope<CloudflareBillableUsageRow[]>;
    if (payload.success === false || !Array.isArray(payload.result)) {
      const message = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new CostAttributionError({
        code: "invalid_response",
        provider: "cloudflare",
        message: `Cloudflare billable usage response failed${message ? `: ${message}` : ""}`,
        retryable: false,
      });
    }
    rows.push(...payload.result);
  }
  return rows;
}

export function normalizeCloudflareBillableUsage(
  rows: CloudflareBillableUsageRow[],
): NormalizedCloudflareBillableUsage {
  return normalizeFocusCostAndUsage(rows, {
    // Cloudflare documents this endpoint as alpha. Provider-reported is not
    // the same promise as a finalized invoice.
    isInvoiceGrade: false,
    warnings: ["provider_billing_api_alpha"],
  }) as NormalizedCloudflareBillableUsage;
}
