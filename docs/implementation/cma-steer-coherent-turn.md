# CMA mid-run `user.message` = steer into current turn (owner locks)

Status: **locked decision** for OMA alignment with Claude Managed Agents
mid-turn input semantics (2026-10-31, America/Detroit). Supplements
Console PR #399 / issue #398. Cross-links
[`exhausted-flush-client-reconcile.md`](./exhausted-flush-client-reconcile.md)
(flush = delete only on exhausted; client reconcile).

Does **not** reopen prior “next-agent-turn outbox” OMA reads. Those were
wrong for CMA-aligned sessions.

## Decision (do not reopen)

1. **One mid-run semantics:** a `user.message` accepted while the agent
   turn is running **steers into the current turn**. It is consumed at the
   next model / LLM step boundary; `processed_at` stays null until that
   consume, then is stamped. Skills *Steering Patterns* / *Message
   queuing*: multiple mid-turn sends may form one **coherent turn**.
   This is **not** “wait for the next agent turn outbox.”
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
5. **Flush only on exhausted:** on `retry_status: exhausted` / idle
   `stop_reason: retries_exhausted`, drop unconsumed mid-turn inputs
   (scheduler flush = delete). Client may re-send. See
   `exhausted-flush-client-reconcile.md`.
6. **Client UX:** “running + steered” is a temporary reconcile view from
   `processed_at` (and optional `system.user_message_steered`); event
   display order is otherwise unchanged. Design survey + recommended
   chrome: [`steered-gui.md`](./steered-gui.md) (Codex TUI bands,
   Backchat/QueueDock gaps, third-party AG-UI / DeepSeek / pi notes).
   openma-common projects `steered: true` but shared chat-ui chrome for
   it is still TBD.
7. **OpenAI Agents path:** mid-turn → steer; idle → new turn. Do not
   invent a CMA-style durable pending inbox for OpenAI Agents.

## Server implications (OMA)

| Phase | Unstamped mid-turn `user.message` |
|---|---|
| Running (ordinary) | Hold as mid-state; **steer** into current turn at next LLM boundary; stamp on consume |
| `retrying` / `status_rescheduled` | Hold; **no** flush; **no** new turn from these rows; after resume, ingest together into the continuing turn |
| Idle after interrupt | Following message = **new** turn (interrupt path) |
| Idle `retries_exhausted` | **Flush = delete** unconsumed mid-turn inputs; client may re-send |

Explicit `POST .../pending/:event_id/steer` remains an OMA/Backchat
control for clients that promote early; for agents that advertise
steering, **ordinary** mid-run accept already means steer (absorb every
queued `user.message` on the lane at the next `takeSteeringInputs`
poll), not “only when the user presses Steer.”

## Wrong read (superseded)

Earlier OMA wording that treated mid-run sends as “queued for the next
agent turn / next drain after idle” for CMA-aligned sessions is
**superseded**. Drain-after-idle remains the fallback when an agent does
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
- openma-common / Console / Backchat steered display parity — see
  [`steered-gui.md`](./steered-gui.md) (follow Codex TUI dock bands +
  DeepSeek `SteeringMessageNode`; do not invent Claude Console chrome).
- Server delete-flush implementation on exhausted where hosts still only
  document it (#399 ships client reconcile helper).
