# Kimi Hosted Agents P0/P1 adapter

Opt in on the Node server with `OMA_KIMI_KHA_COMPAT=1`, then point KHA v0.4.2 at `http://host:8787/kha`. The CLI adds `/v1`. Native `/v1` routes retain their original contracts. Use an existing OMA API key and agent; production input is forwarded to the configured OMA runner.

This module reuses native authenticated HTTP routes, persistence, session execution and output storage. It accepts `kimi-api-version` without enforcement. Implemented: agents list/get; environments create/list/get; sessions create/list/get; one text user message per append; history and resumable SSE (session and thread); thread list/get; session-scoped artifact list/get/download. JSON shapes follow the captured `2026-09-01-beta` subset in the tests.

For a local demo without Docker, provider credentials or LLM calls:

```bash
pnpm --filter @open-managed-agents/main-node exec tsx scripts/kimi-kha-smoke-server.ts
```

In another shell (requires `jq` and the installed `kha`):

```bash
export KHA_BASE_URL=http://127.0.0.1:8799/kha
export KIMI_API_KEY=dummy
kha whoami
agent_id=$(kha agents list -o json | jq -r '.items[0].id')
environment_id=$(kha environments create --name kha-spike -o json | jq -r '.id')
session_id=$(kha sessions create --agent "$agent_id" --environment "$environment_id" -o json | jq -r '.id')
kha sessions send "$session_id" hello --wait --timeout 5s
kha sessions events "$session_id"
artifact_id=$(kha artifacts list --session "$session_id" -o json | jq -r '.items[0].id')
kha artifacts download "$artifact_id" --out /tmp/kha-report.txt
kha sessions attach "$session_id" # Ctrl-C to stop
```

The demo is a test fixture using real OMA route validators/mappers and in-memory application ports. Its agent definition is reused from existing tests; it constructs no runner and makes no inference calls. `dummy` is only a fixture credential. Stop the server with Ctrl-C.

### Official CLI base URL smoke (verified with kha 0.4.2)

The environment variable and global flag both work. Pass the base ending in
`/kha`, not `/kha/v1`; the CLI adds `/v1`. An explicit `--base-url` overrides
`KHA_BASE_URL`, including when the flag has a trailing slash. An explicit
`--profile` ignores the environment key and endpoint, so omit it for the
fixture commands above. Use `kha version`, not `kha --version`.

To capture fixture request paths, HTTP statuses and error bodies without
logging request bodies or authorization headers, start from the repository root:

```bash
OMA_KIMI_KHA_COMPAT=1 KHA_SMOKE_TRACE=1 PORT=8799 \
  node apps/main-node/node_modules/tsx/dist/cli.mjs \
  apps/main-node/scripts/kimi-kha-smoke-server.ts
KIMI_API_KEY=dummy kha --base-url http://127.0.0.1:8799/kha whoami
```

The fixture always mounts the adapter; `OMA_KIMI_KHA_COMPAT=1` gates the real
Node control plane. `whoami` verifies access by listing one agent, rather
than calling an identity endpoint. It reports configuration, not an OMA user.

Verified commands: agents list/get; environments create/list/get (including
self-hosted configuration); sessions create/list/get/send with `--wait`,
events with `--limit`/`--all`/`--watch`, attach (history and `--since now`),
interrupt, and artifacts list/get/download. Attach/watch stay open after an
idle event; Ctrl-C detaches with exit 130. A new message after interrupt works.
The fixture responds synchronously, so interrupt after a completed send returns
400 `failed_precondition_error`. Running acceptance is covered by adapter and
authenticated SQLite tests, not a live runner.

Known CLI boundaries:

| Command or flag | Observed adapter / CLI result |
| --- | --- |
| agents `--order`, `--exclude-multiagent` | HTTP 200, CLI exit 0; creation ordering and exclusion of native non-null `multiagent`, applied before pagination |
| environments `--include-archived`; sessions `--status` | HTTP 200, CLI exit 0; archived inclusion and actual status filtering (including empty results) |
| events `--order desc` (session or thread) | HTTP 200, CLI exit 0; newest first, subsequent pages move backward; `stream_cursor` resumes after the newest native row on that page |
| environments create `--wait` / wait-ready | HTTP 201/200, CLI exit 0 within the 2s smoke bound; stable `build_status: ready` projects usable OMA configurations, not Moonshot remote image-build telemetry |
| sessions threads list/get/events; attach `--thread` | HTTP 200 for observed threads and `sthr_primary`; attach receives the selected lane and stays open until Ctrl-C (exit 130). Unknown threads remain 404. |
| sessions pending list | HTTP 501 after authorization; native queued inputs are not exposed by this subset |
| artifact get/download `--version 1` | HTTP 400, CLI exit 1; native outputs have no immutable version snapshots |
| agents `--limit 101`; attach `--since invalid` | HTTP 400, CLI exit 1 |
| sessions send with whitespace text | CLI exit 2 before HTTP |
| sessions continue | No such subcommand in 0.4.2; prints parent help and exits 0 without HTTP. The raw `/continue` endpoint returns 501. |

