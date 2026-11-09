# CMA mid-run `user.message` = steer into current turn (owner locks)

Status: **locked decision** for OMA alignment with Claude Managed Agents
mid-turn input semantics (2026-10-31, America/Detroit). Supplements
Console PR #399 / issue #398. Cross-links
[`exhausted-flush-client-reconcile.md`](./exhausted-flush-client-reconcile.md)
(on exhausted: retain rows, do not delete; advance with next round;
client may reconcile; user cannot withdraw).

Does **not** reopen prior “next-agent-turn outbox” OMA reads. Those were
wrong for CMA-aligned sessions.

## Decision (do not reopen)

1. **One mid-run semantics:** a `user.message` accepted while the agent
   turn is running **steers into the current turn**. It is consumed at the
   next model / LLM / tool-call boundary (**after-call**, not after the
   whole agent turn settles); `processed_at` stays null until that
   consume, then is stamped. Skills *Steering Patterns* / *Message
   queuing*: multiple mid-turn sends may form one **coherent turn**.
   This is **not** “wait for the next agent turn outbox” and **not** an
   explicit `POST .../pending/:id/steer` second path (that OMA extension
   is removed).
2. **Queue is only mid-state.** The server unstamped list
   (`processed_at` null until consumed) is admission / mid-state, not the
   product GUI queue. Business-semantic queue chrome (Backchat / Console
   outbox UI) is **client-side**.
3. **`user.interrupt` is separate.** Interrupt jumps the queue → session
   goes idle → a following `user.message` starts the **next** turn. Inputs
   queued before the interrupt are **not** cancelled: they run as the lane's
   next turns (CF and Node). Do not conflate interrupt with steer.
3b. **`requires_action` / `budget_reached` settle-only (owner t307u):** while
   idle with `stop_reason: requires_action` (outstanding `event_ids`) or
   `budget_reached`, only settle events are accepted
   (`user.tool_confirmation`, `user.tool_result`, `user.custom_tool_result`,
   `user.interrupt`). A `user.message` is **400** `invalid_request_error`
   (official CMA). Not deferred/queued. `budget_reached` is typed; gate
   applies whenever that idle stop exists (gate applies whenever that idle stop is present; emitter may still be incomplete).
4. **Retry hold (not flush):** while `retry_status: retrying` /
   `session.status_rescheduled`, do **not** flush unstamped mid-turn
   inputs, and do **not** start a new agent turn from them. Leave them
   unstamped until the next consume boundary after resume, then ingest
   together (steer into the continuing turn).
5. **Exhausted retain + next-round advance (no delete):** on
   `retry_status: exhausted` / idle `stop_reason: retries_exhausted`, do
   **not** delete unprocessed mid-turn history/queue rows, and do **not**
   auto-run those unstamped inputs as the next turn alone. They **remain**
   and **advance into context with the next round of events**. The user
   **cannot withdraw** them. Client may reconcile. See
   `exhausted-flush-client-reconcile.md`. Prior flush=delete is revoked.
   **Wire (CF + Node):** emit `session.error{retry_status:exhausted}` then
   `session.status_idle{stop_reason:retries_exhausted}` — never a trailing
   `status_rescheduled` + `end_turn` + string error on the exhausted path.
   Retrying path emits `session.error{retrying}` before `status_rescheduled`.
   **Deliberate divergence stays:** official SDK says queued inputs are
   flushed; OMA retain/hold/`held_after_exhausted` (owner lock).
6. **Client UX (owner t276u):** after mid-run steer, the client is left
   with only a temporary **running + steered** reconcile state — meaning
   the latest accepted events were already consumed, judged from
   `processed_at` (and optional `system.user_message_steered`). **Event
   display order does not change.** **No special steered status chrome**
   (owner cancel) — see [`steered-gui.md`](./steered-gui.md). Ordinary
   queue dock + ordinary user bubbles after stamp.
