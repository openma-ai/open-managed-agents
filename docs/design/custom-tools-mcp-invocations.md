# Core custom-tool MCP invocation boundary (implementation in progress)

The Core application owns tool definitions, validates inputs, allocates an opaque
receipt and persists the invocation. MCP is discovery/call transport. Neither a
JSON-RPC request ID nor argument equality identifies a model call. In particular,
two calls with identical arguments receive different receipts.

`CoreCustomToolMcp` exposes application handlers for an official MCP SDK server.
Its call result is a **pending receipt**, not an external tool answer. The host
must recover that receipt from the native result, bind it to the native call ID
under the current Work claim, and publish the corresponding canonical custom
call. Only that bound canonical call is actionable by an external client.
Unbound records must not be presented as external work. Losing a transport
response may create an additional unbound record on retry; it must not create a
second actionable call or execute an external effect.

`CustomToolInvocations` supports unbound -> pending -> resolved/cancelled. Binding
is one-to-one within a canonical Session turn. Answers are immutable, matched by
receipt AND native call ID, and accepted only after the existing canonical input
admission path. Transport disconnects do not cancel invocations. A canonical
cancel is terminal; late answers cannot reopen it. No operation here starts,
leases, retries or recycles a sandbox.

`SqlCustomToolInvocations` currently implements SQLite/D1 statement-time Work
fencing and revision CAS. Its schema is exported for explicit installation; it
is not auto-created on a request. The generation/holder/lease/session/environment
checks run inside each database statement. A successor can recover records from
the same canonical turn; an old holder cannot modify or read them. PostgreSQL
and MySQL implementations and installation migrations are still outstanding.

The optional `createWorkOutputAdapter.customInvocation` hook prepares a reference
without binding. The existing Work event batch carries `customInvocations` pairs
(receipt, nativeCallId) alongside canonical custom events. The production ingress
passes them to the existing projection transaction. That transaction verifies
stored definition/input, receipt CAS, consumed root, Session revision and current
Work authority, then commits binding and events together. Failure of either rolls
back both. No separate public event log is introduced.
The native result envelope is decoded without recursively searching arbitrary
text, and every claimed receipt must exist in the scoped Core store.

## Authenticated endpoint; not yet advertised to harnesses

Node/SQLite and CF/D1 register `/v1/oma/sessions/:sessionId/custom-tools/:turnId/mcp`
through the official SDK's stateless Streamable HTTP transport. Only current
all-scope Work sandbox tokens authorize it. The server resolves pinned tool
schemas and a consumed canonical root; writes recheck claim and captured Session
revision. Transport IDs and equal arguments never identify native calls. SQLite
and D1 migrations install receipt storage. Other SQL dialects fail explicitly
until their authority implementation and migrations are verified.

The native output binding hook and sampling barrier are **not** wired. Receipts
are not tool answers. The endpoint is not added to any harness's MCP roster;
Pi's existing registration remains enabled. Before switching any
harness, implement and verify all of these together:

- Complete host/harness composition using the authenticated endpoint and current
  canonical turn proof; endpoint tests alone do not prove native lifecycle.
- End-to-end host/harness publication and external-input admission. Local
  SQLite/D1 gates now prove atomic binding/publication and canonical answer
  consumption: the existing input transaction resolves the receipt identified
  by the canonical call's internal source metadata. A later input turn resolves
  the original invocation turn. A failed final CAS rolls back the answer stamp
  and receipt resolution. Duplicate answers cannot overwrite it. This does not
  yet prove API-to-official-harness resume or native pending behavior.
- A native sampling barrier: a receipt must never be treated as an answer or
  allow another model request while any custom answer is missing. An open HTTP
  request and transport cancellation are not durable parking/recovery.
- Recovery of native history from canonical answers after host/harness restart,
  including mixed ordinary tools, identical arguments and no side-effect replay.
- Each actual catalogue harness with its official distribution. A component
  test using the real MCP SDK is not an official harness lifecycle pass.

Local gates are in managed-agents-adapters-sql/test/custom-tool-*.test.ts.
They cover the real SQLite/D1 implementation, official MCP SDK stdio subprocess,
Core process SIGKILL/restart, authority loss and the actual ACP projector. The
SDK/tsx test fixtures resolve already lock-installed transitive packages; they
perform no runtime install and use no provider credentials or paid inference.

## Official Pi native sampling gate (not a production switch)

`piMcpPendingBarrierFiles` supplies a sampling-only Pi extension. It registers no
custom tools: discovery and calls use the official native MCP implementation.
It aborts sampling after the current tool batch and hydrates original native
call results only from canonical answers before a resumed request. Missing or
partial answers fail closed. This does not make an opaque receipt an answer.

The projector uses display titles, so receipt interception must first observe
ACP's native `name` keyed by `toolCallId` using `work-output-adapter.nativeTool`.
Only configured Core MCP names may be intercepted; ordinary output containing
a receipt-shaped JSON value remains ordinary output. Changing a native name
for an already observed call is rejected. Neither arguments nor JSON-RPC IDs
establish this association.

Run the explicit native gate with an already installed official distribution:

```sh
OMA_PI_ACP_ENTRY=/absolute/path/to/@openma/pi-acp/dist/bin.js \
node node_modules/vitest/vitest.mjs run \
  --root packages/managed-agents-adapters-sql --config vitest.native.config.ts
```

The test requires official `@openma/pi-acp@0.1.8`, performs no install, and uses
local deterministic Messages inference plus a real MCP SDK child and SQLite.
`OMA_BARRIER_DISABLED=1` is the negative control: the unanswered receipt reaches
the next model request. Normal unit runs exclude this explicit distribution gate;
absence of its required path fails the gate rather than skipping it.

Verified scope: custom-first/last/multiple, two identical argument calls, ordinary
side-effect count, empty/partial-answer restart, later-input MCP scope, canonical
SQL answer consumption, error answers, legal native model history and one normal
native completion. The driver publishes captured ACP events through the real
projector/Work ingress and projection transaction; it does not run the complete
production Work coordinator. Full host restart/finalization, authenticated HTTP
native composition, cancellation/replay and other harnesses remain open. Do not
remove the existing Pi registration based on this native gate alone.
