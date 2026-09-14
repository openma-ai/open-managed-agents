import type {
  CostAttributionPort,
  CostAttributionQuery,
  CostAttributionReport,
} from "@open-managed-agents/cost-attribution";
import {
  CostAttributionError,
  costAttributionProviderError,
  validateCostPeriod,
} from "@open-managed-agents/cost-attribution";

export interface RuntimeUsageRecord {
  id: number;
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  runtimeId?: string | null;
  kind: string;
  value: number;
  createdAt: number;
}

export interface RuntimeUsageListQuery {
  tenantId: string;
  sessionId?: string;
  startMs: number;
  endMs: number;
  afterId: number;
  limit: number;
  signal?: AbortSignal;
}

/** Structural view of the platform usage ledger; no storage package dependency. */
export interface RuntimeUsageStoreRow {
  id: number;
  tenant_id: string;
  session_id: string;
  agent_id: string | null;
  kind: string;
  value: number;
  created_at: number;
  billed_at: number | null;
}

export interface RuntimeUsageStore {
  listUsage(query: RuntimeUsageListQuery): Promise<RuntimeUsageStoreRow[]>;
}

/** Adapt any UsageStore-compatible ledger to the normalized runtime reader. */
export function createRuntimeUsageReader(
  store: RuntimeUsageStore,
): RuntimeCostAttributionOptions["list"] {
  return async (query) => (await store.listUsage(query)).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    kind: row.kind,
    value: row.value,
    createdAt: row.created_at,
  }));
}

export interface RuntimeUsageRate {
  price: number;
  unit: number;
  currency: string;
}

export interface RuntimeUsageRateCard {
  id: string;
  rates: Record<string, RuntimeUsageRate>;
}

export interface RuntimeCostAttributionReport extends CostAttributionReport {
  currency: string | null;
  rate_card_id: string;
  usage: Record<string, number>;
  records: RuntimeUsageRecord[];
}

export interface RuntimeCostAttributionOptions {
  tenantId: string;
  list(query: RuntimeUsageListQuery): Promise<RuntimeUsageRecord[]>;
  rateCard: RuntimeUsageRateCard;
  pageSize?: number;
  maxPages?: number;
  now?: () => Date;
}

function timeBounds(query: CostAttributionQuery): { startMs: number; endMs: number } {
  const { start, endExclusive } = validateCostPeriod(query.period, "openma-runtime");
  return { startMs: start.getTime(), endMs: endExclusive.getTime() };
}

async function readAll(
  options: RuntimeCostAttributionOptions,
  query: CostAttributionQuery,
): Promise<RuntimeUsageRecord[]> {
  const { startMs, endMs } = timeBounds(query);
  const limit = Math.max(1, Math.min(5_000, Math.floor(options.pageSize ?? 500)));
  const sessionId = query.scope.type === "session" ? query.scope.id : undefined;
  const records: RuntimeUsageRecord[] = [];
  let afterId = 0;

  for (let page = 0; page < (options.maxPages ?? 10_000); page += 1) {
    let batch: RuntimeUsageRecord[];
    try {
      batch = await options.list({
        tenantId: options.tenantId,
        ...(sessionId ? { sessionId } : {}),
        startMs,
        endMs,
        afterId,
        limit,
        signal: query.signal,
      });
    } catch (cause) {
      throw costAttributionProviderError("openma-runtime", cause);
    }
    if (batch.length === 0) return records;
    for (const record of batch) {
      if (!Number.isInteger(record.id) || record.id <= afterId) {
        throw new CostAttributionError({
          code: "pagination_invariant",
          provider: "openma-runtime",
          message: "Runtime usage reader returned a non-monotonic cursor",
          retryable: false,
        });
      }
      if (record.tenantId !== options.tenantId) {
        throw new CostAttributionError({
          code: "scope_mismatch",
          provider: "openma-runtime",
          message: "Runtime usage reader crossed its configured tenant scope",
          retryable: false,
        });
      }
      if (sessionId && record.sessionId !== sessionId) {
        throw new CostAttributionError({
          code: "scope_mismatch",
          provider: "openma-runtime",
          message: "Runtime usage reader crossed its configured session scope",
          retryable: false,
        });
      }
      if (!Number.isFinite(record.value) || record.value < 0) {
        throw new CostAttributionError({
          code: "invalid_response",
          provider: "openma-runtime",
          message: `Invalid runtime usage value for record ${record.id}`,
          retryable: false,
        });
      }
      afterId = record.id;
      records.push(record);
    }
    if (batch.length < limit) return records;
  }
  throw new CostAttributionError({
    code: "pagination_invariant",
    provider: "openma-runtime",
    message: "Runtime usage pagination exceeded its safety limit",
    retryable: false,
  });
}

function attribute(
  records: RuntimeUsageRecord[],
  rateCard: RuntimeUsageRateCard,
): { total: number | null; currency: string | null; usage: Record<string, number>; warnings: string[] } {
  const usage: Record<string, number> = {};
  const warnings: string[] = [];
  const currencies = new Set<string>();
  let total = 0;

  for (const record of records) {
    usage[record.kind] = (usage[record.kind] ?? 0) + record.value;
    const rate = rateCard.rates[record.kind];
    if (!rate) {
      warnings.push(`missing_rate:${record.kind}`);
      continue;
    }
    if (
      !Number.isFinite(rate.price)
      || rate.price < 0
      || !Number.isFinite(rate.unit)
      || rate.unit <= 0
      || !rate.currency
    ) {
      throw new CostAttributionError({
        code: "invalid_query",
        provider: "openma-runtime",
        message: `Invalid runtime usage rate for ${record.kind}`,
        retryable: false,
      });
    }
    currencies.add(rate.currency);
    total += (record.value / rate.unit) * rate.price;
  }

  if (currencies.size > 1) warnings.push("mixed_billing_currencies");
  const uniqueWarnings = [...new Set(warnings)];
  const complete = uniqueWarnings.length === 0;
  return {
    total: complete ? +total.toFixed(6) : null,
    currency: complete && currencies.size === 1 ? [...currencies][0] : null,
    usage,
    warnings: uniqueWarnings,
  };
}

export function createCostAttributionPort(
  options: RuntimeCostAttributionOptions,
): CostAttributionPort<RuntimeCostAttributionReport> {
  return {
    provider: "openma-runtime",
    capabilities: () => ({
      sources: ["openma_metered"],
      granularities: ["tenant", "session"],
      supports_reconciliation: false,
    }),
    report: async (query) => {
      if (query.scope.type === "tenant") {
        if (query.scope.id !== options.tenantId) {
          throw new CostAttributionError({
            code: "scope_mismatch",
            provider: "openma-runtime",
            message: "Runtime cost attribution only supports its configured tenant scope",
            retryable: false,
          });
        }
      } else if (query.scope.type !== "session") {
        throw new CostAttributionError({
          code: "invalid_query",
          provider: "openma-runtime",
          message: `Runtime cost attribution does not support ${query.scope.type} scope`,
          retryable: false,
        });
      }

      const records = await readAll(options, query);
      const result = attribute(records, options.rateCard);
      return {
        period: query.period,
        scope: query.scope,
        attribution: {
          provider: "openma-runtime",
          source: "openma_metered",
          granularity: query.scope.type,
          is_invoice_grade: false,
          data_completeness: result.warnings.length === 0 ? "complete" : "partial",
          reconciled_at: (options.now?.() ?? new Date()).toISOString(),
          warnings: result.warnings,
        },
        total_cost: result.total,
        currency: result.currency,
        rate_card_id: options.rateCard.id,
        usage: result.usage,
        records,
      };
    },
  };
}
