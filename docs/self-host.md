# Self-host OMA — single-process Node deployment

A Node-side build of Open Managed Agents that runs on a single VPS / Mac /
Docker host without any Cloudflare account, Workers, Durable Objects, or
Containers. Storage is SQLite, Postgres, or MySQL + local filesystem. Every
deployable entrypoint requires an explicitly configured isolated sandbox
provider; there is no host-subprocess fallback.

> **One of three deployment topologies.** See [deployment.md](./deployment.md)
> for the full Self-host / CF Local / CF Prod comparison + decision
> matrix. This doc covers Self-host specifically.

> **Status:** Working PoC. The self-host route is a parallel implementation of
> the same `Services` abstractions used on Cloudflare, including better-auth
> multi-tenant. See "What works / doesn't" below.

## Choose a backend

One image, multiple SQL adapters — pick the one that matches your durability
and concurrency story. You can switch later (see [Migrating between
backends](#migrating-between-backends) below).

| | SQLite + LocalFs (default) | Postgres + LocalFs | MySQL + LocalFs |
|---|---|---|---|
| Bundled compose | `docker-compose.yml` | `docker-compose.postgres.yml` | Bring an external MySQL 8.x DSN |
| Best for | Single-user self-host, dev, demo, ≤10 GB sessions | Multi-instance, ≥50M sessions/events rows, share existing PG | Existing MySQL 8.x infrastructure |
| SQL concurrency | One writer (single oma-server) | Many writers; HA-able | Many writers; CAS-backed claims |
| Backups | `cp ./data/*.db` or litestream → S3 | `pg_dump` / managed PG snapshots | `mysqldump` / managed MySQL snapshots |

**Same Docker image either way** (`openma/main-node:dev` built from
`apps/main-node/Dockerfile`) — `DATABASE_URL` env at runtime decides.
SQLite needs only `DATABASE_PATH`; server databases use
`DATABASE_URL=postgres://…` or `DATABASE_URL=mysql://…`. In Postgres and
MySQL modes better-auth's tables live in the same database (no separate
`auth.db` file); in SQLite mode they live in `./data/auth.db`.

## Quick start (Docker, SQLite)

```bash
# 1. Get an Anthropic API key. Any Anthropic-compatible endpoint works.
cp .env.example .env
$EDITOR .env  # set ANTHROPIC_API_KEY

# 2. Start (first time builds the image; subsequent runs skip --build)
docker compose -f docker-compose.yml up -d --build

# 3. Sanity check
curl localhost:8787/health
# → {"status":"ok","runtime":"node","backends":{"db":"sqlite ..."},...}

# 4. Create + drive an agent
AID=$(curl -s -X POST localhost:8787/v1/agents \
  -H 'content-type: application/json' \
  -d '{"name":"shell","model":"claude-sonnet-4-6","system":"Use bash to answer.","tools":[{"type":"bash"}]}' \
  | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions \
  -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AID\"}" | jq -r .id)

# Open a streaming SSE in one terminal:
curl -N localhost:8787/v1/sessions/$SID/events/stream &

# Send a message in another:
curl -s -X POST localhost:8787/v1/sessions/$SID/events \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: ls -la / | head"}]}]}'

# Watch the SSE — you should see agent.tool_use → agent.tool_result →
# agent.message → session.status_idle
```

Subsequent commands:

```bash
docker compose -f docker-compose.yml logs -f   # follow logs
docker compose -f docker-compose.yml down       # stop, keep ./data
docker compose -f docker-compose.yml down -v    # stop, wipe volumes
```

## Quick start (no Docker)

```bash
pnpm install
ANTHROPIC_API_KEY=sk-... pnpm --filter @open-managed-agents/main-node start
# Same curl flow as above against localhost:8787.
```

State lives at `./data/` (sqlite db + per-session sandbox workdirs).
Wipe + restart for a clean slate.

## Postgres backend

When to flip to Postgres: multi-instance, large tables (50M+ rows on
sessions/events), or because you'd rather operate the PG cluster you
already have than introduce a new SQLite footprint.

```bash
# 1. Same .env (Postgres compose already sets DATABASE_URL internally)
cp .env.example .env
$EDITOR .env  # set ANTHROPIC_API_KEY

# 2. Start — brings up postgres:16-alpine + oma-server + oma-vault
docker compose -f docker-compose.postgres.yml up -d --build

# 3. Sanity check — note backends.db reports postgres
curl localhost:8787/health
# → {"status":"ok","backends":{"agents":"postgres","events":"postgres","db":"postgres ..."},...}
```

Curl flow + console URL are identical — application code is backend-
agnostic. Same `openma/main-node:dev` image, just different env.

What changes vs the SQLite stack:

- `oma-server` reads `DATABASE_URL=postgres://oma:oma@postgres:5432/oma`
  (set in `docker-compose.postgres.yml`); the same SqlClient port serves
  every store package, so business code is identical.
- `oma-vault` follows the same dispatch — when `DATABASE_URL` is a
  postgres URL the sidecar reads credentials from PG (otherwise it falls
  back to the bundled SQLite path). The two services MUST agree on the
  backend or vault credential injection won't see anything to inject.
- A `postgres:16-alpine` service ships with the compose, persisted on a
  named volume `oma-pgdata`. No host port published; only `oma-server`
  reaches it on the bridge network. Add `ports: ["5432:5432"]` if you
  want `psql` access from the host.
- **better-auth runs on the same Postgres database.** No separate
  `auth.db` file; the `user` / `session` / `account` / `verification`
  tables sit alongside `agents`, `sessions`, `tenant`, etc. and are
  bootstrapped at first start (idempotent `CREATE TABLE IF NOT EXISTS`
  with PG-native `boolean` / `timestamptz` types). Internally we open
  a small `pg.Pool` (max 10) for better-auth's kysely PostgresDialect
  — the main store stays on `postgres.js`. `AUTH_DATABASE_PATH` is
  ignored in PG mode.

## MySQL backend

Point the same main-node image at a fresh MySQL 8.x database:

```bash
DATABASE_URL=mysql://oma:password@mysql.example.internal:3306/oma \
  pnpm --filter @open-managed-agents/main-node start

curl localhost:8787/health
# → {"auth":"better-auth-mysql","backends":{"agents":"mysql","events":"mysql",...}}
```

The composition root only selects the backend. MySQL-native DDL, ANSI
identifier normalization, optimistic CAS, and transactional result readback
live below the SQL Port; v1 Agent, Session, Environment Work, lease/fence, and
auth code do not branch on MySQL.

MySQL schema bootstrap is idempotent for the same canonical snapshot and
fails closed if a newer application snapshot needs an explicit migration; it
never marks an un-applied schema upgrade as successful. MySQL deployments
can run several main-node replicas: live Session events reach SSE subscribers
on other replicas through SQL tailing (see "Cross-replica live events" below).

### Cross-replica live events

A Session's turn runs on whichever replica holds its execution lease (or, for
`/v1/oma`, received the turn), while its SSE subscribers can be attached to
any replica behind the load balancer. `OMA_REALTIME_FANOUT` selects how
committed events cross that gap:

| Mode | Default for | `/v1/oma/.../events/stream` | `/v1/sessions/.../events/stream` |
|---|---|---|---|
| `memory` | SQLite | in-process only | in-process only |
| `pg-notify` | Postgres | `LISTEN/NOTIFY` | SQL tailing |
| `sql-poll` | MySQL | SQL tailing | SQL tailing |

