export type CostAttributionSource =
  | "provider_billed"
  | "provider_metered"
  | "openma_metered"
  | "estimated";

export type CostAttributionGranularity =
  | "account"
  | "tenant"
  | "workspace"
  | "project"
  | "environment"
  | "runtime"
  | "session"
  | "resource";

export type CostDataCompleteness = "complete" | "partial" | "unavailable";

export type CostAttributionErrorCode =
  | "invalid_query"
  | "scope_mismatch"
  | "authentication_failed"
  | "permission_denied"
  | "provider_unavailable"
  | "invalid_response"
  | "pagination_invariant"
  | "rate_card_incomplete";

export class CostAttributionError extends Error {
  readonly code: CostAttributionErrorCode;
  readonly provider: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(options: {
    code: CostAttributionErrorCode;
    provider: string;
    message: string;
    status?: number;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "CostAttributionError";
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status ?? null;
    this.retryable = options.retryable;
  }
}

export function costAttributionHttpError(
  provider: string,
  status: number,
): CostAttributionError {
  const code: CostAttributionErrorCode = status === 401
    ? "authentication_failed"
    : status === 403
      ? "permission_denied"
      : status === 400 || status === 404 || status === 410
        ? "invalid_query"
        : "provider_unavailable";
  const retryable = status === 429 || status >= 500;
  const displayProvider = provider.length > 0
    ? provider[0].toUpperCase() + provider.slice(1)
    : provider;
  return new CostAttributionError({
    code,
    provider,
    status,
    retryable,
    message: `${displayProvider} cost attribution request failed (${status})`,
  });
}

/** Normalize transport/SDK failures while preserving already classified errors. */
export function costAttributionProviderError(
  provider: string,
  cause: unknown,
): CostAttributionError {
  if (cause instanceof CostAttributionError) return cause;
  const displayProvider = provider.length > 0
    ? provider[0].toUpperCase() + provider.slice(1)
    : provider;
  return new CostAttributionError({
    code: "provider_unavailable",
    provider,
    message: `${displayProvider} cost attribution provider is unavailable`,
    retryable: true,
    cause,
  });
}

export interface CostPeriod {
  /** Inclusive UTC calendar date. */
  start: string;
  /** Inclusive UTC calendar date. */
  end: string;
  days: number;
}

const COST_DAY_MS = 86_400_000;

export interface ValidatedCostPeriod {
  start: Date;
  end: Date;
  endExclusive: Date;
}

/** Validate the shared inclusive UTC calendar-date contract once for every adapter. */
export function validateCostPeriod(
  period: CostPeriod,
  provider = "cost-attribution",
): ValidatedCostPeriod {
  const parse = (value: string): Date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new CostAttributionError({
        code: "invalid_query",
        provider,
        message: `Invalid UTC date: ${value}`,
        retryable: false,
      });
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new CostAttributionError({
        code: "invalid_query",
        provider,
        message: `Invalid UTC date: ${value}`,
        retryable: false,
      });
    }
    return date;
  };

  const start = parse(period.start);
  const end = parse(period.end);
  if (start > end) {
    throw new CostAttributionError({
      code: "invalid_query",
      provider,
      message: "Cost period start must not be after end",
      retryable: false,
    });
  }
  const actualDays = Math.round((end.getTime() - start.getTime()) / COST_DAY_MS) + 1;
  if (!Number.isInteger(period.days) || period.days !== actualDays) {
    throw new CostAttributionError({
      code: "invalid_query",
      provider,
      message: "Cost period days does not match its bounds",
      retryable: false,
    });
  }
  return {
    start,
    end,
    endExclusive: new Date(end.getTime() + COST_DAY_MS),
  };
}

export interface CostScope {
  type: CostAttributionGranularity;
  id: string;
}

export interface CostAttributionMetadata {
  provider: string;
  /** Source used for total_cost, not merely an auxiliary usage source. */
  source: CostAttributionSource;
  granularity: CostAttributionGranularity;
  is_invoice_grade: boolean;
  data_completeness: CostDataCompleteness;
  reconciled_at: string | null;
  warnings: string[];
}

export interface CostAttributionQuery {
  period: CostPeriod;
  scope: CostScope;
  /** Cancels provider I/O when the caller disconnects or its deadline expires. */
  signal?: AbortSignal;
}

