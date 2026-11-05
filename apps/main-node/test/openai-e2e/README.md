# OpenAI Agents API E2E

This suite is maintained by OpenMA. It calls the production Node service through
the official `openai@7.15.0` SDK, using a fresh SQLite database and local blob
directories for each test. A local HTTP server supplies scripted model responses;
the Agents API transport, runtime, event history and persistence are real.

## Run

From the repository root, with Node 24 and the workspace dependencies installed:

```sh
pnpm run test:e2e:openai-agents
```

The command checks the tests against the pinned SDK types, then runs all process
scenarios in one Vitest invocation. The usual `pnpm test` also discovers these
tests through the main-node package. No cloud credentials or provider accounts
are required. The fixture passes only synthetic credentials to the spawned
service and always cleans up its own processes, sockets and temporary files.

Do not run separate process-test invocations concurrently: main-node's temporary
resource check scans the shared system temporary directory.

## Coverage

| File | What a regression would break |
| --- | --- |
| `../openai-agents-node.test.ts` | SDK requests reaching the Node mount, text execution without an environment, function result continuation and idempotency, all six child controls, isolated child history and default single-level delegation |
| `artifacts.test.ts` | Real subprocess file creation, nonempty SDK artifact list/retrieve/download, binary fidelity and restart; SIGKILL during partial publication recovers without rerunning the turn or duplicating files |
| `resources.test.ts` | Saved-agent snapshot isolation, pagination and deletion, vault and template persistence across process restart, secret redaction, rejection of unsupported execution settings without orphan sessions |
| `recovery.test.ts` | Pending function action and original turn survive a process restart; a later parent turn resumes the same persisted child and its history |
| `stream.test.ts` | SDK automatic function handling, coordinator completion despite earlier child completion, subscription abort versus explicit cancellation, live resubscription and durable history reads |

The pinned event stream is live-only. Reconnecting subscribes to new events;
clients read Items and Turns for history missed while disconnected. The suite
does not invent a replay cursor that the official SDK contract does not expose.

## Scope

Most tests use `environment: { type: "none" }`. The artifact tests use
`openai_hosted` with the trusted local-subprocess test adapter: bash writes real
files, while the production publisher, SQLite, disk blob store and official SDK
handle publication and downloads. A test-only read barrier pauses the second
artifact before the parent sends SIGKILL; recovery uses the real lease expiry
and the same persisted directories. The barrier does not simulate publication,
copy bytes, change SQL, or substitute a completed turn.

These tests do not certify OpenSandbox/Docker, MinIO, real-model instruction
following, hosted OpenAI execution, Console display, or recursive delegation.
Shared-sandbox behavior has separate runner tests in
`../managed-session-subagents.test.ts`.

For supported settings and remaining gaps, see
[compatibility status](../../../../docs/openai-agents-compatibility-status.md).
For protocol and mapping tests, run `pnpm run test:openai-agents`. When the SDK
changes, update the audit baseline and add relevant real-service scenarios here.
