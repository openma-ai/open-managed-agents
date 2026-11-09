# Opt-in real-model OpenAI Agents acceptance

Run only against an isolated existing OpenMA deployment. Ordinary `pnpm test` never discovers `.live.ts`. The runner does not deploy, change provider settings, start a mock model, or inject a local sandbox. Calls are charged to the workspace model card.

```bash
OMA_LIVE_LLM=1 \
OMA_LIVE_BASE_URLS=http://127.0.0.1:18864,http://127.0.0.1:18862 \
OMA_API_KEY=<workspace-key> \
OMA_LIVE_MODEL=<existing-model-card-handle> \
OMA_LIVE_WIRE_MODEL=MiniMax-M3.1-Flash \
OMA_LIVE_DEPLOYED_HEAD=<actual-server-sha> \
OMA_LIVE_EVIDENCE_DIR="$PWD/.validation/openai-live-$(date +%s)" \
pnpm --filter @open-managed-agents/main-node test:live:openai
pnpm --filter @open-managed-agents/main-node typecheck:live
```

Credentials come from environment, never source. Configure endpoint/provider/key through the normal workspace model-card API/bootstrap; the runner reads back model/provider/endpoint and checks the wire model. This iteration uses minimax-cn / MiniMax-M3.1-Flash / https://api.minimaxi.com/anthropic. The control-plane target is independent of that card; sandbox selection belongs to the deployment and optional environment template, not this runner.

Optional `OMA_LIVE_ENVIRONMENT_TEMPLATE_ID` selects the hosted sandbox environment independently of the model card. Optional `OMA_LIVE_RESTART_SCRIPT` is an operator-owned Bash script that restarts only the isolated target processes and waits for readiness. It runs during function requires_action, with unchanged Items/Turns/actions asserted afterward; unset means explicit NOT_RUN. This is an idle RA restart, not an in-flight SIGKILL certification. Never point it at shared or production services.

Optional `OMA_LIVE_TIMEOUT_MS` defaults to 180000 and is bounded to 1000–600000. Scenarios run serially, SDK retries are disabled, and waits inspect durable state with deadlines. Use a new evidence directory per run. Evidence retains HEAD/diff/source hash, operator-supplied deployed SHA (not remote attestation), model-card readback, HTTP, SSE, paginated Items/Turns, PASS/FAIL and cleanup. Do not publish evidence without checking for sensitive user input. Only owned sessions are deleted; this is not account-wide zero-orphan certification.

## Scenarios

- A real-model function call enters requires_action. Peer deferred steer leaves actions unchanged until settlement. Result and steer remain on original Turn. Duplicate result request cannot duplicate output. Settlement invariants are shared with deterministic recovery E2E.
- Missing SSE history is recovered using full SDK pagination (Items page 2, Turns page 1), then a new live subscription receives only a new Turn with unique event IDs. No invented Last-Event-ID replay.
- Real hosted sandbox command creates binary output. Peer artifact metadata/content must match 00fffe0d0a41, and durable command_execution is required, not model self-report.

- Real subagent creates, waits for and closes exactly one child; durable tool calls and separate child/root assistant replies are asserted through paginated histories.

Not yet certified by this entry: in-flight SIGKILL, deterministic retry/exhaustion/partial transport faults, approval/MCP, token rotation, CF unattended timing. Existing openai-e2e recovery/artifacts/stream tests remain the controlled fault baseline. A model prompt cannot force a transport failure: that needs a separately identified real-upstream proxy/barrier. Mock/fault evidence never substitutes for live evidence. Unconfigured platform/provider combinations are NOT_RUN, not full permutation coverage.
