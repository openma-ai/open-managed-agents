# Cost attribution Port

`@open-managed-agents/cost-attribution` is the provider-neutral contract for
infrastructure cost reporting. It deliberately does not import a provider SDK.

Adapters declare:

- where the number came from (`provider_billed`, `provider_metered`,
  `openma_metered`, or `estimated`);
- the narrowest scope the provider can prove;
- whether the result is complete and invoice-grade;
- when provider data was reconciled and any warnings.

`CostAttributionRegistry` selects adapters by provider id. Provider-specific
payloads belong in the adapter report, while the common provenance and total
remain stable. Never convert an unavailable provider dataset into zero usage.

Adapters are isolated packages:

- `@open-managed-agents/cost-attribution-cloudflare` reads Cloudflare FOCUS
  billable usage and uses Analytics plus a price card only as an explicitly
  estimated fallback.
- `@open-managed-agents/cost-attribution-vercel` reads the official FOCUS 1.3
  JSONL stream and splits queries longer than the one-year provider limit.
- `@open-managed-agents/cost-attribution-blaxel` reads the account Billing
  Explorer API with cursor-safe pagination and optional workspace/resource
  scoping.
- `@open-managed-agents/cost-attribution-runtime` prices immutable OpenMA
  usage records with a versioned operator rate card for tenant/session
  allocation. It is never presented as a provider invoice.

FOCUS rows remain FOCUS rows. Provider-native reports are not relabeled as
FOCUS; only their common provenance, scope, completeness, currency, and total
are projected into `CostAttributionReport`.

## Runtime ledger composition

The runtime adapter accepts a structural reader instead of importing a storage
package. A self-host composition can connect the platform `UsageStore` without
coupling the adapter to D1, SQLite, or Postgres:

```ts
import { createCostAttributionPort, createRuntimeUsageReader }
  from "@open-managed-agents/cost-attribution-runtime";

const costs = createCostAttributionPort({
  tenantId,
  list: createRuntimeUsageReader(services.usage),
  rateCard: {
    id: "self-host-2026-09",
    rates: {
      sandbox_active_seconds: { price: 0.01, unit: 60, currency: "USD" },
    },
  },
});
```

The ledger read includes both acknowledged and unacknowledged events, uses an
inclusive/exclusive UTC window plus immutable id cursor, and has a matching
`(tenant_id, created_at, id)` index in every supported SQL schema. A missing
rate, missing FOCUS currency, or mixed currency makes the monetary total null.

Every query may carry an `AbortSignal`. HTTP adapters pass it to `fetch`, and
the SQL reader checks it around I/O.
Transport and SDK failures use stable `CostAttributionError` codes; credentials
never appear in the query, report, or error message.
