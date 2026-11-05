# Kimi Hosted Agents P0 adapter

Opt in on the Node server with `OMA_KIMI_KHA_COMPAT=1`, then point KHA v0.4.2 at `http://host:8787/kha`. The CLI adds `/v1`. Native `/v1` routes retain their original contracts. Use an existing OMA API key and agent; production input is forwarded to the configured OMA runner.

This module reuses native authenticated HTTP routes, persistence, session execution and output storage. It accepts `kimi-api-version` without enforcement. Implemented: agents list/get; environments create/list/get; sessions create/list/get; one text user message per append; history and resumable SSE; session-scoped artifact list/get/download. JSON shapes follow the captured `2026-09-01-beta` subset in the tests.

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

Tests:

```bash
pnpm --filter @open-managed-agents/main-node exec vitest run --no-cache --config vitest.config.ts test/kimi-kha-compat.test.ts test/kimi-kha-control-plane.test.ts test/config.test.ts test/openai-sse-http.test.ts
```

SSE polls retained history once per second. Cursors encode session + last event ID, survive adapter recreation, and support explicit cursor precedence over `Last-Event-ID`; `now` tails future events with a control frame. Replay is bounded to 10,000 native rows. This relies on stable retained-history ordering; a production adapter needs incremental sequence-based reads, retention semantics, connection limits and distributed replay tests. Delta requests are accepted, but only complete events are emitted.

Artifacts are current native session outputs: synthetic `/output/<filename>` paths, stable encoded IDs, version `"1"`, no immutable snapshots. Unsupported queries/inputs return 400 and unsupported operations return JSON 404. No agent writes, rich agent definitions, tool/subthread events, multimodal parity, session resources/overrides, custom tools, setup scripts, worker protocols, archive/update operations, billing, OAuth, or artifact version APIs are implemented. Broader native semantics are not Kimi behavioral parity.

Contract sources: [OpenAPI](https://platform.kimi.com/docs/hosted-agents/openapi.yaml), [quickstart](https://platform.kimi.com/docs/hosted-agents/quickstart). The test fixture records the retrieval date and source hash. No CLI/SDK public packages changed, so no changeset is required.
