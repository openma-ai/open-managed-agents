# Shared CLI / desktop runtime kernel

The CLI and Backchat now pin `@openma/common` to
`85e0b3b6d46f3b8cd219aa2b5a79a1339b5041a0`. The former runtime modules are
compatibility exports, preserving consumer imports while removing duplicate
implementations. The package includes local ACP sessions, connection lifecycle,
owned shutdown, Managed Session control/event projection and Work lease handling.
OS signals, credentials, project directories and UI remain consumer adapters.

Live validation found three protocol/storage defects, now covered by regression
checks: Session HTTP ingress omitted Idempotency-Key; per-work credentials could
not ACK a reserved queued item; idempotency prefix lookup exceeded D1 LIKE limits.
Only the current unexpired reservation can ACK before Session access is allowed.
The follow-up removes prefix filtering entirely: deduplication selects complete
event IDs with SQL IN and retains the existing workspace/session scope.

Validation: runtime 42 tests; harness 120; CLI 19; managed runtime host 261;
managed adapters 65; OpenAI compatibility 73; input/claim regressions 18;
SQL event-store 2. Runtime, CLI, harness, host and changed adapter typechecks
passed. CLI builds. Common itself passes 352 tests and builds.

A real local Workers/D1 API, real Codex ACP process and Backchat Electron build
completed two turns in one Managed Session. The first was submitted over the API;
the second through the desktop composer. Server history and desktop history
agreed, including after quitting/relaunching the desktop, with one user event for
the second input. Desktop E2E is opt-in at e2e/openma-common-live.spec.ts in Backchat.

This used an explicitly configured local Work test host with local session
preparation, not the legacy daemon's automatic dispatch. The reverse-WebSocket
daemon still requires a Work polling/provisioning adapter. The separate sandbox
native-state adapter failed a Codex state-directory initialization probe and is
not qualified by the successful local-host run. Docker deployment and worker
restart recovery were not qualified in this increment.


## Exact event identity follow-up

No request entity, table or identity format is introduced. Retry lookup uses the
existing deterministic native event IDs, including the next complete ID to reject
shortened batch retries. Exact lookups are chunked to bound SQL parameters. Both
SQL and memory stores remove `idPrefix` in favor of `eventIds`; existing stored
identities and desktop reconciliation remain compatible.

Validation: 83 focused storage/input/OpenAI compatibility tests pass. Application
suite: 139 pass, one existing architecture-boundary check rejects the common
runtime import introduced by the previous extraction. Source-only application
and both store typechecks pass; the full application test typecheck also exposes
existing Work fixtures missing claim generation. No live Electron/Docker rerun
was performed for this follow-up.


## Review fixes

Input identity now exports from `@openma/common/protocol/managed`. The application
boundary permits that neutral protocol entry only; it does not permit the runtime
entry. The old runtime export remains a compatibility re-export. The architecture
check now passes, together with 146 application/storage tests. Common passes 353
tests and typecheck/build. The unrelated Work fixture type errors noted above are
not covered by these successful runtime tests.

Backchat follows the SDK's `next_page`, opens live observation before history
catch-up, and deduplicates the overlap by canonical event ID. Definite rejection
responses release the pending local operation for an explicit retry; ambiguous
network/server failures retain the no-resend behavior. No entity or schema added.

### Docker rerun (2026-09-16)

- Ran current Node API source in an isolated Docker container with SQLite and real authentication. The reused image runs Node 22.23.2; repository target is Node 24, so this is not a release-image certification.
- Found a second execution path: SQL bootstrap/input persistence unconditionally admitted Node execution outbox entries even for self-hosted environments. Persistence now resolves the environment before admission; self-hosted events remain canonical history consumed by Environment Work, without Node outbox entries. No schema or new entity was introduced.
- Regression reproduced two unexpected execution entries for a self-hosted bootstrap plus continuation. After the fix, all 6 composition tests and 85 SQL adapter tests pass. The session store, event store and SQL composition packages pass typecheck.
- An initial Codex ACP test was mistakenly launched and stopped. Its results are not DeepSeek acceptance evidence.
- DeepSeek's authenticated model catalog returned `deepseek-flash` and `deepseek-v4-pro`. A direct `deepseek-flash` request returned the expected marker. No claim is made that the alias identifies version 4.1.
- Real shared-kernel execution using installed DeepSeek ACP 0.4.6 was blocked before a model turn: common's session host requires the vendor `_session/steering` capability and disposed the agent when it did not advertise it. The subsequent `no such session` is a consequence of that rejection. Backchat continuation/restart validation was therefore not reached; full end-to-end acceptance remains failing.
