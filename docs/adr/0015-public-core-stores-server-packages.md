# ADR 0015: Publish a types-only core, grouped store adapters and a Node composition facade

**Status**: Proposed (2026-11-03)
**Owner**: @hrhrng
**Tracking**: #434
**Supersedes**: None
**Related**: [`packages/managed-agents-application/PORT_BOUNDARIES.md`](../../packages/managed-agents-application/PORT_BOUNDARIES.md), [`docs/release-process.md`](../release-process.md), [Assemble your own control plane](../../apps/docs/src/content/docs/self-host/assemble-control-plane.mdx)

---

## Context

Almost every workspace package is `private`. Only `@openma/cli` and
`@openma/sdk` (an API client) reach npm. Someone who wants a Node control
plane with their own storage has to fork the repository and edit
`packages/control-plane-node` or `apps/main-node`.

The pieces they need already exist, but they are spread over many packages and
have no stability promise:

- Domain models live in `packages/managed-agents-domain`. Inbound application
  Ports and outbound persistence/source/runtime Ports lived next to the use
  cases in `packages/managed-agents-application/src`.
- Each of the 18 storage Ports has three packages: an interface
  (`packages/agent-store`), an in-memory adapter (`agent-store-memory`) and a
  SQL adapter over the driver-neutral `SqlClient` (`agent-store-sql`). That is
  54 packages.
- The module/Port binding kernel (`createApp`, `providePort`, Port tokens) is
  `packages/managed-agents-app`. `packages/platform-node` and
  `packages/platform-sql` already compose every store into one workspace app
  graph. `control-plane-node` builds the production Node control plane on
  `createNodePlatform`.

`PORT_BOUNDARIES.md` already keeps HTTP, ORMs and drivers out of the Ports.
The commit before this ADR (54f7c6d) removed the last host-specific charging
concepts from `SessionsApplicationPort`. Session-create admission is now a
policy-free hook whose denial carries an HTTP status and body. The Ports can
therefore be published without baking in any hosted business policy.