7. **OpenAI Agents path:** mid-turn → steer; idle → new turn. Do not
   invent a CMA-style durable pending inbox for OpenAI Agents.

## Server implications (OMA)

| Phase | Unstamped mid-turn `user.message` |
|---|---|
| Running (ordinary) | Hold as mid-state; **steer** into current turn at next LLM/tool-call boundary (after-call); stamp on consume |
| `retrying` / `status_rescheduled` | Hold; **no** flush; **no** new turn from these rows; after resume, ingest together into the continuing turn |
| Idle after interrupt | Queued and following messages = **new** turns, in order (nothing is cancelled) |
| Idle `retries_exhausted` | **Retain** unconsumed mid-turn inputs (no delete); do not auto-start them as the next turn alone; they **advance with the next round of events**; user cannot withdraw; client may reconcile |
| Idle `requires_action` / `budget_reached` | **Settle-only (t307u):** `user.message` → **400**; only tool_confirmation / tool_result / custom_tool_result / interrupt |

**No explicit Steer extension.** There is no `POST .../pending/:event_id/steer`
and no Console/Backchat “Steer” promote control. For agents that advertise
steering, **ordinary** mid-run accept **is** steer: absorb every queued
`user.message` on the lane at the next `takeSteeringInputs` poll (after-call
LLM/tool boundary), not after the whole turn settles, and not “only when the
user presses Steer.”

## Node parity (same single semantics as CF)

Node mirrors CF `SessionDO.takeSteeringInputs` via shared code that depends
only on `SessionExecutionStorePort` (ADR 0006):

- `takeQueuedSteeringInputs(store, { workspaceId, sessionId, laneId, … })`
  (`packages/session-runtime-contract/src/coordination.ts`) lists the lane's
  queued executions (`listQueued`) and CAS-steers each plain mid-run
  `user.message` batch (`steerQueued` → `completed`, so it never runs as its
  own next turn). Tool confirmations / interrupts are never steered.
- `NodeSessionExecutionWorker` hands that as a per-run hook
  (`takeSteeringInputs`); `DefaultNodeManagedSessionRuntimeDriver` wraps it
  to stamp `processed_at` (+ seq / re-emit) at consume, and only once the
  harness is running — never during startup `retrying` / `status_rescheduled`
  (hold). The runner wires it onto `ManagedNodeHarnessRuntime`, which appends
  the steered events to the turn's history; the pi loop (shared with CF)
  `agent.steer(...)`s them at the next LLM/tool-call boundary. Harness
  retries (`retrying` + `status_rescheduled`) also take nothing during
  backoff; the resumed attempt ingests together.
- Legacy `/v1/oma` harness path (`NodeSessionRouter`) passes
  `takeSteeringInputs` into `SessionStateMachine.runHarnessTurn`; the old
  `steerRequested` / `takeSteeredEventIds` marker is gone.
- `retries_exhausted`: unconsumed queued rows are **not** deleted (failed
  settle leaves them `queued`).
- Drain-after-idle remains only when the harness never polls
  `takeSteeringInputs` (no steering advertised): the queued execution runs
  next after settle.
- **Exhausted hold (shared store):** `settle({ holdQueuedOnLane: true })`
  marks remaining `queued` rows on the lane (`heldAfterExhaustedAt`). Claim
  skips held rows (they never auto-run alone). When a later unheld admission
  exists, claim absorbs held events into that admission in enqueue order and
  completes the held rows. `cancelQueued` rejects held rows
  (`held_after_exhausted`). Events.list surfaces `held_after_exhausted: true`
  on still-null `processed_at` documents (patched at hold). Same store path
  for CF `SessionExecutionHost` / SessionDO.


## Settle-only window (official CMA — owner lock 2026-11-01)

While the session is **idle** with `stop_reason: requires_action` or
`budget_reached`, **only settle events** are accepted:

- `user.tool_confirmation`
- `user.tool_result`
- `user.custom_tool_result`
- `user.interrupt`