export interface CostAttributionReport {
  period: CostPeriod;
  scope: CostScope;
  attribution: CostAttributionMetadata;
  /** Null means that no authoritative/provider-reported monetary total exists. */
  total_cost: number | null;
}

export interface CostAttributionCapabilities {
  sources: CostAttributionSource[];
  granularities: CostAttributionGranularity[];
  supports_reconciliation: boolean;
}

/** Minimal provider-independent subset of a FinOps FOCUS cost-and-usage row. */
export interface FocusCostAndUsageRow {
  BilledCost?: number;
  BillingCurrency?: string;
  [key: string]: unknown;
}

export interface NormalizedFocusCostAndUsage<
  TRow extends FocusCostAndUsageRow = FocusCostAndUsageRow,
> {
  schema: "FOCUS/1.3";
  source: Extract<CostAttributionSource, "provider_billed" | "provider_metered">;
  total_billed_cost: number | null;
  currency: string | null;
  is_invoice_grade: boolean;
  rows: TRow[];
  warnings: string[];
}

export function normalizeFocusCostAndUsage<TRow extends FocusCostAndUsageRow>(
  rows: TRow[],
  options: { isInvoiceGrade?: boolean; warnings?: string[] } = {},
): NormalizedFocusCostAndUsage<TRow> {
  const billedRows = rows.filter((row) => Number.isFinite(row.BilledCost));
  const currencies = [
    ...new Set(
      billedRows
        .map((row) => row.BillingCurrency)
        .filter((currency): currency is string => Boolean(currency)),
    ),
  ];
  const hasCompleteBilledCost = rows.length > 0 && billedRows.length === rows.length;
  const hasCompleteCurrency = billedRows.length > 0 && billedRows.every(
    (row) => typeof row.BillingCurrency === "string" && row.BillingCurrency.length > 0,
  );
  const hasSingleCurrency = currencies.length === 1;
  const warnings = [...(options.warnings ?? [])];

  if (!hasCompleteBilledCost) warnings.push("provider_cost_unavailable");
  if (hasCompleteBilledCost && !hasCompleteCurrency) {
    warnings.push("billing_currency_unavailable");
  } else if (currencies.length > 1) {
    warnings.push("mixed_billing_currencies");
  }

  const canSumCost = hasCompleteBilledCost && hasCompleteCurrency && hasSingleCurrency;
  return {
    schema: "FOCUS/1.3",
    source: canSumCost ? "provider_billed" : "provider_metered",
    total_billed_cost: canSumCost
      ? +billedRows.reduce((sum, row) => sum + (row.BilledCost ?? 0), 0).toFixed(6)
      : null,
    currency: canSumCost ? (currencies[0] ?? null) : null,
    is_invoice_grade: canSumCost && (options.isInvoiceGrade ?? false),
    rows,
    warnings,
  };
}

export interface CostAttributionPort<
  TReport extends CostAttributionReport = CostAttributionReport,
> {
  readonly provider: string;
  capabilities(): CostAttributionCapabilities;
  report(query: CostAttributionQuery): Promise<TReport>;
}

/**
 * Provider-neutral dispatcher. Provider SDKs and credentials remain isolated
 * in adapter packages; callers select adapters only by provider id.
 */
export class CostAttributionRegistry {
  readonly #ports = new Map<string, CostAttributionPort>();

  constructor(ports: Iterable<CostAttributionPort> = []) {
    for (const port of ports) this.register(port);
  }

  register(port: CostAttributionPort): void {
    if (this.#ports.has(port.provider)) {
      throw new Error(`Duplicate cost attribution provider: ${port.provider}`);
    }
    this.#ports.set(port.provider, port);
  }

  list(): Array<{ provider: string; capabilities: CostAttributionCapabilities }> {
    return [...this.#ports.values()].map((port) => ({
      provider: port.provider,
      capabilities: port.capabilities(),
    }));
  }

  async report(provider: string, query: CostAttributionQuery): Promise<CostAttributionReport> {
    const port = this.#ports.get(provider);
    if (!port) throw new Error(`Unknown cost attribution provider: ${provider}`);
    return port.report(query);
  }
}
