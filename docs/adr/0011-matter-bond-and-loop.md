# ADR 0011: Matter, Bond and Loop in OMA, starting with GitLab and Feishu

**Status**: Proposed (2026-10-14)

**Related**: [`0004-feishu-integration.md`](0004-feishu-integration.md),
[`0006-session-execution-authority.md`](0006-session-execution-authority.md),
[`0007-sandbox-credential-egress.md`](0007-sandbox-credential-egress.md),
[`0009-github-bonds.md`](0009-github-bonds.md),
[`0010-gitlab-bonds.md`](0010-gitlab-bonds.md),
OpenMatter [`docs/BONDS.md`](https://github.com/openma-ai/OpenMatter/blob/main/docs/BONDS.md),
[`docs/LOOPS.md`](https://github.com/openma-ai/OpenMatter/blob/main/docs/LOOPS.md),
and [`docs/IDENTITY_MODEL.md`](https://github.com/openma-ai/OpenMatter/blob/main/docs/IDENTITY_MODEL.md)

---

## Context

OMA connects agents to outside systems through four provider stacks: Linear,
GitHub, Slack, and Feishu. Each stack owns its own credentials, webhook
deduplication, Session binding, and reply path. None of them shares:

- account linking, or a way to map a provider user to an OMA user;
- a per-agent grant that limits what an agent may touch;
- exactly-once handling of an inbound event with a recorded outcome;
- a way for a workspace to change the behavior without changing OMA.

ADR 0009 and ADR 0010 adopt the OpenMatter Bond module for repository access.
They cover credentials and principals for a Session. They do not cover the
other half of an integration: reacting to events in the provider and replying
there.

OpenMatter implements that other half as Loops. A Loop subscribes to events,
associates each event with a WorkThread, projects context, optionally runs an
Agent turn, and commits exactly one terminal Reaction per accepted event. The
runtime, the store and inbox ports, and the GitHub, Linear, and Slack
integrations are on OpenMatter `main`. The Bond kernel and the GitLab Bond
binding landed in OpenMatter #9 and #10. There is no GitLab or Feishu
integration, and no Feishu Bond binding.

### Feishu today

The Feishu stack is the one most in need of this work:

- `feishu_publications` (`packages/db-schema/src/cf-integrations/feishu.ts`)
  holds both the agent binding and the app credentials (`app_id` plus three
  ciphertexts). `feishu_installations` holds placeholder credentials only.
- Two inbound paths, the webhook gateway in
  `packages/http-routes/src/integrations/gateway.ts` and the long-connection
  runner in `apps/main-node/src/lib/ws-feishu-runner.ts`, both deduplicate
  through `feishu_webhook_events` keyed by `message_id`.
- The runner starts only when `FEISHU_WS_RUNNER` is set and the process mode
  is standalone (`apps/main-node/src/modules/node-http.ts`). It assumes a
  single replica.
- Only `im.message.receive_v1` text messages are handled. Every Session is
  created as the publication owner. There is no mapping from the sender's
  `open_id` to an OMA user.
- The reply (`apps/main-node/src/lib/feishu-egress-writer.ts`) sends the first
  `agent.message` once, through the in-process event stream hub. Delivery is
  not recorded.
- The Session granularity chosen in the publish wizard is not persisted; the
  effective value is always per chat and user. Stored capabilities are not
  enforced. Unpublishing does not revoke the installation.
- `feishu_apps`, `feishu_setup_links`, and the operations tables are not read
  or written at runtime.

### What this ADR adds to 0009 and 0010

ADR 0009 and ADR 0010 decide how a Session gets a repository credential. This
ADR decides:

- the product model that places Bond and Loop in the console and API;
- that OMA core contains no provider code, and the packages that follow;
- the access rule that ties a Bond to an agent and a Session;
- how OMA hosts the OpenMatter runtime;
- how users define Loops, as code or from a form, and how OMA runs them;
- the migration order, GitLab and Feishu first.

## Decision

### Product model

OMA has four layers. The first and third are grouped in the console as
**Matter**:

| Layer    | What it is                                                                 |
| -------- | -------------------------------------------------------------------------- |
| Bond     | A provider app enabled in a workspace, its installations, and users' links |
| Agents   | Agent configurations, now with grants on Bonds                             |
| Loops    | Event-driven processes that keep an agent present in a provider            |
| Sessions | Agent runs, created by a person, the API, or a Loop                        |

The console sidebar gains a group named **Matter** with two items, **Bond**
(`/matter/bonds`) and **Loop** (`/matter/loops`). The existing Integrations
group keeps its Linear, GitHub, and Slack entries until each of them moves.
Its Feishu entry moves when the Feishu migration below ships.

"Bond" is the OpenMatter term. OMA uses it in the console, the API, and the
schema, as ADR 0009 and ADR 0010 already do.

In the console and the API, a Bond is one provider app enabled in a
workspace: one `bond_provider_apps` row. A GitLab instance (ADR 0010), a
Feishu app, and the deployment's GitHub App (ADR 0009) are each one Bond. A
workspace gets its GitHub row the first time it connects. Installations and
user links belong to that row, as ADR 0009 already stores them, and
`bond_id` everywhere below is its ID.

### OMA core knows no provider

OMA core (the control-plane library, `matter-host`, `db-schema`,
`http-routes`, and the console) contains no Feishu, GitLab, Slack, or Linear
code. All provider knowledge lives in one OpenMatter package per provider,
`@openma/matter-<provider>`, exported from its `/bond` subpath:

| Part        | Owns                                                                                |
| ----------- | ----------------------------------------------------------------------------------- |
| Binding     | Install and link flows, token minting and refresh, the resource catalog, a manifest |
| Integration | Event ingest, event sources, Effect delivery, agent tools, built-in Loop templates  |

The Bond binding manifest declares what the console needs to render
generically:

- the install form, as a JSON Schema with secret fields marked;
- link methods (`oauth`, `pat`, or none) and their redirect requirements;
- resource kinds and the operations each supports;
- display data: name, icon, and documentation link.

The resource catalog has two operations: `list(query)` for pickers and
`validate(resource, operations, principal)` for the access rule. Resource IDs
are opaque strings chosen by the binding, such as `project:42` for GitLab,
`repo:acme/api` for GitHub, and `chat:oc_...` for Feishu.

A distribution names the providers it ships in one list, the same way
`main-node` picks a database adapter:

```ts
providers: [
  { bond: gitlabBond, integration: gitlabIntegration },
  { bond: feishuBond, integration: feishuIntegration },
]
```

OMA routes, tables, and console pages are written against that registry. A
deployment that ships only GitLab and Feishu registers only those two. Adding
a provider adds packages in OpenMatter and one line in the distribution.

Two exceptions are allowed:

- `github_repository` is a Claude Managed Agents resource type. OMA keeps
  resolving it for compatibility (ADR 0009, "Session API").
- The one-off Feishu migration below reads the legacy `feishu_*` tables. It
  is deleted with the legacy routes.

### Package layout

OpenMatter publishes a kernel package and one package per provider:

| Package                 | Status                | Contents                                                                                              |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `@openma/matter`        | exists                | The kernel, one subpath per port: `.` (core), `/credentials`, `/bond`, `/store`, `/inbox`, `/integration`, `/agent`, `/runtime`, `/http` |
| `@openma/matter-loop`   | new                   | The guest SDK. No dependencies                                                                        |
| `@openma/matter-gitlab` | exists, Binding only  | `/bond`: the GitLab Binding and Integration                                                           |
| `@openma/matter-feishu` | new                   | `/bond`: the Feishu Binding and Integration                                                           |

- `/store` exports the store and inbox conformance suites, and `/runtime`
  hosts `@openma/matter-loop` guests.
- Inside a provider package, the Integration depends on the `credentials`
  port, never on the Binding beside it, as the GitHub and Slack integrations
  do today. The host passes it credentials minted by the
  Bond.
- Reference adapters, the Slack, GitHub, and Linear provider packages, and
  the hosts stay private in the OpenMatter repository until they have a consumer
  outside it.
- `@openma/matter-loop` is the guest SDK used by Loop code inside an isolate. It has no
  dependencies, including `effect`, and its API is plain `async` functions
  that call the host over RPC. It also holds the host and guest protocol
  types. `/runtime` adapts that protocol to its Effect-based `WorkContext`.
  Built-in templates in the provider packages import only
  `@openma/matter-loop`, so they run the same way as user code.

OMA:

| Package                    | Owns                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `matter-host`              | The OpenMatter store, inbox, agent driver, Bond store, provider registry, access rule, the Loop runner contract, and the in-process runner for built-in templates |
| `loop-runner-workerd`      | The `workerd` sidecar client                                                                  |
| `loop-runner-cloudflare`   | The Worker Loader runner, added when hosted OMA needs it                                       |
| `db-schema`                | `bond_*`, `loop_*`, and `matter_*` tables for every dialect                                   |
| `http-routes`              | `/v1/oma/bonds` and `/v1/oma/loops` routes over `matter-host`                                  |

`matter-host` does not depend on `apps/main-node`, so the Node
distribution, the Cloudflare distribution, and downstream distributions
compose the same code. The `loop-runner-` family follows the provider package
rules in `scripts/provider-package-boundaries.mjs`.

The existing `packages/feishu` (API client, webhook signature checks, scopes)
moves into `@openma/matter-feishu` and is deleted with the
legacy routes. The `glab` capability spec in `packages/cap` stays until the
GitLab Bond replaces its device flow.

### Access rule

An agent can use a provider only when all three of these hold:

1. **A Bond exists.** The workspace has enabled the provider app. An app
   principal needs an active installation. A user principal needs the acting
   user's own link (ADR 0009, "Multi-user rules"; ADR 0010, "Link method
   policy").
2. **The agent holds a grant.** The agent configuration names the Bond and a
   scope.
3. **The Session selects resources inside the grant.** A Session created by a
   person or the API selects resources explicitly. A Session created by a Loop
   takes its resources from the Loop instance configuration.

A connected Bond alone gives an agent nothing. The grant is a new OMA
extension field on the agent configuration:

```jsonc
{
  "bond_grants": [
    {
      "bond_id": "bond_...",                       // a GitLab instance
      "resources": ["project:42", "project:77"],   // or "*"
      "operations": ["fetch", "push", "open_mr", "comment_mr"]
    },
    {
      "bond_id": "bond_...",                       // a Feishu app
      "resources": "*",
      "operations": ["im.read", "im.send"]
    }
  ]
}
```

Resource IDs and operation names come from the Bond binding's manifest; OMA
compares them as strings. A Session selects Bond resources with one OMA
resource type:

```jsonc
{
  "type": "oma_bond_resource",
  "bond_id": "bond_...",
  "resource": "project:42",
  "operations": ["fetch", "push", "open_mr"],
  "options": { "checkout": { "type": "branch", "name": "main" } }
}
```

`options` is validated by the binding. `GET /v1/oma/bonds/{bondId}/resources?query=`
backs every picker through the binding's `list`.

The resolver checks, in order: the requested resources are a subset of the
grant; the binding's `validate` accepts the resource and operations for the
resolved principal (the ADR 0009 and ADR 0010 checks). Errors are explicit:
`bond_not_granted` and `bond_resource_out_of_grant`, in addition to the
provider errors in ADR 0009 and ADR 0010.

Agent tools exported by an integration, such as sending a Feishu message, are
offered only to agents whose grant covers the tool's operation.

Grants are checked again each time a credential is minted, not only at
Session creation. Narrowing a grant takes effect on the next mint, under the
execution fencing of ADR 0006. Agent versions record `bond_grants` like any
other field, so a Session pinned to a version keeps that version's grant
unless the grant was revoked.

Agents created before this ADR have no `bond_grants` and therefore no Bond
access. Existing Session credentials (`authorization_token`, vault
credentials) are unchanged.

### Naming

| Item                              | Name                                                    |
| --------------------------------- | ------------------------------------------------------- |
| Bond tables                       | `bond_provider_apps`, `bond_installations`, `bond_user_links` (ADR 0009, 0010) |
| Loop tables                       | `loop_definitions`, `loop_versions`, `loop_instances`   |
| OpenMatter runtime tables         | `matter_` prefix                                        |
| Bond API                          | `/v1/oma/bonds/...`, `/v1/oma/bonds/{bondId}/resources` |
| Bond callback and webhooks        | `/v1/oma/bonds/{bondId}/callback`, `/v1/oma/bonds/{bondId}/events`, on the gateway origin |
| Session resource                  | `oma_bond_resource`                                     |
| Loop API                          | `/v1/oma/loops/...`, `/v1/oma/loop-instances/...`       |
| Agent field                       | `bond_grants`                                           |

OMA endpoints that are not part of the Claude Managed Agents API live under
`/v1/oma/`, as skill sources and model cards already do.

### OMA as an OpenMatter host

OMA implements the OpenMatter host ports with its own services:

| OpenMatter port      | OMA implementation                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- |
| `OpenMatterStore`    | `matter_*` tables through the OMA `SqlClient`, for SQLite, D1, PostgreSQL, and MySQL |
| `DurableInbox`       | The same tables and client                                                          |
| `AgentDriver`        | OMA managed Sessions: create, resume, turn, permission response, cancel, close     |
| `CredentialResolver` | The Bond service from `@openma/matter/bond`, backed by the `bond_*` tables            |
| `WorkIntegration`    | The integrations in the distribution's provider list                               |

Details:

- **Store.** OMA does not reuse `store-sqlite` or `store-mysql`. Those bring
  their own drivers and migrations. OMA keeps one schema and one migration
  path per dialect in `packages/db-schema`. The OMA store must pass an
  OpenMatter store conformance suite, exported from `@openma/matter/store` the
  same way `bondStoreConformanceCases` is exported from `@openma/matter/bond`.
  That suite does not exist yet and is part of the delivery plan.
- **Agent driver.** The driver calls the managed-agents application services
  directly, not the HTTP API. A turn is a `user.message` event; the driver
  maps the Session event stream to OpenMatter `OpenMAEvent`s. Permission
  requests map to tool confirmations. The Session's `created_by_user_id` is
  the resolved principal user for attended events and empty for unattended
  ones (ADR 0009, "Multi-user rules").
- **Event sources.** Webhooks arrive on one generic route,
  `/v1/oma/bonds/{bondId}/events`, and the integration verifies and parses
  them. Sources that hold a connection, such as the Feishu long connection,
  are exported by the integration as an event source; the host runs it under
  a lease per installation, so any replica may hold it.
- **Leases.** The OpenMatter runtime takes event and Session leases through
  the store. On Node they are rows with an expiry, so any replica may process
  any event. On Cloudflare the host uses a Durable Object per project, as
  OpenMatter's Cloudflare host does.

### Matter MCP tool calls

An Agent reaches OpenMatter operations, such as the Feishu reply, through the
Matter MCP server configured on the Agent. Each call becomes an operation
call that the kernel checks and runs under the Turn's Bond.

The MCP request itself is the source of the call. It carries the tool name
and arguments. Its bearer was issued by Matter for one OpenMatter Agent
Session, so it also identifies the Session. That is all Matter needs:

1. The MCP request registers the call in a call store under an id it
   generates, then waits.
2. The replica running that Session's Turn watches the call store while it
   reads the OpenMA event stream. It takes the Session's new calls and
   reports each one to the kernel as a `callback.requested` operation call.
3. The kernel's answer resolves the call, and the MCP request returns it to
   the Agent.

The call store is a table in the Matter database, so the MCP request may
reach a different replica than the one running the Turn. A call that no
running Turn takes within a short pickup bound fails with a clear error:
the Session has no running Turn on any replica. A running Turn takes calls
within one poll interval, so the bound only has to cover polling and
database latency. A taken call waits a longer, separate time for the
kernel's answer. When a Turn ends, every call it took but did not answer
fails.

Matter does not read the Agent's event log to find tool calls. An earlier
design did. It waited for the harness to log the tool-use event and matched
the MCP request to it by tool name and arguments. That made tool execution
depend on each harness's event format and timing. Some harnesses name the
event differently. Some log the tool use only after the call returns, which
is too late, so every call timed out. Taking calls from the MCP request
keeps Matter independent of how a managed-agents harness logs tool calls.
The connector still sends messages to OpenMA, maps OpenMA events to
OpenMatter events, and detects the end of a Turn from them.

The cost is determinism. Calls are reported in the order they were
registered in the store, interleaved with OpenMA events in arrival order.
A callback's position in the Agent event stream follows arrival time, not a
position in the harness's log, and a replayed Turn does not report callbacks
again.

### Loop definitions and instances

A **Loop definition** is code plus a static description. A **Loop instance**
is a definition version put to work.

```text
loop_definitions
  id, workspace_id, name, source ('builtin' | 'workspace'),
  forked_from_version_id (nullable), created_by_user_id, created_at, updated_at

loop_versions
  id, definition_id, version, bundle_digest (sha256), bundle_ref,
  definition_json, config_schema_json, status ('draft' | 'published'),
  created_by_user_id, created_at
  unique (definition_id, version)

loop_instances
  id, workspace_id, version_id, agent_id, config_json,
  bond_ids, status ('enabled' | 'paused' | 'failed'),
  owner_user_id, created_at, updated_at
```

Built-in definitions are recorded with `source = 'builtin'` when a
distribution registers a provider, one version per provider package version.
Versions are immutable. Upgrading an instance means pointing it at a newer
version, after its configuration validates against that version's schema.

The code contract is the OpenMatter `defineLoop(definition, install)` API. A
Loop module is an ES module whose default export is a Loop. `defineLoop` lives
in `@openma/matter/runtime` today; a small guest package, `@openma/matter-loop`,
will export it without the host runtime:

```ts
import { defineLoop } from "@openma/matter-loop";

export default defineLoop(
  {
    id: "gitlab-mr-review",
    version: "1.0.0",
    description: "Review merge requests when they open or change",
    spec: {
      sources: ["gitlab.merge_request.opened", "gitlab.merge_request.updated"],
      workThread: "gitlab.merge_request",
      session: "per-work-thread",
    },
    runAs: "app",
    requiredBonds: [{ provider: "gitlab", operations: ["fetch", "comment_mr"] }],
    configSchema: {
      type: "object",
      properties: {
        projects: {
          type: "array",
          items: { type: "string" },
          "x-oma-widget": "bond-resources",
          "x-bond-provider": "gitlab",
        },
        skipDrafts: { type: "boolean", default: true },
      },
      required: ["projects"],
    },
  },
  (app, { config }) =>
    app.on("gitlab.merge_request.opened", (work) => {
      // context, agent turn, and effects come from host capabilities
    }),
);
```

`definition` is JSON. OMA reads it without running the install function, so
the console can show sources, required Bonds, and the configuration form.

Three additions to the OpenMatter v0 API are needed and are proposed in
OpenMatter, not in OMA:

- `configSchema` on the definition, with the validated instance configuration
  passed to `install`;
- `requiredBonds`, so an instance can be checked against the agent's grants
  before it is enabled;
- `runAs`, already proposed in LOOPS.md.

`configSchema` is a JSON Schema subset: object, string, number, integer,
boolean, enum, and array, with `default` and `required`. Two widget hints
are provider-neutral: `x-oma-widget: "agent"` and
`x-oma-widget: "bond-resources"` with `x-bond-provider`, which the console
renders with the binding's resource catalog.
Configuration must not hold secrets. Credentials come only from Bonds.

### Low code and code

The two ways to build a Loop share one runtime:

- **From a template.** Each provider package ships built-in Loop
  definitions; the first are `feishu-chat` in `@openma/matter-feishu`, and
  `gitlab-mr-review` and `gitlab-mention` in `@openma/matter-gitlab`. OMA lists
  the templates of the registered providers. The console renders
  a form from `configSchema`. Saving the form creates a Loop instance. No code
  is involved.
- **As code.** A user submits a Loop module through the API, the console, or
  `oma loops deploy` in the CLI. The CLI bundles TypeScript; the API accepts a
  single bundled ES module.
- **Copy as code.** Any built-in or workspace definition can be forked. The
  fork is a new workspace definition whose first draft version is the source
  of the original, with `forked_from_version_id` recorded.

Built-in templates are Loop modules in the same format. They are not a
separate mechanism.

### Serverless execution

Users submit code; OMA runs it. Each published Loop version runs in its own
V8 isolate:

- the isolate has no network access (`globalOutbound: null`);
- its only binding is a capability stub served by the host;
- the stub exposes the current WorkEvent, the context projection, agent turns
  (`work.agent(id).session(binding).turn(...)`), Effect drafts, and Reaction
  drafts;
- the isolate never receives a provider token, a database handle, or an OMA
  API key.

All durable work stays on the host. The host-side OpenMatter runtime claims
the event, calls the Loop's handler through the stub, commits the single
terminal Reaction, and delivers Effects through `WorkIntegration.deliver` with
credentials from the Bond. A crash inside the isolate fails one handler call.
The runtime's lease and retry rules then apply as they do today.

Agent turns run on the host as ordinary Sessions. Their time does not count
against the isolate's CPU limit.

The loader depends on the deployment:

- **Cloudflare.** The Worker Loader binding (Dynamic Workers) loads the bundle
  into an isolate on demand, keyed by `bundle_digest`. At the time of writing
  this binding is in open beta and needs a paid Workers plan.
- **Node and self-hosted.** A `workerd` sidecar runs with its experimental
  Worker Loader enabled. It runs in its own container with no network route
  other than the socket to the control plane, a read-only filesystem, and a
  non-root user. `loop-runner-workerd` reaches it over that socket.
- **No loader configured.** Built-in templates run inside the control plane
  through the in-process runner, since they ship with the distribution.
  Workspace Loop code cannot be published, and the API returns
  `loop_runtime_unavailable`.

The `workerd` project states that it is not a hardened sandbox on its own.
On self-hosted deployments the container boundary is the security boundary,
and only workspace owners and administrators may publish Loop code. On
hosted OMA, tenant isolation relies on Cloudflare's isolate isolation for
Dynamic Workers.

Limits per handler call, enforced by the host: CPU time, memory, wall time,
number of Effects per Reaction, and bundle size. Exact values are set during
implementation and recorded in `docs/`. Each publish, enable, pause, and
upgrade is written to the audit log.

On publish OMA loads the module once in an isolate whose capability stub
rejects every call. That load extracts and validates `definition` and
`configSchema`. A module that does not load, or whose definition does not
match its schema, is rejected.

### Feishu migration

| Today                                     | After                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| App credentials on `feishu_publications`  | A Feishu Bond installation; the tenant access token is the app principal      |
| A publication                             | An instance of the built-in `feishu-chat` Loop                                 |
| Publish wizard                            | The generic Bond install form from the Feishu Binding manifest, then the `feishu-chat` instance form: chat filter, Session granularity, persona |
| `feishu_thread_sessions`                  | WorkThread to Session binding in the OpenMatter store                          |
| `feishu_webhook_events` deduplication     | WorkEvent claim in the OpenMatter store                                        |
| Long-connection runner, single replica    | A host event source holding a lease per installation; any replica may hold it  |
| One-shot reply through the stream hub     | A reply Effect with a recorded delivery receipt                                |
| Owner-only Sessions                       | `runAs: requester` through a Feishu user link                                  |
| `mcp__feishu__*` tools in `main-node`     | Agent tools exported by `@openma/matter-feishu`, offered to agents whose grant covers the operation |

New pieces:

- **Feishu user Bond.** Users link their Feishu account through Feishu OAuth
  (user access token, refreshed by the Bond kernel). The link records the
  user's `open_id` for the app. For an inbound message, the host maps the
  sender's `open_id` to an OMA user with `findUserLinkByProviderUser`. A
  message addressed to the bot is attended, so `runAs: requester` applies
  under the provider's principal policy (LOOPS.md, "Execution principal").
  A sender without a link falls back as that policy says.
- **Webhook source on Cloudflare.** Feishu inbound works on Cloudflare through
  the webhook source. The long-connection source runs only on Node.
- **Unpublish is two actions.** Pausing or deleting the Loop instance stops
  replies. Revoking the Bond installation is separate and explicit.
- **Session granularity and capabilities** become instance configuration and
  agent grants, so both are enforced.

Cutover:

1. A migration converts each `feishu_publications` row into a Feishu Bond
   (a provider app row and its installation) and a `feishu-chat` instance, keeping the agent and the
   options the wizard showed.
2. Parity tests replay recorded inbound events through the old path and the
   new path and compare Sessions, replies, and deduplication.
3. The old routes stay for one release behind a flag. They are then deleted
   together with every Feishu-specific file in OMA: `packages/feishu`, the
   Feishu adapters in `packages/integrations-adapters-cf`, the Feishu routes
   in `packages/http-routes`, `ws-feishu-runner.ts`,
   `feishu-egress-writer.ts`, and `feishu-agent-tools.ts` in `main-node`, the
   Feishu console pages, and the `feishu_*` tables.

### GitLab

The GitLab Bond follows ADR 0010. This ADR adds:

- **GitLab Integration, in `@openma/matter-gitlab/bond`.** It ingests project and group webhooks
  (merge request, note, pipeline). The webhook secret token is compared in
  constant time. Hooks are registered by an administrator, or through the app
  principal when one is configured. Replies are Effects: merge request notes
  and discussion replies.
- **Templates**, shipped in `@openma/matter-gitlab`. `gitlab-mr-review` reviews a merge request when it opens or
  changes. `gitlab-mention` answers a note that mentions the agent.
- **Principal.** GitLab webhooks are unattended, even when the actor has a
  linked account (LOOPS.md). Both templates therefore need the app principal
  from ADR 0010, "App principal (optional)". Without it they cannot be
  enabled, and the error is `gitlab_unattended_unsupported`. Interactive
  Sessions with a user principal work without it.

### Distribution

OMA installs OpenMatter packages from npm at exact versions. It does not
reference git commits, because some build environments cannot reach GitHub
archive downloads. OpenMatter adds a release workflow with npm trusted
publishing. The packages are published under the existing `@openma` scope:
the `openmatter` organization on npm belongs to someone else. The kernel is
`@openma/matter`; the guest SDK and each provider are `@openma/matter-<name>`.
The `matter` prefix keeps them apart from the other `@openma` packages.
OMA starts with three: `@openma/matter`, `@openma/matter-loop`, and
`@openma/matter-gitlab`, then `@openma/matter-feishu`.

## Compatibility

- The Claude Managed Agents API shapes are unchanged. `bond_grants`, the
  `/v1/oma/bonds` and `/v1/oma/loops` endpoints, and the Loop tables are OMA
  extensions.
- Agents without `bond_grants` behave as they do today.
- `oma_bond_resource` replaces the `oma_gitlab_repository` type that ADR 0010
  proposed; neither is implemented yet. `github_repository`, with or without
  `oma_credential` (ADR 0009), is unchanged.
- The Linear, GitHub, and Slack integrations are unchanged by this ADR. Each
  moves to Loops in a later ADR or PR series.
- Feishu publications are migrated, and the old routes stay for one release.
- No package published from this repository (`@openma/cli`, `@openma/sdk`)
  changes until the CLI gains `oma loops`.

## Verification gates

Each PR in the delivery plan passes its own gates. The series is done when:

- **No provider in core.** A boundary test in `scripts/` fails when OMA core
  packages (`matter-host`, `http-routes`, `db-schema`, the console, and the
  control-plane library) import a `bond-*` or `integration-*` package or
  name a provider, outside the Feishu migration and `github_repository`.
- **Store conformance.** The OMA OpenMatter store and inbox pass the
  OpenMatter conformance suites on SQLite, PostgreSQL, and MySQL in CI.
- **Bond conformance.** The `bond_*` store passes `bondStoreConformanceCases`
  on the same three dialects.
- **Access rule.** Tests cover each of the three conditions failing alone,
  grant narrowing during a running Session, and a Loop instance whose
  configuration selects resources outside the grant.
- **Isolation.** A test Loop that calls `fetch`, opens a socket, reads the
  filesystem, or reads `process.env` fails inside the isolate on both loaders.
  A Loop that loops forever is stopped by the CPU limit, and the event is
  retried or failed by the runtime rules.
- **Exactly once.** Killing the process between event claim and Reaction
  commit, and between Reaction commit and Effect delivery, yields one Reaction
  and one delivered reply per event.
- **Feishu parity.** Recorded events produce the same Sessions and replies on
  the old and new paths, with two replicas running the long-connection source.
- **GitLab live lane.** Against a self-managed instance: a webhook opens a
  review, the review is posted as the bot, and a revoked Bond stops the next
  delivery.

## Consequences

Positive:

- One model for credentials, grants, events, and replies across providers.
- Workspaces change integration behavior with configuration or their own
  code, without an OMA release.
- Feishu gains user attribution, multi-replica inbound, Cloudflare inbound,
  and recorded delivery.
- Built-in and user-defined Loops share one runtime and one set of tests.

Negative:

- OMA depends on OpenMatter releases for its integration runtime, and the
  OpenMatter API grows three fields to fit OMA.
- Self-hosted deployments that want workspace Loop code run a second process,
  the `workerd` sidecar, using an experimental `workerd` feature.
- Hosted OMA depends on a Cloudflare feature in open beta, with its own
  pricing.
- Two integration stacks coexist until Linear, GitHub, and Slack move.

## Delivery plan

Each step is one small PR with the evidence report required by
`CONTRIBUTING.md`.

OpenMatter:

1. `refactor!: fold the kernel into @openma/matter`, and a release workflow
   that publishes to npm.
2. `feat(bond): add the binding manifest and resource catalog`, implemented
   by the GitLab Binding.
3. `feat(store): export store and inbox conformance suites`.
4. `feat(runtime): add configSchema, requiredBonds, and runAs to Loop definitions`.
5. `feat(runtime): split host and guest so a Loop runs behind a capability stub`,
   adding the `@openma/matter-loop` guest package.
6. `feat(gitlab): add webhook ingest, note delivery, and the GitLab templates`.
7. `feat(feishu): add Feishu app installation, OAuth user link, and resource catalog`.
8. `feat(feishu): add message ingest, the long-connection source,
   reply delivery, agent tools, and the feishu-chat template`.

OMA:

1. `docs(adr): add 0011 Matter, and rename 0009 and 0010 to Bonds` (this PR).
2. `feat(matter-host): add bond tables, the Bond store, and the provider
   registry` (ADR 0009 and 0010 storage, three dialects).
3. `feat(agents): add bond_grants, oma_bond_resource, and the access rule`.
4. `feat(matter-host): add the OpenMatter store, inbox, and agent driver`.
5. `feat(loops): add Loop definitions, versions, instances, and API`.
6. `feat(console): add the Matter group with generic Bond and Loop pages`.
7. `feat(loop-runner-workerd): run Loop versions in a workerd sidecar`.
8. `feat(main-node): register the GitLab and Feishu providers`.
9. `feat(main-node): migrate Feishu publications to Bond and Loop`.
10. `refactor: delete the legacy Feishu packages, routes, and tables`, one
    release later.
11. `feat(cli): add oma loops deploy`, with a changeset for `@openma/cli`.
12. `feat(loop-runner-cloudflare): run Loop versions on Worker Loader`, when
    hosted OMA enables workspace Loop code.

## Open questions

- Whether a GitLab note from a linked user that mentions the agent should
  count as attended. LOOPS.md says no today.
- The JSON Schema subset and widget list for `configSchema`.
- Whether a provider may ship a console extension for flows a generic form
  cannot express, such as creating a Feishu app from a QR code. The default
  is no; such a flow would use the existing console plugin slot.
- Whether resource IDs need a version or a stability rule, since grants and
  Loop configurations store them.
- On Cloudflare, whether the OpenMatter store for a workspace lives in D1 or
  in Durable Object storage. D1 has no interactive transactions; the
  OpenMatter store relies on transactional claims.
- Whether an isolate is shared by all instances of one version in a
  workspace, or created per instance.
- Who a Loop-created Session belongs to in the console when it has no
  attended user: the instance owner, or the Loop instance itself.

## Unverified

- Dynamic Workers availability, limits, and pricing were read from Cloudflare
  documentation, not tested on an account.
- The `workerd` Worker Loader has not been run in a container without
  network access.
- Feishu OAuth scopes needed for the user Bond, and whether `open_id` in
  message events matches the `open_id` returned to the OAuth app, have not
  been checked against a live tenant.
- The Feishu parity tests need recorded production events, which do not
  exist yet.
