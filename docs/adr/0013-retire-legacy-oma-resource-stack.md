# ADR 0013: Retire the legacy OMA resource stack

**Status**: Proposed (2026-10-29)

**Related**: [`0006-session-execution-authority.md`](0006-session-execution-authority.md),
[`0011-matter-bond-and-loop.md`](0011-matter-bond-and-loop.md)

---

## Context

OMA has two implementations of the same resources.

- **Managed**: the `/v1/*` API on the shared Managed Agents application. Each
  resource has a store port (`agent-store`, `session-store`, `vault-store`,
  ...) with memory and SQL adapters, and SQL tables named `managed_*`.
- **Legacy**: the `/v1/oma/<resource>` routes in `http-routes`, backed by the
  drizzle services `agents-store`, `sessions-store`, `vaults-store`,
  `credentials-store`, `environments-store`, `files-store`, `dreams-store` and
  `memory-store`, and their tables `agents`, `sessions`, `vaults`, ...

The managed stack was added beside the legacy one, and the legacy one was
never removed. Since then:

- New data is written by the managed stack. The legacy tables are empty or
  stale in a deployment created after the managed API shipped.
- Legacy code that looks up a managed resource does not find it. The Console
  adds a CLI credential through `POST /v1/oma/vaults/:id/credentials`; the
  legacy vault service looks in `vaults`, the vault is in `managed_vaults`,
  and the request returns 404.
- Agents are the exception. The SQL `AgentStore` reads and writes the legacy
  `agents` table through a snake_case codec, so both stacks share one table
  and each consumer converts between two shapes.
- Two session runtimes run side by side. Managed Sessions run on the managed
  runtime host. Legacy Sessions (`/v1/oma/sessions`, the integration install
  bridge, evals) run on `SessionRegistry` and the `sessions` table.
- Docs describe the legacy path as current, for example
  [`self-host.md`](../self-host.md) says `/v1/sessions` runs on
  `SessionRegistry`.

## Decision

Remove the legacy stack. Running code uses only the managed stack.

### Rules while removal is in progress

1. No new caller of a legacy service, route or table.
2. Managed code never reads or writes a legacy table, and never converts to
   or from a legacy shape at runtime.
3. Each removal deletes the service package, its routes, its schema
   definitions, and every Console call to it in one change. Retired agent
   tables are retained empty in all four SQL dialects; no runtime code uses
   them. Nothing is left marked deprecated.
4. A migration that drops a legacy table fails if the table still has rows
   that were not converted. It never drops data silently, and there is no
   runtime fallback to the old table.
5. Data conversion is code only where a deployment has live data in the
   legacy table (agents). Elsewhere the drop migration refuses non-empty
   tables and the upgrade notes describe the manual move.

### In scope

| Area | Legacy | Replacement |
|---|---|---|
| Agents | `agents-store`, `agents`, `agent_versions`, DELETE `/v1/oma/agents/:id` | `AgentStore` on `managed_agents`, `/v1/agents` |
| Integrations | install bridge, `/v1/oma/integrations/{linear,slack,github,feishu}`, provider tables (`*_installations`, `*_publications`, ...) | Matter Bond and Loop (ADR 0011) |
| Sessions | `sessions-store`, `SessionRegistry`, `NodeSessionRouter`, `/v1/oma/sessions`, `sessions` | managed Sessions, `/v1/sessions` |
| Vaults, credentials | `vaults-store`, `credentials-store`, `/v1/oma/vaults` | `/v1/vaults` |
| Environments | `environments-store`, `/v1/oma/environments` | `/v1/environments` |
| Files | `files-store`, `/v1/oma/files` | `/v1/files` |
| Memory stores | `memory-store`, `/v1/oma/memory_stores` | `/v1/memory_stores` |
| Dreams | `dreams-store`, `/v1/oma/dreams` | `/v1/dreams` |
| Skills | `/v1/oma/skills` | `/v1/skills` |

### Out of scope

OMA-only resources without a `/v1` counterpart stay under `/v1/oma`: evals,
stats, model cards, models, tenants, me, API keys, harnesses, sandbox images,
runtimes, skill sources, OAuth, CAP CLI, cost report, MCP proxy and inference
proxy. Their implementation changes only where it calls a legacy service
(evals and stats call the legacy agent and session services today).

## Order

Each step is one pull request. A step starts after the previous one merges.

1. **Agents.** `AgentStore` moves to `managed_agents` and stores the domain
   document. `agents-store` is deleted. Session start, evals and the install
   bridge read the agent from `AgentStore` and build the runtime snapshot with
   the managed runtime encoder, which also carries `acp`, `runtime_binding`
   and `metadata`. The migration converts `agents` and `agent_versions` to
   `managed_*`, deletes the converted legacy rows, and retains the empty
   legacy tables. This retirement requires no `DROP` privilege.
2. **Host Slack, Linear and GitHub as Matter Loops.** OMA Matter hosts the
   OpenMatter Slack, Linear and GitHub integrations the same way it hosts
   Feishu and GitLab, with Console setup for each. Their Sessions are managed
   Sessions.
3. **Integrations.** Delete the install bridge, the legacy integration routes,
   their Console pages and provider tables. Every provider now runs as a
   Matter Loop.
4. **Evals on managed Sessions.** The eval runner creates managed Sessions.
5. **Session runtime.** Delete `sessions-store`, `SessionRegistry`,
   `NodeSessionRouter`, `/v1/oma/sessions` and the `sessions` table.
6. **Remaining resources.** Vaults, credentials, environments, files, memory
   stores, dreams and skills. The Console switches to the `/v1` routes first.
7. **Docs.** Remove the legacy path from `self-host.md`, the architecture docs
   and the API reference. Publish the upgrade notes below.

## Upgrade notes for self-hosted deployments

- Node deployments upgrade through step 1 in one go: agents and version
  history are converted automatically before schema migration. D1 operators
  first run `pnpm tsx scripts/migrate-legacy-agents.ts --db=<d1-database-id>`
  on every database holding agents, then apply migration 0024.
- Agent retirement retains empty `agents` and `agent_versions` tables; no
  runtime lookup uses them. Migration guards still stop on unconverted rows.
  MySQL no longer needs `DROP` permission for this upgrade.
- Migration names/numbers and snapshot IDs remain unchanged. Existing
  databases already at the retirement snapshot restart normally, including
  those where the previous release dropped the old tables. The snapshots
  describe the managed runtime schema; retained legacy tables are inert.
- For steps 3 to 6, a deployment that still has rows in a legacy table stops
  at the drop migration with the table name. Move the data through the `/v1`
  API (create the resource again) or delete it, then rerun the migration.
- Clients of `/v1/oma/<resource>` for an in-scope resource move to the `/v1`
  route of the same name. Request and response bodies follow the `/v1` API.

## Consequences

- One store, one table and one shape per resource. No codec between shapes.
- `/v1/oma` keeps only OMA-only resources.
- Slack, Linear and GitHub keep working: their Loops are hosted (step 2)
  before the install bridge is deleted (step 3). Existing installations are
  set up again as Matter connections.
- Self-hosters with data only in legacy tables must move it by hand.

## Open questions

- Cloudflare D1 cannot run conversion code in a migration. Step 1 needs a
  one-off conversion command for D1, or a guard that stops the migration and
  points to it.

## Unverified

- Whether any Cloudflare deployment has rows in a legacy table other than
  `agents`.
- Whether the legacy SessionDO path on Cloudflare shares code that the managed
  runtime still needs; this decides how much of step 4 applies there.