Two Ports landed on `main` while this work was in flight: the `cap_cli` device
authorization flow (#396) and browser/CLI MCP OAuth
(`packages/managed-agents-application/src/ports/cap-cli-device-flow.ts`,
`.../ports/mcp-oauth.ts`).

## Decision

### Public packages

Exactly four new packages are public. Everything else stays `private` and is
bundled into them where needed. We make no API promise for private packages.

| Package | Kind | What it holds | Runtime dependencies |
|---|---|---|---|
| `@openma/core` | types only | Domain models, inbound application Ports, storage Ports, Session runtime Ports, admission hook Ports | none |
| `@openma/stores-memory` | adapters | In-memory adapter for every storage Port, `memoryStores()` | `@openma/core` (types) |
| `@openma/stores-sql` | adapters | SQL adapter for every storage Port over `SqlClient`; SQLite/Postgres/MySQL client factories; `sqlStores()` | `@openma/core`, `effect`; drivers as optional peers |
| `@openma/server` | composition | `createApp` and the module/Port binding API, official modules and their Port tokens, admission defaults, `nodeDefaults()` | `@openma/core`, `@openma/stores-memory`, `@openma/common` |

Adapters are grouped by technology, not by resource. A user picks a storage
technology once and overrides single stores by value. One package per Port
(36 packages) would multiply releases and invite version skew between stores
that read each other (Session resources and events read Sessions).

`@openma/server` depends on `@openma/stores-memory` because `nodeDefaults()`
falls back to memory stores. It does not depend on `@openma/stores-sql`, so a
Node control plane that never touches SQL never installs a driver.

### Export lists

`@openma/core` (every export is a type):

| Subpath | Exports |
|---|---|
| `.` | All inbound application Ports (`AgentsApplicationPort` … `VaultsApplicationPort`, `ManagedAgentsApplicationPorts`), their commands, queries, results and views; outbound source/runtime Ports used by the use cases; admission hooks (`SessionCreateAdmissionPort`, `SessionCreateAdmissionHookPort`, `SessionCreateRateLimiterPort`, `SessionCreateDailyCounterPort`, `SessionWorkAdmissionPort`) |
| `./ports`, `./ports/<resource>` | Inbound application Port per resource |
| `./storage`, `./storage/<resource>` | Storage Ports (`AgentStore` … `VaultStore`, `FileContentStore`), their record and result types, and `ControlPlaneStores` |
| `./runtime/<capability>` | Session runtime command and stream Ports (`context`, `coordination`, `dispatch`, `history`, `lifecycle`, `stream`) |
| `./domain`, `./domain/<resource>` | Domain models shared by both sides of the Ports |

`@openma/stores-memory`: `Memory*Store` / `InMemory*Store` classes for every
storage Port, `memoryStores(overrides?)`, and `ControlPlaneStores`.

`@openma/stores-sql`: `Sql*Store` classes for every storage Port;
`sqlStores(sql, { credentialCipher, deploymentCipher, environmentWorkCipher,
sessionSecrets, overrides })`; `SqlClient` and its statement/result types;
`createBetterSqlite3SqlClient`, `createPostgresSqlClient`,
`createMysql2SqlClient`; the cipher and sealer interfaces. A missing cipher or
sealer fails closed: the affected write rejects.

`@openma/server`:

| Subpath | Exports |
|---|---|
| `.` | `createApp`, `providePort`, `bindPort`, `createPortToken`, `defineAppModule`, `AppCompositionError`, `AppLifecycleError` and their types; `createManagedAgentsApp`, `managedAgentsPortTokens`, `managedAgentsApplicationPortsModule`; `managedAgentsFeatureModules` and feature types; `clockPort`, `idGeneratorPort`, `httpClientPort`, `workspaceContextPort`; `WorkspaceAppRegistry`, `resolveWorkspaceValue`; `nodeDefaults`, `createNodePlatform`, `createNodeManagedAgentsApp` and their option types; `SessionCreateAdmissionService`, `admitAllSessionCreates`, `admitAllSessionWork` |
| `./modules` | Every official module factory (`agentsModule` … `vaultsModule`) and the tokens of the Ports they require (`agentStorePort`, `sessionCreateAdmissionPort`, `sessionWorkAdmissionPort`, …). The launcher the Sessions module provides is `sessionDeploymentLauncherPort`, distinct from the `deploymentSessionLauncherPort` the Deployments module requires. |

### `nodeDefaults()`

`nodeDefaults(options)` returns the module list of one workspace's Node control
plane: workspace context, clock, id generator and HTTP client; a store for
every storage Port; the Credential Vault source derived from the Vault store;
the Session-create admission policy and the Session-work hook; then the
official feature modules (`core` preset by default).

Every input is a value that replaces its default: `stores` (any subset; the
rest are memory stores), `hooks` (`sessionCreate`, `sessionCreateRateLimiter`,
`sessionCreateDailyCounter`, `sessionWork`), `clock`, `ids`, `http`,
`credentialVaults`, `credentialValidation`, `fileContent`, `features` and extra
`modules`. Without hooks the control plane admits all work.
`createNodePlatform` is one `nodeDefaults()` graph per workspace;
`control-plane-node` keeps using it, so the published composition is the one
the product runs.

### `@openma/core` is types only

- It must not declare `dependencies`, `peerDependencies` or
  `optionalDependencies`.
- Every source file must contain only `export type`, `export interface`,
  `export type *` and `import type` statements, and must import only files of
  its own package. `packages/core/test/types-only.test.ts` enforces this.
- It ships declarations plus an empty ES module per declaration file, so a
  value import of a type-only module resolves to nothing instead of failing.
- Runtime defaults (admit-all hooks, the admission policy, error classes) live
  in `@openma/server`, never in core. Implementing a store can therefore never
  pull behaviour or a transitive dependency into the implementer's package.

Ports moved from `managed-agents-application`, `managed-agents-domain`,
`session-runtime-contract` and the 18 `*-store` interface packages into
`packages/core`. The old packages re-export core so internal imports keep
working. The few runtime helpers that lived next to a store interface
(`isCurrentEnvironmentWorkClaim`, `sessionEventSortTime`) stay in their
private package.

### Extension Ports from `main`

- The `cap_cli` credential auth shape is part of `Credential` and of the
  Credentials Port, so it is in core. A custom `CredentialStore` must
  round-trip it.
- The device-flow and MCP OAuth inbound Ports
  (`CapCliDeviceFlowApplicationPort`, `McpOAuthApplicationPort`,
  `McpOAuthCliApplicationPort`) stay in `managed-agents-application` and are
  re-exported from its `ports` entry. No store implements them; they are
  OpenMA extensions that are a few weeks old; their outbound collaborators
  (sealed state, OAuth discovery, CLI rendezvous) are not Ports yet. Adding
  them to core later is a minor release. Removing them from core would be a
  major one.

### Building and publishing

- Public packages are built by `scripts/build-public-package.mjs`.
  `--types-only` (core) runs `tsc` for declarations. The default mode bundles
  JavaScript with esbuild and declarations with rollup-plugin-dts, the way
  `@openma/cli` bundles its internals.
- Private workspace packages a public package bundles must be
  `devDependencies`. `@openma/*` packages and declared `dependencies` /
  `peerDependencies` stay external.
- The build fails when a runtime dependency list names a private workspace
  package, when built files import one, or when built JavaScript imports a
  package that is neither declared nor a Node builtin.
- Dependencies between public packages use `workspace:^`. `pnpm publish`
  (which `changeset publish` runs) rewrites them to a caret range.
- Public packages and their docs must not name customer-charging concepts.
  Generic usage metering (usage, `list_cost`, model prices, `budget_reached`,
  cost attribution) is fine. Hosted charging plugs in through the admission
  hooks.

### Semver

The four packages version independently through changesets.

- `@openma/core`: **any change to an exported Port or type is major.** This
  includes adding a method to a storage Port (existing stores stop
  compiling), adding a member to a result union (exhaustive switches break),
  and making a field required or optional. Adding a new export or subpath is
  minor. Comment-only changes are patch. While the version is `0.x` the same
  rule holds: a Port change uses a `major` changeset.
- `@openma/stores-*`: class names, constructor parameters, factory options
  and the persisted shape are public. A change that needs a schema migration
  is at least minor and says so in the changelog. Internals may change in a
  patch. When core takes a major, the adapters release with it.
- `@openma/server`: exported functions, tokens, module factories and option
  types follow normal semver. Removing a default or changing what
  `nodeDefaults()` binds without an explicit option is major.

## Consequences

- A user can `npm install @openma/server @openma/stores-sql` and start a Node
  control plane, or implement one store against `@openma/core/storage` and pass
  it to `nodeDefaults({ stores: { agents } })`. No fork is needed.
- `@openma/core` changes now cost a major release. Reviewers must treat edits
  under `packages/core/src` as public-contract changes.
- `@openma/server` bundles the application services (about 300 KB of
  JavaScript). Two control planes built from different server versions can run
  different use-case code against the same stores.
- `scripts/release-check.mjs` detects shipped changes only under a public
  package's own `src/`, `README.md` and `package.json`. Changes to a bundled
  private package do not yet demand a changeset, so authors must add one by
  hand until the check follows `devDependencies`.
- `platform-node` and `platform-sql` now get their stores from
  `memoryStores()` and `sqlStores()`, so the published factories and the
  product share one wiring.
- The application root index no longer re-exports the pi model catalog. Its
  only consumers already used the `agents/pi-model-catalog` subpath, and the
  re-export would have bundled every pi-ai provider SDK into the server.

## Alternatives considered

- **Publish every workspace package.** 175 public names with no stability
  intent; any refactor becomes a breaking release.
- **Only `@openma/core` and `@openma/server` (adapters later).** Users could
  write stores but could not run anything without writing all 18 first.
- **One npm package per adapter.** 36 packages, release noise, and version
  skew between stores that read each other.
- **Adapters inside `@openma/server`.** Every server user would install SQL
  drivers and the SQL code even when bringing their own stores.
- **Runtime helpers in core (admit-all constants, error classes).** Breaks the
  "implementing a Port pulls no code" guarantee and makes core releases carry
  behaviour.
- **Declarations by plain `tsc` for bundled packages.** The output imports
  private package names that do not exist on npm.

## Open questions

- **SQL schema.** `@openma/stores-sql` expects the Node control-plane schema
  and does not ship migrations; today they live in `apps/main-node/migrations*`
  (about 6 MB per dialect, with extra pre-steps). Publish them with the
  adapters, or as a separate migrations package?
- **Store conformance kit.** Should a `@openma/stores-testing` package publish
  the contract suites so custom stores can prove CAS, pagination and
  workspace isolation?
- **HTTP edge.** `managed-agents-api` (the `/v1` Hono adapter) stays private.
  `@openma/server` yields application Ports, not an HTTP listener. Publishing
  the HTTP adapter needs its own export list.
- **Release check.** Teach `scripts/release-check.mjs` to treat bundled
  private packages as shipped files of the public package that bundles them.

## Rollout

1. Move Ports and domain types into `packages/core`; keep re-exports in the
   old packages. Verified by root typecheck and the application/app suites.
2. Add `@openma/stores-memory`, `@openma/stores-sql` and `@openma/server`
   with `memoryStores()`, `sqlStores()` and `nodeDefaults()`; rebuild
   `platform-node` / `platform-sql` on them. Verified by package tests and
   `control-plane-node` typecheck.
3. Add `scripts/build-public-package.mjs`, a changeset, the guide and this
   ADR. Verified by building all four packages and inspecting
   `npm pack --dry-run`.
4. After merge, register `release.yml` as the npm trusted publisher for the
   four names (confirm whether npm needs a name to exist before a publisher
   can be added) and let the Version Packages PR publish them.