A `user.message` in that window is **HTTP 400** `invalid_request_error`
(not 202-queued / deferred). Enforced in:

- CF `SessionDO` `POST /event`
- Node `planRequiresActionQueue` / managed accept (rejects, no defer)
- Managed `SessionEventsApplicationService.sendSessionEvents`
- Legacy Node `SessionRouter.appendEvent` (propagated by HTTP `POST /events`)

**`budget_reached`:** typed in the domain stop_reason union. The settle-only
**gate is enforced** whenever that idle stop is present (CF / Node / application).
Emitter may still be incomplete — remaining gap is advertising budgets on the
wire, not the 400 gate.

## CF exhausted / terminal wire (aligned 2026-11-01)

- Retry: emit `session.error{retry_status:retrying}` **then**
  `session.status_rescheduled` (hold mid-run inputs).
- Exhausted: emit `session.error{retry_status:exhausted}` then idle
  `stop_reason:retries_exhausted`. **No** `status_rescheduled` on the final
  failure. Keep owner-locked `holdQueuedOnLane` retain + next-round advance
  (deliberate divergence from SDK "queued inputs are flushed").
- Fatal / non-retryable: emit `session.error{retry_status:terminal}` and
  transition the session to **`terminated`** (official meaning of terminal).
- `custom_tool_result`: stamp `processed_at` **on receipt** (same as official
  `tool_result`), not null-then-stamp-at-drain.
- Interrupt on an already-idle session is a **no-op** (does not overwrite
  `retries_exhausted` with a fresh idle `end_turn`). Interrupt remains a
  settle event under `requires_action`.

## Wrong read (superseded)

Earlier OMA wording that treated mid-run sends as “queued for the next
agent turn / next drain after idle / after-turn settle” for CMA-aligned
sessions is **superseded**. Absorb is **after-call** (next LLM/tool-call
boundary). Drain-after-idle remains the fallback when an agent does
**not** advertise steering (`takeSteeringInputs` unwired); that is a
capability gap, not the CMA contract.

## Related evidence (optional)

- Local research note: `/workspace/oma-398-cf-evidence/cma-openai-flush-atomicity.md`
  (box evidence tree; not required in-repo).
- CMA skills: Message queuing / Steering Patterns; SDK exhausted one-liner
  (“queued inputs are flushed”).
- Issue #398 / PR #399 — Console send-response outbox merge + these locks.
- Issue #400 — workflow runs (separate).

## Follow-ups (not this PR)

- ~~Full Node managed-path wiring~~ — **done** (see *Node parity* above).
- ~~openma-common / Console / Backchat steered display parity~~ —
  **cancelled** (no `pending_steer` bands / steered caption). Survey
  kept in [`steered-gui.md`](./steered-gui.md).
- ~~Server delete-flush on exhausted~~ — **cancelled / must not ship**.
  #399 ships client reconcile helper under retain + next-round advance.


## Exhausted hold (store)

On `retries_exhausted`, the execution host / Node worker settles with
`holdQueuedOnLane: true`. SQL `SessionExecutionStorePort` sets
`held_after_exhausted_ms` on remaining `queued` rows for that lane and
patches event documents with `heldAfterExhausted` (wire:
`held_after_exhausted`) so `events.list` shows the hold without a separate
pending endpoint.

- Claim never selects held rows alone.
- When any unheld queued admission exists on the lane, claim absorbs held
  events into that admission (enqueue order), completes the held rows, and
  clears the hold marker on documents.
- `cancelQueued` rejects held rows (`held_after_exhausted`); user cannot
  withdraw them.
- Retrying / ordinary failure does **not** set the hold (unchanged).
- CF SessionDO returns `{ holdQueuedOnLane: true }` from `runAcceptedTurn`
  into the shared `SessionExecutionHost` settle path (same port semantics),
  for every exhausted turn, including one resumed by tool answers.