SQL tailing runs one poll loop per replica (`OMA_REALTIME_POLL_INTERVAL_MS`,
default `300`). Each tick issues one batched primary-key/index range query per
50 subscribed Sessions and no query while the replica has no subscribers. The
executing replica still delivers its own events immediately, including
unpersisted token deltas; subscribers on other replicas receive canonical
(persisted) events within one poll interval, de-duplicated and in order.

### Running multiple oma-server replicas (PG or MySQL)

PG mode supports >1 `oma-server` process behind a load balancer. SSE
fanout works across replicas: every `append` issues `NOTIFY
oma_session_events '{sid,seq}'` on a shared PG channel, and every
replica `LISTEN`s on the same channel. When replica B receives a NOTIFY
for a session it has a local SSE writer for, it fetches `seq >
lastForwarded` from the SQL log and pushes the new events to its
writer. Local round-trip latency is typically <100 ms; we measure ~2 ms
on a same-host PG and ~80 ms via curl through two `pnpm start`
processes.

**`/auth/*` is also replica-safe** in PG mode: better-auth's tables
live in the shared Postgres, so any replica can serve any auth
request. No sticky sessions required.

Hard requirements before you scale out:

1. **Memory blob storage MUST be shared across replicas.** Two paths
   work:
   - **Local NFS / EFS / shared docker volume + chokidar** — bind the
     same `MEMORY_BLOB_DIR` into every replica. Each replica runs its
     own chokidar watcher; concurrent watchers firing for the same
     write are no-ops past the first because `upsertFromEvent` is
     idempotent on `(store_id, path)` + sha256 etag.
   - **S3 / S3-compatible bucket** — set `MEMORY_S3_*` env vars (see
     "S3-backed memory store" below). main-node switches to the
     `S3BlobStore` adapter and a per-store-leased `S3PollAdapter`
     replaces chokidar. Multi-replica safe by construction (only the
     lease holder polls a given store at a time).
2. **`oma-vault` is stateless and can also replicate.** It's a
   per-request DB lookup + header inject — no caches, no per-process
   state beyond the on-disk CA. To run N copies, mount the same
   `OMA_VAULT_CA_DIR` into every replica (the first one to boot
   generates `ca.{crt,key}` under an O_EXCL `ca.lock`; the others
   wait+read), put a Service / LB in front, and set
   `OMA_VAULT_PROXY_URL=http://oma-vault:14322` (or your LB DNS) on
   sandboxes. **Constraint:** all vault replicas MUST share the same
   CA key — sandboxes that trust one CA but get TLS-terminated by a
   replica with a different CA will see cert errors. The shared
   `./data/oma-vault-ca` volume + lock-on-create handles this.
   `docker-compose.postgres.yml` ships with a commented
   `deploy.replicas: 3` example on the `oma-vault` service.

Sticky cookies are NOT required for `/v1/*`, `/auth/*`, or outbound
sandbox traffic — the SSE fanout is replica-agnostic, better-auth is
on the shared PG, and the vault is stateless.

### S3-backed memory store (multi-replica friendly)