These observations establish the fixture transport subset, not live Hosted
Agents service parity. No provider call or official API credential is needed. The gaps smoke uses a
2s readiness timeout, 100ms wait interval, and bounded attach cancellation.

List queries accept agents `order=created_at|created_at_desc` (default newest
first), `exclude_multiagent=true|false`; environments `include_archived`; and
sessions `statuses=idle,running,stopping,terminated` (CSV or repeated keys),
plus a `status` alias. Native `rescheduling`/`rescheduled` maps to `running`;
OMA has no durable `stopping` state, so that filter currently returns no rows.
Sessions also accept `include_archived` and `order=created_at|created_at_desc|
updated_at|updated_at_desc` (default last-updated first). Boolean values and
enums are validated. Other query names still return 400, as does page size
outside 1–100. Artifact versions remain unsupported.

Lists scan authenticated native pages before filtering/sorting and use scoped
adapter cursors, with a 10,000-row bound (409 on overflow). This keeps ordering
correct across native pages but is not an indexed large-account implementation.
Tokens bind to resource, ordering and filters; changing those requires restarting
pagination. Results are not snapshot-isolated under concurrent mutations. Old
native list tokens from the earlier spike must be discarded.

### Running against the real Node control plane

Start `apps/main-node/src/index.ts` with `OMA_KIMI_KHA_COMPAT=1`, an available
port, the normal database/blob/output paths, and a configured isolated
`SANDBOX_PROVIDER` with its required credentials. Use an OMA API key as
`KIMI_API_KEY`; a Hosted Agents key is not an OMA credential. Provision the
agent through native OMA APIs and reference its existing model configuration
and provider credentials. The adapter does not implement agent creation.

The standalone entry point starts the existing session execution worker and
scheduler; there is no separate KHA runner. Persistent database migrations,
output storage, a working sandbox and model access are needed for an actual
turn and downloadable output. The assembled SQLite tests check routing, persistence, real API-key ownership,
artifact storage and interrupt state preconditions without a provider turn. The
authenticated test uses a self-hosted environment with no connected worker and
seeds lifecycle states in SQLite. The
`NODE_ENV=test OPENMA_TEST_SANDBOX_PROVIDER=local-subprocess` selector is
test-only, not a production sandbox configuration.

Tests:

```bash
pnpm --filter @open-managed-agents/main-node exec vitest run --no-cache --config vitest.config.ts test/kimi-kha-compat.test.ts test/kimi-kha-control-plane.test.ts test/config.test.ts test/openai-sse-http.test.ts
```

On a shared box, set `TMPDIR` to a fresh dedicated directory before running
Vitest: the main-node temporary-resource check otherwise treats concurrently
created `/tmp/oma-*` files from other tasks as leaks. When dependencies are
already available, the same suite can run via `node node_modules/vitest/vitest.mjs`
from `apps/main-node`, with the arguments above; no install is required.

SSE scans retained history once at connection setup, then follows native opaque keyset page boundaries once per second. Because native `next_page` is absent at the tail, each idle poll rereads at most the final 100 rows and suppresses that page’s already-seen IDs; bursts drain through successive pages before sleeping. It never repeatedly scans the accumulated history. Disconnect cancels the wait and signals an in-flight native read. Cursors encode session + last event ID, survive adapter recreation, and support explicit cursor precedence over `Last-Event-ID`; `now` tails future events with a control frame. Initial replay (and REST history) is bounded to 10,000 native rows; an open stream can grow beyond that. This is bounded incremental polling, not push: it still costs one authenticated page read per second per idle connection, and reconnect still scans history. Native ordering is timestamp/ID based; backdated inserts behind the boundary may be missed, and queued inputs stamped later may reappear with the same ID. Clients should deduplicate IDs. Production still needs sequence-based replay, retention semantics, connection limits and distributed replay tests. The native public SSE route has no resume query and does not currently return its pending iterator on disconnect, so this adapter does not compose it. Delta requests are accepted, but only complete events are emitted.

Artifacts are current native session outputs: synthetic `/output/<filename>` paths, stable encoded IDs, version `"1"`, no immutable snapshots. Unsupported queries/inputs return 400 and unsupported operations return JSON 404. No agent writes, rich agent definitions, full multimodal parity, session resources/overrides, custom tool result input, setup scripts, worker protocols, archive/update operations, billing, OAuth, or artifact version APIs are implemented. Broader native semantics are not Kimi behavioral parity.

