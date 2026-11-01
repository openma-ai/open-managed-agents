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
   goes idle → a following `user.message` starts the **next** turn. Do
   not conflate interrupt with steer.
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
| Idle after interrupt | Following message = **new** turn (interrupt path) |
| Idle `retries_exhausted` | **Retain** unconsumed mid-turn inputs (no delete); do not auto-start them as the next turn alone; they **advance with the next round of events**; user cannot withdraw; client may reconcile |

**No explicit Steer extension.** There is no `POST .../pending/:event_id/steer`
and no Console/Backchat “Steer” promote control. For agents that advertise
steering, **ordinary** mid-run accept **is** steer: absorb every queued
`user.message` on the lane at the next `takeSteeringInputs` poll (after-call
LLM/tool boundary), not after the whole turn settles, and not “only when the
user presses Steer.”

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

- Full Node managed-path wiring so mid-run admit injects into the running
  harness LLM boundary (today CF `takeSteeringInputs` + advertised
  steering is the primary coherent-turn path; Node still leans on
  execution-outbox drain-after-settle for some hosts).
- ~~openma-common / Console / Backchat steered display parity~~ —
  **cancelled** (no `pending_steer` bands / steered caption). Survey
  kept in [`steered-gui.md`](./steered-gui.md).
- ~~Server delete-flush on exhausted~~ — **cancelled / must not ship**.
  #399 ships client reconcile helper under retain + next-round advance.