When `MEMORY_S3_ENDPOINT` + `MEMORY_S3_BUCKET` + `MEMORY_S3_ACCESS_KEY`
+ `MEMORY_S3_SECRET_KEY` are all set, main-node swaps the
`LocalFsBlobStore` for an S3-compatible `S3BlobStore` (works against
AWS S3, MinIO, Tigris, Wasabi, Cloudflare R2's S3 API, etc.) and
starts an `S3PollAdapter` that lists the bucket every
`MEMORY_S3_POLL_INTERVAL_SEC` (default 30) for new/changed objects.
Sandbox sides (Daytona / E2B) already mount the bucket via s3fs using
the same env vars; the loop "agent writes via FUSE → S3 PUT → poller
upserts SQL index" is the multi-replica analog of the chokidar path.

The internal local sandbox fixture used by deterministic tests is not exposed
through the deployable server and is outside this production persistence
contract.
Use S3 mode with an isolated remote sandbox when arbitrary agent commands must
see canonical `/mnt/...` paths directly.

### Pointing at an existing Postgres cluster

To use a managed PG (RDS / Neon / Supabase / your own cluster) instead
of the bundled `postgres` service, drop the `postgres` service block
from `docker-compose.postgres.yml` and override `DATABASE_URL` in
`.env`:

```bash
# .env
DATABASE_URL=postgres://user:pw@my-pg.internal:5432/oma_prod
# OMA_VAULT_DATABASE_URL=...   # if you want the vault sidecar to use a different DB
```

The schema bootstraps on first start (`CREATE TABLE IF NOT EXISTS`
across all 13 tables); no separate migration step. Re-running is safe.

### Migrating between backends

Switching directions in either direction means moving rows; no
in-place upgrade. Two paths:

**SQLite → Postgres (one-way).** Spin up the PG stack pointed at a
fresh DB. Then export from SQLite + import via `psql`:

```bash
# SQLite side
sqlite3 ./data/oma.db ".dump agents agent_versions sessions session_events session_streams memories memory_stores memory_versions vaults credentials session_memory_stores tenant membership" > /tmp/oma-dump.sql
# Strip SQLite-specific pragmas (BEGIN/COMMIT survive; PRAGMA / sqlite_sequence don't)
sed -i '/^PRAGMA\|sqlite_sequence/d' /tmp/oma-dump.sql
# PG side
docker exec -i oma-postgres psql -U oma -d oma < /tmp/oma-dump.sql
```

`agent.id`, `session.id` etc. are TEXT, BIGINT timestamps work in both,
JSON columns are TEXT not jsonb — no schema translation needed beyond
the pragma strip.

**Postgres → SQLite (one-way).** Less common, but possible: `pg_dump
--inserts --data-only` + a sed pass to `INSERT OR REPLACE`, then
`sqlite3 oma.db < dump.sql`. Auth.db is unaffected (already SQLite on
both sides).

### Backups & operations

| | SQLite + LocalFs | Postgres + LocalFs | MySQL + LocalFs |
|---|---|---|---|
| Hot backup | litestream replicates `./data/*.db` to S3 continuously | `pg_dump` / managed PG snapshots / WAL streaming | `mysqldump` / managed MySQL snapshots |
| Restore | Stop server, copy db back, restart | `pg_restore` into fresh PG, point `DATABASE_URL` at it | Restore into fresh MySQL, point `DATABASE_URL` at it |
| Sandbox workdirs | Back up `./data/sandboxes/` separately | Same | Same |
| Memory blobs | Back up `./data/memory-blobs/` or set `MEMORY_S3_*` | Same | Same |
| Auth | Separate `./data/auth.db` | In the Postgres database | In the MySQL database |

The backends pass the same crash-recovery test surface (55 tests across
adapter / recovery-logic / SIGKILL bootstrap / CF DO eviction).

## Feishu (OpenMatter)

The Console's **Matter → Loops** page puts Agents to
work in Feishu and GitLab. A Loop is made from a template (`feishu-agent`,
`gitlab-mention`, `gitlab-mr-review`) plus its settings; two of them are the
app it runs on (`bond`, e.g. `feishu:cli_xxx`) and the Agent that answers
(`agentId`). Apps are linked from the Loop form itself — a QR code for Feishu,
a bot token for GitLab — or on the **Matter → Bonds** page, which lists the
linked apps; one app can run several Loops. The form is built
from each template's config schema; for a Feishu app it also lists missing
permissions and events with links to fix them. The page talks to the OpenMatter
service (`apps/matter`) through the control plane, which proxies `/matter/*`
to it after signing the user in:

```bash
# .env of the control plane
MATTER_URL=http://matter:4720          # where the Matter service listens
MATTER_PROXY_SECRET=<random string>    # the same value is given to Matter
```

Without `MATTER_URL`, `/matter/*` answers `404 {"error":"matter_not_configured"}`
and the page says Feishu is not set up. The proxy never forwards the user's
cookies, `Authorization` or `x-api-key`; Matter learns the tenant and user from
`x-oma-tenant-id` / `x-oma-user-id`, which it trusts only together with the
secret.

### Running the Matter service

`docker compose --profile feishu up -d` starts it next to `oma-server`, from
the same image. Add to `.env`:

```bash
MATTER_URL=http://matter:4720
MATTER_PROXY_SECRET=<openssl rand -hex 32>   # shared with oma-server
MATTER_SECRET_KEY=<openssl rand -hex 32>     # seals Feishu app secrets at rest
MATTER_OMA_API_KEY=<API key of the workspace Matter serves>
MATTER_OMA_ENVIRONMENT_ID=<environment chat sessions run in>
PLATFORM_ROOT_SECRET=<...>                   # Vault credentials need it
```

Outside compose, run `pnpm --filter @open-managed-agents/matter start` with
`MATTER_PROXY_SECRET`, `MATTER_SECRET_KEY`, `OMA_URL`, `OMA_API_KEY` and
`OMA_ENVIRONMENT_ID` set (optional: `MATTER_HOST`, `MATTER_PORT` (4720),
`MATTER_DATA_DIR` (`./data/matter`), `MATTER_DATABASE_URL`, `MATTER_RECONCILE_MS`
(15000), `MATTER_MCP_URL`, `OMA_TENANT_ID` (`default`)). It exits with code 2
and lists every missing setting.

A Matter service serves one workspace (the tenant of its API key). For each
connected Feishu app it keeps a long connection to Feishu — no public webhook
URL is needed — and a store and inbox of its own. App secrets are encrypted
with `MATTER_SECRET_KEY`; the per-chat MCP tokens are stored only as hashes.

**Workspaces.** With `OMA_API_KEY` the service acts in that key's workspace
only (`OMA_TENANT_ID`, default `default`). Without it, it serves every
workspace: it calls the API with the shared `MATTER_PROXY_SECRET` and the
workspace id (`x-matter-proxy-secret` / `x-oma-tenant-id`), which the control
plane accepts only when its own `MATTER_URL` and `MATTER_PROXY_SECRET` are
set. New sessions run in `OMA_ENVIRONMENT_ID`, or else in the workspace's
newest environment. GitLab webhooks reach Matter through the control plane at
`/webhooks/gitlab/<id>` as well, so `MATTER_PUBLIC_URL` can be the control
plane's public URL.

**Images.** Images on a Feishu message are downloaded with the app's
credentials (scope `im:resource`, part of the app preset) and shown to the
Agent, up to 5 per message.

**State.** Without `MATTER_DATABASE_URL`, one process keeps everything in
SQLite under `MATTER_DATA_DIR` (`matter.sqlite`, and `apps/<id>/` per
connection): fine for compose, a single replica only. With
`MATTER_DATABASE_URL=mysql://…` the process keeps no state of its own; run
as many replicas as you like behind one address, with the same
`MATTER_SECRET_KEY`. The tables (`openmatter_*`) are created on start and
can share the control plane's database. Every replica runs every connection:
Feishu delivers each event to one of the app's long connections, the inbox
hands each stored event to one replica, a "Connect Feishu" registration is
polled under a lease by one replica at a time, and an MCP tool call may land
on any replica (the call and its answer meet in the database). A replica picks
up connections saved by another within `MATTER_RECONCILE_MS`, or at once when
a GitLab webhook for one arrives.

Saving a Loop adds an `openmatter` MCP server (URL `MATTER_MCP_URL`) and
its `mcp_toolset` to the Loop's Agent, with `always_allow`: no one is there to
approve a tool call made from a chat. Each chat gets a session whose Vault
holds the bearer for that server; replies go out as the bot.

### GitLab merge request mentions

The same Matter process answers GitLab merge request comments that mention a
bot user (the `gitlab-mention` Loop) and reviews merge requests
(`gitlab-mr-review`). In the Console, pick one of those templates on the
Loops page and link the instance from its form. Through the API (behind the
control plane's `/matter/*` proxy), link the instance, then create the Loop:

```bash
curl -X POST "$OMA/matter/connect/gitlab" -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"baseUrl":"https://gitlab.example.com","token":"<bot token, api scope>"}'
# → {"id":"gitlab-…","username":"<bot>","webhookUrl":"…","webhookSecret":"…"}
curl -X POST "$OMA/matter/loops" -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"template":"gitlab-mention",
       "config":{"bond":"gitlab:gitlab-…","agentId":"<agent id>","projects":["project:42"]}}'
```

`GET /matter/loop-templates` lists the templates with their config schemas,
`GET /matter/bonds` the linked apps, and `/matter/loops` (`GET`, `POST`,
`PATCH /:id`, `DELETE /:id`) the Loops. Connections saved before Loops
existed, with an Agent on them, become one Loop each on start.

Matter checks the token against `/api/v4/user` (the bot's username decides
which comments mention it) and returns the webhook URL and secret **once**. In each project,
add a webhook with that URL, the secret as its token, and **Comments** events
(plus **Merge request events** for `gitlab-mr-review`).
`GET /matter/connect/gitlab` lists the connections without secrets, and
`instances`: the GitLab URLs the Console offers when linking, so users do not
type them again. These are the instances in `MATTER_GITLAB_URLS`
(comma-separated, for the deployment's own GitLab), then the ones the
workspace has linked before; users can still enter another address.

Unlike Feishu, GitLab calls in: `POST /webhooks/gitlab/<id>` must be reachable
from the GitLab instance, directly on the Matter service (not through the
Console proxy). Set `MATTER_PUBLIC_URL` to that origin so the returned
`webhookUrl` is absolute. Each webhook is checked against its connection's
secret and answered `202` only once it is in that connection's durable inbox
; otherwise `503`, and GitLab retries.
Redeliveries are answered once. The reply is the Agent's final message, posted
by the bot in the comment's thread, so the Agent's instructions must not tell
it to answer through a tool (an Agent written for Feishu, which replies through
its reply tool, will instead explain that it has no such tool). The token and webhook secret are encrypted
with `MATTER_SECRET_KEY`.

## Operator gotchas

Things I'd document if I were the on-call who got paged:

- **`AUTH_DISABLED=1` must be in `.env`, not the shell.** `docker
  compose` substitutes `${AUTH_DISABLED}` from the compose-time env
  (your `.env` at the compose dir). Putting it in the shell only is
  silently ignored.
- **`docker compose restart` does NOT re-read env.** After editing
  `.env`, use `docker compose up -d --force-recreate oma-server` to
  pick up changes (or `down` then `up`).
- **`agent.system` defaults to empty.** The Anthropic API rejects
  `system: [{type:"text", text:""}]` — main-node passes `undefined`
  when system is empty. If you ever see "system: text content blocks
  must be non-empty", your model proxy is stricter than the SDK
  expects. Set a non-empty `system` on the agent.
- **`tools=8` even when you set `tools:[]` on the agent.** main-node's
  `buildTools` always wires the harness's standard set (bash, read,
  write, edit, glob, grep, web_fetch, web_search). Per-agent tool
  filtering happens at routing time, not at build time. To disable a
  tool entirely, omit it from `agent.tools`; the harness will see it
  but never invoke it.
- **`oma-vault` won't see PG credentials if you set `DATABASE_URL`
  on `oma-server` only.** Both services share the same store; if you
  want vault credential injection on PG, both must point at PG. The
  PG compose handles this for you; if you customise, mirror the env.
- **First boot from an old `oma.db`.** The unified-runtime refactor
  added two columns to `sessions` (`turn_id`, `turn_started_at`).
  main-node runs `ALTER TABLE … ADD COLUMN` idempotently on every
  start; existing dbs upgrade in place. If you see `no such column:
  turn_id`, you're on a pre-migration build — pull a newer image.

## Crash recovery demo

OMA's self-host mode persists session state to SQLite + the event log on
every write, so a `kill -9` on the Node process doesn't lose the
conversation.

```bash
# 1. Create a session, drop in a few messages.
SID=$(curl -s -X POST localhost:8787/v1/sessions -d '{}' | jq -r .id)
for i in 1 2 3; do
  curl -s -X POST localhost:8787/v1/sessions/$SID/_test_emit \
    -H 'content-type: application/json' \
    -d "{\"text\":\"event-$i\"}"
done

# 2. SSE shows id:1 / id:2 / id:3 events.
curl -N localhost:8787/v1/sessions/$SID/events/stream
# (Ctrl-C to stop)

# 3. Hard-kill the server. (Or `docker compose down --no-stop` then `up`.)
docker kill -s SIGKILL oma-server

# 4. Restart.
docker compose -f docker-compose.yml up -d

# 5. Reconnect SSE with the last seen seq — only events after seq 3 stream.
curl -N -H 'Last-Event-ID: 3' localhost:8787/v1/sessions/$SID/events/stream
# Or `Last-Event-ID: 0` to replay everything.
```

The same demo works on the Postgres compose unchanged.

## What works on the self-host build today

| Feature | Status |
|---|---|
| `/v1/agents` full CRUD with AMA `_oma:` envelope, versions, archive, delete | ✓ via `@open-managed-agents/http-routes` |
| `/v1/sessions` create + list + get + archive + delete + threads | ✓ via `@open-managed-agents/http-routes` (NodeSessionRouter wraps SessionRegistry + SqlEventLog) |
| `POST /v1/sessions/:id/events` (5-type whitelist + harness dispatch) | ✓ via SessionRouter.appendEvent |
| `POST /v1/sessions/:id/messages` one-shot user.message | ✓ |
| `GET /v1/sessions/:id/events/stream` SSE w/ Last-Event-ID resume | ✓ via SessionRouter.streamEvents |
| `GET /v1/sessions/:id/trajectory` | ✓ via SessionRouter.getTrajectory |
| `POST /v1/sessions/:id/__debug_recovery__` (token-gated) | ✓ via SessionRouter.triggerDebugRecovery |
| `user.interrupt` aborts in-flight harness | ✓ via SessionRouter.interrupt → SessionRegistry abort |
| Real LLM token streaming (any Anthropic-compatible endpoint) | ✓ |
| Crash recovery on process restart | ✓ |
| `bash` tool via the selected isolated sandbox | ✓ |
| `read` / `write` / `edit` / `glob` / `grep` tools | ✓ (workdir-relative) |
| `web_fetch` tool (HTML → markdown via turndown) | ✓ |
| `web_search` tool | ⏸  needs TAVILY_API_KEY env var |
| `browser` tool | ✗  CF-only (uses @cloudflare/playwright) |
| Memory stores | ✓ legacy `/v1/oma` mount + watcher; official `/v1/sessions` local harness mounts immutable read-only snapshots and rejects `read_write` until reverse sync is configured |
| `/v1/vaults` + `/v1/vaults/:id/credentials` full CRUD + `mcp_oauth_validate` | ✓ via package |
| Vault credential injection for outbound MCP / API calls | ✓ via `oma-vault` sidecar (uses `@open-managed-agents/vault-forward`) |
| `/v1/api_keys` mint / list / revoke (SHA-256 hashed in `api_keys` table) | ✓ |
| `/v1/me` + `/v1/me/tenants` + `/v1/me/cli-tokens` | ✓ |
| `/v1/tenants` create workspace + membership | ✓ (no shard assign — CF-only) |
| `/v1/oma/*` mirror namespace | ✓ |
| Postgres backend (DATABASE_URL=postgres://...) | ✓ same code path as SQLite |
| Multi-instance oma-server (PG / MySQL mode) | ✓ PG `LISTEN/NOTIFY` or SQL-tailing SSE fanout (`OMA_REALTIME_FANOUT`); better-auth on the shared database; `oma-vault` is stateless and replicable; needs shared `MEMORY_BLOB_DIR` or `MEMORY_S3_*` |
| Multi-tenant authentication (better-auth) | ✓ email+password + OTP, AUTH_DISABLED=1 escape |
| Console UI (vite dev or built `dist`) | ✓ talks to main-node via `/auth/*` + `/v1/*` |
| Integrations (linear / github / slack) — read-side CRUD on publications, installations, dispatch rules | ✓ wired via `@open-managed-agents/integrations-adapters-node` (set `PLATFORM_ROOT_SECRET`). |
| Integrations write-side OAuth callbacks + setup pages + webhook ingest + publication-create | ✓ wired via `@open-managed-agents/http-routes` `buildIntegrationsGatewayRoutes` + `NodeInstallBridge`. Linear / GitHub / Slack OAuth callbacks land on main-node directly. Webhook receivers (with synthesized `user.message` resume into the bound session), GitHub `refresh-by-vault`, the Linear MCP `/linear/mcp/:sessionId` route, and publication-create endpoints (`start-a1` / `credentials` / `handoff-link` / `personal-token`) all run in-process. |
| `/billing-api/*`, `/v1/internal/usage_events` | ✗  CF-only by design. Talks to a `USAGE_METER` worker not in this repo. Self-host operators bring their own metering or skip. |
| `/v1/runtimes` (RuntimeRoom DO) | ✗  CF-only (DO + WebSocket-backed) |
| Cron / queue handlers | ✗  CF-only (P3 will land scheduler abstraction) |

## Sandbox isolation modes

| Mode | Use when | Configuration |
|---|---|---|
| `DaytonaSandbox` | Production / untrusted code with managed VMs | `SANDBOX_PROVIDER=daytona`, `DAYTONA_API_KEY=...`, optional `DAYTONA_API_URL` (self-hosted) and `SANDBOX_IMAGE=node:22-slim`. Vault CA uploaded into the box on first exec; memory mount via `MEMORY_S3_*` env vars (s3fs installed by the adapter). |
| `LiteBoxSandbox` | Local hardware isolation without docker | `SANDBOX_PROVIDER=litebox`, optional `LITEBOX_MEMORY_MIB`, `LITEBOX_CPUS`, `SANDBOX_IMAGE`. BoxLite ships its own Firecracker runtime (no daemon). Memory mounts work via host bind-mount; vault CA copied into VM on first exec. |
| `E2BSandbox` | Official E2B SDK adapter | `SANDBOX_PROVIDER=e2b`, `E2B_API_KEY=...`, optional `SANDBOX_IMAGE` (template id). Compatible/self-hosted services use `E2B_API_URL` plus `E2B_SANDBOX_URL`, or `E2B_DOMAIN` when they expose the standard wildcard domain. `E2B_CREATE_METADATA` (a JSON object of string values) is passed as the standard `metadata` field of every sandbox creation, which E2B-compatible services can use for per-deployment options such as selecting a container image. Sandboxes are created with a 30-minute initial lifetime (`E2B_SANDBOX_TIMEOUT_MS`, positive integer, milliseconds); while a turn runs the server renews it as described in [Sandbox loss and recovery](#sandbox-loss-and-recovery). Memory uses `MEMORY_S3_*` (same s3fs setup as Daytona). Outbound vault CA upload requires a template that allows `sudo` writes to `/etc/ssl/`. |
| `OpenSandbox` | Self-hosted or remote OpenSandbox server, using the official TypeScript SDK | `SANDBOX_PROVIDER=opensandbox`, `OPENSANDBOX_DOMAIN=localhost:8080`, optional `OPENSANDBOX_API_KEY` and `OPENSANDBOX_PROTOCOL=https`. `SANDBOX_IMAGE=node:22-slim` by default. See [OpenSandbox configuration](../packages/sandbox-adapter-opensandbox/README.md) for resource limits, lifetime, endpoint routing, SDK installation, and harness image requirements. |
| `BoxRunSandbox` | Remote BoxLite REST endpoint (no KVM on the OMA host) | `SANDBOX_PROVIDER=boxrun`, `BOXRUN_URL=http://host:8100/v1/default`, optional `BOXRUN_TOKEN`. No mount primitive — bake a custom image with s3fs preinstalled if you need `/mnt/memory`. |
| `CloudflareSandbox` | If you happen to deploy on CF Workers + Containers | Use the regular `apps/agent` worker, not main-node. |

Every provider installs an Environment's `packages` when a sandbox starts: pip into `/workspace/.venv` (with `uv`, installed from pip when the image lacks it; the venv is created with `--system-site-packages`, so packages installed into the image's system Python stay importable), npm into `/workspace/.npm-global`, cargo into `/workspace/.cargo`, go into `/workspace/.go`, apt system-wide. Those directories are put on `PATH` for the agent's commands. A container that already ran the same list, or whose restored `/workspace` carries it, skips the install; a failed install fails the session with the installer's output. Set `SANDBOX_PIP_INDEX_URL` to install pip packages from a mirror when the sandbox network reaches one faster than pypi.org.

### Pre-built images per Environment (`SANDBOX_IMAGES`)

`SANDBOX_IMAGE` is the deployment default. To let users pick a pre-built image per Environment, publish a catalog in `SANDBOX_IMAGES`, a JSON object keyed by alias:

```bash
SANDBOX_IMAGE=node:22-slim
SANDBOX_IMAGES='{
  "analytics": {
    "reference": "registry.example.com/oma/analytics:2026-10",
    "label": "Analytics",
    "description": "Python 3.12, pandas, polars, Claude ACP"
  },
  "web": { "reference": "registry.example.com/oma/web:2026-10" }
}'
```

- **Aliases** are lowercase (`[a-z0-9][a-z0-9._-]*`, up to 63 characters). `reference` is required and is whatever the provider takes as an image: an OCI image for Daytona, LiteBox and BoxRun, or a template id for E2B. `label` (defaults to the alias) and `description` are optional and shown in the Console. Invalid JSON, an empty `reference` or an unknown key stops the server at startup.
- **Users choose an alias, never a reference.** An Environment carries the choice as an OpenMA extension next to the CMA fields: `POST /v1/environments` with `{"name": "...", "config": {...}, "_oma": {"sandbox_image": "analytics"}}`. An alias that is not in the catalog is rejected with `400 invalid_request_error`. On update, `"_oma": {"sandbox_image": null}` goes back to the default image, and leaving `_oma` out keeps the current choice. Responses include `_oma` only when an image is selected, so requests and responses without it look exactly like plain CMA. Self-hosted Environments cannot select an image.
- **`GET /v1/oma/sandbox_images`** lists `alias`, `label` and `description` for the Console's Environment forms. It never returns `reference`, because image references often expose internal registry hosts and users never need them. When the catalog is empty, the Console hides the selector.
- **At session start** the alias is looked up again. If the operator has since removed it from `SANDBOX_IMAGES`, the session fails with an error naming the alias and the Environment. It never falls back to `SANDBOX_IMAGE`. The resolved image is passed to the sandbox factory as `ctx.image = { alias, reference }`, along with `ctx.environmentId` and `ctx.workspaceId`. The e2b, daytona, litebox and boxrun adapters use it in place of `SANDBOX_IMAGE`. Sprites (a fixed runtime) and the test-only local subprocess reject a selected image instead of ignoring it. A custom factory passed to `nodeDefaults(config, { sandbox })` receives the same `ctx.image` and can map it to its provider's create options.

Recommended setup: bake the heavy, slow-to-install parts (the language runtime, analysis libraries installed into the system Python, `uv`, the ACP agent CLI) into an image. Publish it under an alias, and keep each Environment's `packages` for the few extras on top. Because of `--system-site-packages`, pip packages listed on the Environment install into `/workspace/.venv` without hiding the image's own packages, and a requirement the image already satisfies is normally not installed again. A sandbox whose `/workspace` was restored from a checkpoint reuses its existing venv only if it was set up on the same image: with a catalog image selected, the install markers include the alias, so changing an Environment's image (to another catalog image or back to the default) rebuilds its warm sandbox and, on a restored workspace, removes `/workspace/.venv` and reinstalls the listed pip packages. Packages a user installed into that venv by hand during a session are not kept across such a switch; the venv is platform-managed once a catalog image is in play. Environments that only ever used the default image keep the previous markers, which hash only the package lists, and their venv is never removed.

### Prepared sandbox bases

Opt-in through SDK composition; there is no environment switch, and no built-in factory enables it (many E2B-compatible services cannot snapshot). The control plane prepares bases only when the composed sandbox factory declares `capabilities.preparedBase`. To enable it, pass your own `sandbox` component to `createNodeControlPlane`, wrapped with `withSandboxFactoryCapabilities` from `@open-managed-agents/sandbox`, for example `withSandboxFactoryCapabilities(sandboxFactory, { preparedBase: true })` with the e2b adapter's `sandboxFactory` when your E2B service supports snapshots.

When enabled, the first session with a given setup still starts cold. Once its own sandbox exists, the server builds a separate, clean sandbox in the background, runs only the base setup on it, has the provider snapshot it, and destroys it. Later sessions with the same setup create their sandbox from that snapshot, so the install steps find everything in place and skip it.

- **What the snapshot contains:** the Environment's `packages` (apt system-wide plus pip/npm/cargo/go under `/workspace`) and, for `acp-sandbox` agents with a pinned `registry` agent, Node and the prefetched agent package. The builder sandbox gets no session inputs, files, memory, outputs, Vault credentials or session environment, and the ACP prefetch strips provider secrets, so none of these can end up in the snapshot.
- **Keyed by content:** the cache key is a hash of the provider, the image (the catalog alias and reference, or `SANDBOX_IMAGE`), the package lists in order, a hash of `SANDBOX_PIP_INDEX_URL`, the pinned ACP package and its Node version, and a setup-script version bumped by OpenMA releases that change the setup. Any change produces a new key and a new base; Environments with no packages and no pinned ACP agent are not cached. Entries live in the database's key-value table, per workspace, and each workspace gets its own provider snapshot name. The provider account (API URL, team) is not part of the key: after switching accounts, the first create from an old base fails, is recorded, and the key is rebuilt after the backoff.
- **Providers:** only e2b implements capture (via its sandbox snapshots). The other adapters (daytona, litebox, boxrun, sprites) cannot, and a factory given a base it cannot use fails instead of ignoring it. If you declare the capability for an E2B-compatible service that does not implement snapshots, every capture fails with `404` and is recorded and logged like any failed build, costing one builder per setup and hour.
- **Failures never fail a session.** A failed build, or a failed create from an existing base (for example a snapshot the provider deleted), is recorded with its error and logged as `op: "main-node.prepared_base"` with `path` `build_failed` or `hit_failed`; the session continues on a normal cold sandbox. A failed entry blocks rebuilding that key for an hour, so a broken setup is not rebuilt on every session. A create from a base is recorded as failed for every replica only when the provider says the base is gone (a 404 or a "snapshot/template not found" error); other errors make only that server process skip the base for an hour, and after three such failures in a row the base is treated as gone. A build that has not finished after 30 minutes is failed and its sandbox destroyed. Shutting the server down aborts running builds and destroys their sandboxes; a builder still being created is waited for up to 10 seconds, and one that takes longer lives until the provider's own sandbox timeout. Errors are stored and logged with credentials in URLs masked (a password containing an unencoded `/` is not recognised). An unreadable cache entry is treated as a miss and rebuilt; it is logged once per server process. A build that reaches its deadline while the provider is still taking the snapshot may leave that snapshot behind unrecorded. Hits, misses and successful builds are logged on the same `op` with `durationMs`.
- **Workspace checkpoints still win.** With `OMA_WORKSPACE_STRATEGY=checkpoint_restore`, a session's restored `/workspace` is unpacked over the base's. The install markers in `/tmp` and `/workspace` must both match before setup is skipped, so a restored workspace from an older package list is brought up to date as before.
- **Cost:** each build runs one extra sandbox for the duration of the setup, and snapshots are stored, billed and expired by the provider under its own policy. Rebuilding a key appends a new build under the same snapshot name; OpenMA does not delete old snapshots.
- Each server process builds a given key at most once at a time. Two replicas may occasionally build the same key concurrently; the result is the same and only one extra builder is spent.

Vault credentials of type `environment_variable` are set in the sandbox of every session that attaches the Vault (an earlier Vault wins on a name clash), so the agent's commands can read them. The sandbox holds the real value: there is no egress proxy substituting it, and `networking` / `injection_location` are not enforced, so only store secrets the agent may see.

### Per-provider capability matrix

| Provider | bash | fs | net | `/mnt/memory` | `/mnt/outputs` | vault CA | workspace backup |
|---|---|---|---|---|---|---|---|
| `LiteBox` | ✓ | ✓ | ✓ | ✓ (host bind-mount via SimpleBox volumes) | ✓ | ✓ (CA copyIn on first exec) | ✓ (tar via exec + readFileBytes) |
| `Daytona` | ✓ | ✓ | ✓ | ✓ (s3fs, requires `MEMORY_S3_*`) | ✓ (single-bucket layout: outputs under `session-outputs/<tenant>/<session>/`) | ✓ (CA upload on box create) | ✓ (tar via exec + readFileBytes) |
| `E2B` | ✓ | ✓ | ✓ | ✓ (s3fs, requires `MEMORY_S3_*` + template with s3fs) | ✓ (same bucket, session-outputs prefix) | ⚠ (template must allow sudo writes to /etc/ssl/) | ✓ (tar via exec + readFileBytes) |
| `BoxRun` | ✓ | ✓ | ✓ | ✗ (HTTP API has no mount primitive — use a custom image with s3fs preinstalled) | ✗ (same — no host-bind primitive) | ✓ (CA upload via tar PUT) | ⚠ (best-effort tar via exec) |
| `OpenSandbox` | ✓ | ✓ | ✓ | ✗ | ✗ (generic managed runtime can collect outputs) | ✗ | ✗ |
| `CloudflareSandbox` | ✓ | ✓ | ✓ | ✓ (R2 + FUSE) | ✓ | ✓ (interceptHttps + outboundHandlers) | ✓ (squashfs to R2 backup bucket) |

Read-only memory mounts: Daytona and E2B enforce read-only on their mounted view. LiteBox honors the `readOnly` flag on its volume mount. CloudflareSandbox does not enforce ro at the FS layer — the harness's write tool checks `assertWritable` and refuses writes regardless of provider.

### Sandbox loss and recovery

Sandboxes are disposable ([ADR 0005](./adr/0005-self-hosted-worker-runtime-resources.md)): a provider may reclaim one at any time (lifetime expiry, eviction, a backend restart). The Node server (`apps/main-node`) handles that for providers that implement the runtime Port (`status`/`renewLease`; E2B does):

- **Heartbeat.** While a turn runs — including its drain, checkpoint and output publication — the server renews the sandbox lease every `min(60s, ttl/3)` with a TTL of `OMA_SANDBOX_LEASE_TTL_SEC` (default `1800`, minimum `60`). After the turn the sandbox lives at most that long idle, then the provider may reclaim it.
- **Before a turn.** A warm sandbox is probed first; a lost one is discarded and a new sandbox is acquired, restored and prepared (Session resources, skills, Environment packages, Vault environment variables).
- **During a turn.** When a sandbox operation fails and the sandbox no longer answers the probe (or a lease renewal finds it gone), the server replaces it and the tool call that hit the loss fails with a message saying the environment restarted and what `/workspace` now holds. The agent is not told about sandboxes, providers or their errors (those go to the server log), and the call is not retried, because it may have had effects outside the sandbox and the files it relied on may be gone. Later operations run on the replacement. After three losses in one turn, or when no replacement can be acquired, the turn fails with `session.error`.
- **What survives.** With `OMA_WORKSPACE_STRATEGY=checkpoint_restore`, a replacement gets `/workspace` from the last published checkpoint (published at successful turn ends, at most every `OMA_WORKSPACE_CHECKPOINT_INTERVAL_SEC`, default `60`). With the default `ephemeral` strategy a replacement starts from a clean `/workspace`. The conversation always survives: it lives in the Session event log, not in the sandbox.

## Vault credential injection

For managed harnesses inside a sandbox, use the scoped HTTP MCP gateway:
`/v1/oma/mcp-proxy/<session>/<server>`. The ACP projection replaces each
declared upstream MCP URL with this gateway URL and authenticates with the
current Work `sessions_token`. The server validates the exact active claim,
Session and server declaration, then overwrites the Work bearer with the
upstream Vault credential. The upstream URL and credential are not given to
the sandbox.

### Legacy transparent `oma-vault` sidecar

The sidecar below is retained for single-operator/local compatibility. It is
**advisory, not a multi-tenant security boundary**: a process can ignore proxy
environment variables, and the current CONNECT path cannot prove which
Session/Work generation originated a request. Do not use it for an untrusted
multi-tenant `required` credential-egress profile. A production Node/Docker
transparent deployment needs an isolated network plus a scoped, fenced egress
gateway that passes ADR 0007 conformance.

When a cooperating sandbox bash runs `curl https://api.github.com/...`, the
legacy sidecar injects
the matching vault credential as an `Authorization: Bearer ...` header
without exposing the token to that process. Unlike the Cloudflare fenced
interceptor, this alone does not prevent bypass or safely attribute tenants.

How it works:

```
sandbox bash
  ├── HTTPS_PROXY=http://oma-vault:14322
  ├── NODE_EXTRA_CA_CERTS=/app/data/oma-vault-ca/ca.crt
  ├── SSL_CERT_FILE=/app/data/oma-vault-ca/ca.crt
  └── curl https://api.github.com/user
              │
              ▼
       oma-vault (mockttp HTTPS MITM proxy)
       ├── Strip incoming Authorization (zero-trust)
       ├── Look up credential matching api.github.com host
       ├── Inject Authorization: Bearer <vault token>
       └── Forward to upstream
                  │
                  ▼
           api.github.com  ← sees real Authorization header
```

Set up:

```bash
# 1. Create a vault.
VID=$(curl -s -X POST localhost:8787/v1/vaults \
  -H 'content-type: application/json' \
  -d '{"name":"github-prod"}' | jq -r .id)

# 2. Add a static_bearer credential bound to api.github.com.
curl -s -X POST localhost:8787/v1/vaults/$VID/credentials \
  -H 'content-type: application/json' \
  -d '{
    "display_name":"github-pat",
    "auth":{
      "type":"static_bearer",
      "token":"ghp_xxx",
      "mcp_server_url":"https://api.github.com"
    }
  }'

# 3. Run an agent. Its bash `curl https://api.github.com/user` will see
#    the credential injected; the model never sees the raw token.
```

The CA at `./data/oma-vault-ca/ca.crt` is regenerated on first vault
start and persisted across restarts. Sandboxes mounted with the shared
`./data` volume pick it up automatically through `OMA_VAULT_CA_CERT`.

## Architecture

```
                 Browser / curl / oma CLI
                          │
                          ▼ HTTP/SSE
              ┌──────────────────────────┐
              │  main-node (single proc) │
              │                          │
              │  • Hono routes           │
              │  • SessionRegistry       │
              │  • SqlEventLog           │
              │  • InProcessEventStreamHub (sqlite mode)│
              │  • PgEventStreamHub      (pg mode, LISTEN/NOTIFY)│
              │  • DefaultHarness ──┐    │
              │                     │    │
              │  Sandbox: ▼         │    │
              │ litebox|e2b|remote  │    │
              └──────┬─────┬───────┘
                     │     │
            ┌────────┘     └─────────┐
            ▼                        ▼
        SQLite                     E2B Cloud
        ./data/oma.db              (Firecracker microVMs)
        ./data/                   OR
                                   isolated provider runtime
```

Eight runtime-agnostic ports separate "what" from "how":

  - `BlobStore`  — files/memory/workspace bytes (R2 / S3 / local FS)
  - `KvStore`    — config/snapshot key-value (CONFIG_KV / pg table / memory)
  - `SqlClient`  — SQL with batch (D1 / better-sqlite3 / postgres.js / mysql2)
  - `EventLogRepo`+`StreamRepo` — per-session event durability
  - `SandboxExecutor` — code execution sandbox (CF / LiteBox / E2B / Daytona / BoxRun)
  - `ToMarkdownProvider` — web_fetch HTML→md (Workers AI / turndown)
  - `TenantDbProvider` — per-tenant DB resolution

Each port has a Cloudflare adapter and a Node adapter. The Node entry
wires the Node adapters; the CF entry wires the CF adapters. Business
code (routes, harness, store services) is the same on both.

## Console UI

The same `apps/console` build that ships with CF prod talks to main-node.
Auth path is `/auth/*` (matches CF), data routes are `/v1/*`. Cookie auth
via better-auth.

**Two ways to serve it:**

### Single port (production / `docker compose up`)

The main-node Docker image embeds `apps/console/dist` and main-node's
`serveStatic` middleware mounts it at `"*"` with index.html SPA fallback.
Open `http://localhost:8787` and you get the Console — same port as the
API. CF prod has the equivalent via the `ASSETS` binding; same UX,
different mechanism.

```bash
docker compose -f docker-compose.yml up -d
open http://localhost:8787
```

To skip the console build (smaller API-only image, ~250MB → ~245MB):

```bash
docker build -f apps/main-node/Dockerfile --build-arg SKIP_CONSOLE=1 \
  -t openma/main-node:api-only .
# then unset CONSOLE_DIR in your runtime env
```

### Vite dev server (development)

Hot-reload on console source changes. main-node still runs separately
on 8787; vite proxies `/v1` + `/auth` to it.

```bash
# Terminal 1: main-node
ANTHROPIC_API_KEY=sk-... BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  PUBLIC_BASE_URL=http://localhost:5173 \
  pnpm --filter @open-managed-agents/main-node start

# Terminal 2: console (Vite dev server, proxies /v1 + /auth → :8787)
VITE_API_TARGET=http://localhost:8787 pnpm dev:console
# → http://localhost:5173

# Terminal 3 (optional): oma-vault — outbound credential injection
DATABASE_PATH=$(pwd)/data/oma.db OMA_VAULT_CA_DIR=$(pwd)/data/oma-vault-ca \
  pnpm --filter @open-managed-agents/oma-vault start
```

Open `http://localhost:5173` (dev) or `http://localhost:8787` (docker),
sign up via email + password. The verification OTP is printed to
main-node's stdout — paste into the console verify-signup screen.
Operators wiring real email replace the `sendVerificationOTP` callback
in `apps/main-node/src/auth/config.ts` with a Resend / SES / SMTP call.

Endpoints main-node implements for the console:
- `/auth-info` (provider list)
- `/auth/*` (better-auth: sign-up, sign-in, sign-out, get-session, OTP)
- `/v1/me`, `/v1/me/tenants`
- `/v1/agents` CRUD, `/v1/sessions` CRUD + events + SSE stream
- `/v1/memory_stores` + `/memories` + per-session bindings
- `/v1/vaults` + `/credentials`
- `/v1/model_cards` CRUD (+ `/key` for cleartext; capability probe on create)
- `/v1/environments` CRUD (+ archive). Node persists the environment config,
  but currently runs sessions in the local sandbox snapshot; environment
  package lists are not installed automatically at warmup yet.
- `/v1/models` and `/v1/models/:id` (official tenant Model Card catalog), plus `/v1/oma/models/list` (Pi provider setup catalog; optional legacy provider-key discovery)
- `/v1/integrations/{linear,github,slack}/{installations,publications,...}` — read + persona/capability PATCH + dispatch-rule CRUD. Active when `PLATFORM_ROOT_SECRET` env var is set. Publication-create endpoints (`start-a1`, `credentials`, `handoff-link`, `personal-token`) now run in-process via `NodeInstallBridge.startInstallation` — wire shape matches the CF gateway verbatim. The OAuth callback / setup-page / webhook / Linear MCP / GitHub refresh-by-vault routes are all in-process via `buildIntegrationsGatewayRoutes`.

Endpoints stubbed (return empty `data: []` so the UI degrades gracefully):
- `/v1/api_keys`, `/v1/me/cli-tokens`,
  `/v1/runtimes`, `/v1/skills`

These pages render an "empty" state in the console; their CF counterparts
will land in main-node as follow-up work.

### Integrations on self-host

The Node read + write side comes online automatically when
`PLATFORM_ROOT_SECRET` is set. The schema (linear_*, github_*, slack_*
tables) is created on boot via `applyIntegrationsSchema`. Webhook-events
retention sweep also runs every minute (cron-gated to 04:00 UTC) when
the schema is present.

What this gets you:
- Console can list / patch / unpublish existing publications and dispatch
  rules.
- Linear / GitHub / Slack OAuth callbacks land directly on main-node
  (`/linear/oauth/...`, `/github/install/...`, `/slack/oauth/...`,
  `/<provider>-setup/<token>`). The provider implementations from
  `packages/{linear,github,slack}` run in-process via `NodeInstallBridge`.
- Webhook receivers (`/linear/webhook/...`, `/github/webhook/...`,
  `/slack/webhook/...`) verify HMAC signatures via the same provider
  code path the CF gateway uses. When a verified webhook lands on a
  session bound to the publication (Linear comment-reply, GitHub
  per_issue PR comment, Slack thread reply), `NodeInstallBridge`'s
  in-process `SessionCreator.resume` synthesizes a `user.message`
  event and appends it to the session via the same `NodeSessionRouter`
  the public `POST /v1/sessions/:id/events` route uses — the harness
  wakes up automatically.
- The Linear MCP escape-hatch route (`POST /linear/mcp/:sessionId`)
  proxies `linear_graphql` calls with the per-session bearer.
- GitHub `refresh-by-vault` (`POST /github/internal/refresh-by-vault`)
  mints fresh installation tokens via App-JWT and rotates the static_bearer
  + cap_cli vault credentials in place.
- Linear cron dispatch (auto-pickup of issues) is exposed to the Node
  scheduler via `linearDispatchTick` from
  `@open-managed-agents/scheduler/jobs/linear-dispatch`.

Required env on the Node side: `PLATFORM_ROOT_SECRET` (at-rest encryption
for OAuth tokens), `INTEGRATIONS_INTERNAL_TOKEN` (gates
`/github/internal/*`), `GATEWAY_ORIGIN` (public origin handed to providers
as redirect_uri / webhook URL — defaults to `PUBLIC_BASE_URL`). Provider
client_id / client_secret pairs go on the App row at install time, not in
env. CF stays unchanged: same gateway worker, same INTEGRATIONS service
binding, same shared INTEGRATIONS_DB.

`/billing-api/*` and `/v1/internal/usage_events` are CF-only by design
(both call out to a `USAGE_METER` worker that lives in a separate repo).
Self-host operators run their own metering or skip the billing pipeline.

## Local provider chaos lab

The repository includes an opt-in local cluster runner for exercising a real
Daytona, LiteBox, or BoxRun adapter without sending model traffic to a paid
provider. The runner starts three pieces in one disposable lab:

```
local Anthropic Messages fixture ──┐
                                  ├── OpenMA main-node (temporary SQLite + event log)
configured SandboxPort provider ──┘       └── Daytona | LiteBox | BoxRun
```

The fixture is the only mocked external dependency. Sandbox calls are real,
so a run is meaningful only when the selected provider is configured. The
chaos sequence is:

1. complete a healthy turn through `/v1/oma/*`;
2. delay the next model response, kill main-node in-flight, and leave its
   SQLite/event-log state behind;
3. restart main-node with the same state directory, verify orphan recovery,
   then complete another turn;
4. optionally invoke an operator-supplied provider delete endpoint.

Run it from the repository root:

```sh
# Local hardware-isolated BoxLite/LiteBox (requires its native runtime/KVM).
OMA_CHAOS_PROVIDER=litebox pnpm test:e2e:provider-chaos

# Daytona (the adapter creates a real VM; the key is never printed).
OMA_CHAOS_PROVIDER=daytona DAYTONA_API_KEY="$DAYTONA_API_KEY" \
  pnpm test:e2e:provider-chaos

# BoxRun/boxlite serve (the endpoint must already be running).
OMA_CHAOS_PROVIDER=boxrun BOXRUN_URL=http://127.0.0.1:8100/v1/default \
  pnpm test:e2e:provider-chaos
```

Useful controls:

| Variable | Meaning |
| --- | --- |
| `OMA_CHAOS_LLM_DELAY_MS` | Delay used to create the in-flight crash window (default `15000`). |
| `OMA_CHAOS_HEALTH_TIMEOUT_MS` | Main-node boot deadline (default `60000`). |
| `OMA_CHAOS_TURN_TIMEOUT_MS` | Per-turn/recovery deadline (default `60000`). |
| `OMA_CHAOS_PORT` | Fixed local main-node port; otherwise a free port is selected. |
| `OMA_CHAOS_KEEP_DATA=1` | Keep the temporary SQLite/blob/workdir tree for inspection. |
| `OMA_CHAOS_PROVIDER_KILL_URL` | Explicit destructive provider endpoint. If absent, the provider-kill step is reported as skipped. |
| `OMA_CHAOS_PROVIDER_KILL_TOKEN` | Optional bearer token for that endpoint (never logged). |

The runner is deliberately not a claim that every adapter has Managed
Runtime Host fencing. It verifies the common `SandboxPort` execution path and
Node `SessionRegistry` crash recovery. Daytona/LiteBox/BoxRun sessions are
created lazily by their adapters; a hard kill can leave a provider-side box
or VM orphaned when the provider has no discover/delete hook. Use the explicit
kill URL or the provider's own cleanup tooling for that case. Full lease,
fencing, split-brain, and retry-budget chaos remains covered by the
deterministic managed-runtime tests and is not silently attributed to a
SandboxPort-only provider.

The runner always forces `AUTH_DISABLED=1`, a temporary SQLite database, and
local blob roots. It inherits provider configuration but replaces
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` with the local fixture, so no real LLM
credential is required or used.

## Production hardening (what's NOT in the PoC)

If you take this past trusted-dev territory, you'll want:

  - **Real auth.** Today every request is `tenant_id="default"`. Wire
    better-auth + the `auth.ts` middleware that apps/main uses.
  - **Isolated sandbox credentials.** Configure E2B, Daytona, BoxRun, LiteBox,
    or another certified isolated provider before starting the Node service.
  - **Backups.** SQLite + ./data is one host. `litestream` to S3 covers
    point-in-time recovery; for higher durability, swap to Postgres.
  - **Observability.** No Analytics Engine equivalent yet. Pipe
    `pino` stdout into Loki / Grafana / your shipper of choice.