Contract sources: [OpenAPI](https://platform.kimi.com/docs/hosted-agents/openapi.yaml), [quickstart](https://platform.kimi.com/docs/hosted-agents/quickstart). The test fixture records the retrieval date and source hash. No CLI/SDK public packages changed, so no changeset is required.

## P1 session controls

`POST /sessions/:id/events` accepts a single `{ "type": "user.interrupt" }` (optional empty `data`) and forwards it to OMA's authenticated event API. It returns **202 `{}`**, not a queued `event_id` or invented `control_epoch`. The KHA path requires a running, non-archived session: idle and terminated sessions return 400 `failed_precondition_error` without appending an interrupt. The check runs inside the native application CAS retry loop, so a concurrent state change is revalidated before acceptance. An in-process binding carries this opt-in constraint after native authentication; no HTTP header enables it. Native `/v1` interrupt behavior remains unchanged. OMA cancels active executions including child lanes. Acceptance does not mean cancellation has finished: inspect session state/events. Native cancellation reports `end_turn`; the adapter does not infer a `canceled` result from an earlier interrupt request. Queued work follows native OMA scheduling. This subset does not expose control epochs or message-free continuation. Current official [session operations](https://platform.kimi.com/docs/hosted-agents/session-operations) describe cancellation of a running turn and subsequent new input; earlier captured schema fields alone do not establish durable pause semantics.

`POST /sessions/:id/continue` is recognized, authenticates/checks the session, and returns **501** with a specific reason: OMA has no message-free continuation or durable `interrupted`/`control_epoch` state. Terminated/archived sessions return 409. A new ordinary `user.message` can start another turn using native behavior. No synthetic message is inserted by `/continue`. Interrupt with `data.expected_control_epoch` likewise returns 501 before mutation because native fencing cannot enforce that token. The OpenAPI has no separate session `/stop` or `/resume`; environment work-item stop is a different worker-lease protocol and remains out of scope.

## P1 event projection

History and SSE use the same projection and preserve event IDs, timestamps and available `session_thread_id`:

| Native event | KHA projection |
| --- | --- |
| `agent.tool_use`, `agent.mcp_tool_use` | `agent.tool_use` with nested `tool_use`; `allow` → `always_allow`, `ask` → `always_ask`; MCP server name → `data.mcp.server_name`. Missing/denied permission is omitted, never converted to allow or tool-started. |
| `agent.tool_result`, `agent.mcp_tool_result` | `agent.tool_result`, preserving the tool-use reference and explicit `is_error`. Text content also supplies `structured_content`; no separate display blocks are invented. Missing error flags or non-text results are omitted. |
| `agent.custom_tool_use` | Same type, nested name/input. Result submission remains outside this spike. |
| `span.model_request_start` | `agent.model_started` (no payload). Model-end/usage/outcome spans are omitted. |
| `session.thread_created` | Same type, nested `agent_name`; native parent/tool linkage is not represented by Kimi's payload. |
| `session.thread_status_*` | `session.thread_status`; rescheduled → running, native stop reason mapped as for session status. |
| `agent.thread_message_sent/received` | Same type, nested content, peer thread ID and available agent name. Native `from_message_id` is omitted. |
| `agent.thread_context_compacted`, `user.interrupt` | Same type, no payload. |

No tool-started or tool-success event is inferred. Unknown events, workflow events and unmatched spans remain omitted. Omitted rows still advance the internal native page boundary and REST cursor; if no mapped SSE frame follows, the client keeps its previous cursor and may revisit omitted rows on reconnect. Native queued inputs may lack Kimi's required processing timestamp until consumed; full queued-input/control-epoch conformance remains a gap. Multimodal event conversion remains outside this spike.

## Thread REST projection

`GET /sessions/:id/threads`, `/threads/:thread_id`, `/threads/:thread_id/events`
and `/threads/:thread_id/events/stream` project the same retained native log.
The existing OMA `sthr_primary` lane is always listed first, even before input;
untagged native events belong to that lane. Its agent snapshot and lifecycle
come from the parent session. Children exist only when an event carries their
`session_thread_id`; peer references alone do not manufacture threads. Children
follow creation order, their timestamps come from observed events, and their
status is the latest thread-status event (initially `idle` until observed).
Parent links are included only when a native thread-created event supplies one.
Child pinned agent snapshots and archive metadata are unavailable in this log
projection and are omitted. No `control_epoch` or durable `interrupted` flag is
synthesized; thread archive remains unsupported.

Session-level history and SSE expose only the coordinator (`sthr_primary`, including
untagged native rows). Child output is available through the selected thread
endpoint, so child idle events cannot end a coordinator client wait.

Thread history filters before pagination; descending pages and SSE share the
same event mapping as session history. Thread cursors bind to session and lane,
so they cannot be used on a sibling lane. Streams filter replay and live polling,
while still advancing over unrelated native rows. Thread discovery and initial
history share the 10,000-row replay bound; this is not a separate multi-agent
runtime or a persistent thread graph.

## Compatibility regression checks

Text message submission returns HTTP 202 with the accepted native event ID.
Pending input inspection returns 501 rather than claiming a live queue is empty.
The native event-admission CAS remains the single state authority (ADR 0006);
compatibility checks do not introduce a second runner or cancellation queue.

The tests distinguish in-memory route fixtures from authenticated SQLite
composition. The latter verifies foreign credentials cannot read sessions,
threads, events or artifacts, submit interrupts, or reuse another workspace's
agent/environment. The application regression forces a revision conflict that
changes running to idle and verifies that no interrupt is committed/dispatched.
Full hosted-service parity, provider inference and completed runner cancellation
are not established by these tests.
