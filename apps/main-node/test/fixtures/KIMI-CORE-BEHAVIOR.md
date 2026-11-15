# Official Kimi / canonical Core behavioral gate

Run from `apps/main-node`, using the existing lock-matched dependencies:

```sh
KIMI_OFFICIAL_EXECUTABLE=/path/to/@moonshot-ai/kimi-code/dist/main.mjs \
KIMI_BEHAVIOR_EVIDENCE=/path/to/existing/evidence-directory \
KIMI_BEHAVIOR_LABEL=unique-run-name \
node ../../node_modules/vitest/vitest.mjs run --config vitest.kimi-native.config.ts
```

The executable must be the complete official `@moonshot-ai/kimi-code` 2.6.0
package (the gate verifies its package name/version). No model service is used:
a localhost Messages fixture instructs the real process to invoke its discovered
`mcp__oma__approve` tool. The fixture does not require that name in the first
request's tools list or require a fixed total request count.

The real official MCP SDK stdio server calls authenticated production Core HTTP
routes. A fixture-owned dispatcher permits exactly one native permission grant,
rejecting additional grants/calls. It associates the original ACP call ID with
that explicitly serialized grant, never by argument equality or JSON-RPC ID.
Canonical runtime publication binds the receipt, external event admission and
Work input consumption resolve it, and the actual native process receives the
answer and continues to end_turn. The assertion also checks the model-facing
result's original tool_use_id, which Kimi prefixes with `0:` in ACP updates.

This is a single-invocation composition test, **not** the production Kimi Work
coordinator, concurrent grant mapping, a durable transport-restart implementation,
or full lifecycle acceptance. Pending state is in Core/SQLite; the fixture's open
MCP request is only delivery and does not prove crash-safe resume. The production
non-Pi lifecycle guard must stay until those integrations exist. No test changes
that guard or treats Kimi as protocol-incapable.
