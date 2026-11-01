# Exhausted: retain rows; advance with next round (owner decision)

Status: **locked decision** for OMA alignment with CMA exhausted semantics
(2026-11-01, America/Detroit; owner correction supersedes flush=delete).
Supplements Console PR #399 / issue #398.
Does **not** implement server-side delete flush or CMA workflow runs (#400).
There must be **no** delete-flush code path for exhausted.

Companion: [`cma-steer-coherent-turn.md`](./cma-steer-coherent-turn.md)
(mid-run `user.message` = steer into current turn; queue is mid-state only;
retry hold; interrupt is separate).

## Decision (do not reopen)

1. **On `retry_status: exhausted` / idle `stop_reason: retries_exhausted`:**
   do **not** delete unprocessed mid-turn history / queue rows
   (`processed_at` still null). Do **not** auto-run those unstamped
   mid-turn inputs as the next agent turn by themselves.
2. **Advance with the next round:** unstamped mid-turn inputs **remain**
   and **advance into context with the next round of events** (they ride
   along when the next turn / next admitted events are consumed). After
   exhausted settle, the user **cannot withdraw** them.
3. **Client may reconcile:** Console (and peers) keep local pending
   ids/text and may reconcile against `events.list` (or an equivalent
   post-exhausted history snapshot). Under this lock, still-present null
   `processed_at` rows are **expected**, not a flush/delete anomaly.
4. **Revoked:** prior “flush = delete unconsumed mid-turn inputs on
   exhausted” and any WIP delete-flush implementation. Also supersedes a
   pure “hold forever / never advance” reading for the exhausted case.

## Retry vs exhausted (do not conflate)

| Lifecycle | Unstamped mid-turn inputs |
|---|---|
| `retrying` / `session.status_rescheduled` | **Hold.** Do not flush/delete. Do not start a new agent turn from them. After resume, ingest together (steer into the continuing turn). |
| `retries_exhausted` / idle `retries_exhausted` | **Retain rows** (no delete). Do **not** auto-start a new turn from them alone. They **advance into context with the next round of events**. User cannot withdraw. Client may reconcile. |

Mid-run accept while the turn is healthy is **steer into the current turn**,
not “queue for the next agent turn.” See `cma-steer-coherent-turn.md`.

## Supersedes

| Prior reading | Status |
|---|---|
| **flush = delete** on exhausted (earlier #399 lock / this doc’s first revision) | **Revoked.** Do not delete history/queue rows. |
| **Pure hold** after exhausted (retain + never advance until an explicit resume of the same turn) | **Superseded for exhausted.** Rows remain, but they advance with the **next round of events**, not as a silent solo next turn. |
| Research memo `pending-seq-hold-design.md` (Codex-like retain + hold after exhausted) | Still not authority for OMA exhausted policy; use this doc. |

pi/Codex retain-in-process queues after failure remain a separate harness
comparison (`queued-after-failure-pi-codex.md`); they are not the OMA
server outbox policy for CMA-aligned sessions.

## Client reconcile algorithm

Pure helper: `reconcilePendingAfterExhaustedFlush` in
`apps/console/src/lib/session-exhausted-reconcile.ts`
(name kept for call-site stability; behavior matches **retain + reconcile**,
not delete-flush).

Given:

- `(a)` local set of accepted-but-unprocessed event ids (and optional
  optimistic composer text held only on the client), and
- `(b)` a post-exhausted `events.list` snapshot (or stream observation of
  idle `retries_exhausted`, then a list/history read),

do:

1. Detect exhausted settle via stream/list lifecycle
   (`session.error` with `retry_status.type === "exhausted"` and/or
   `session.status_idle` with `stop_reason.type === "retries_exhausted"`).
2. For each local pending id:
   - **Present with null/absent `processed_at`** → **expected retain**;
     keep locally (`retainedIds`). Will advance with the next round;
     not withdrawable by the user after exhausted.
   - **Present with stamped `processed_at`** → ingested; drop from pending
     (`processedIds`).
   - **Absent from list** → unexpected under no-delete; report as
     `vanishedIds` for client recovery UX (do **not** treat absence as
     intentional server delete-flush).
3. Optimistic composer text stays associated with retained ids until the
   next round consumes them or the caller clears intentionally.

GUI queue chrome continues to use OpenMA `delivery` / `turn.queued`
(`session-event-queue.ts`). That chrome is **client-side** product UX; the
server unstamped list is mid-state only, not the product queue. This
reconcile path may inspect CMA wire `processed_at` on a raw `events.list`
snapshot after exhausted. “Running + steered” temporary UX also comes from
`processed_at` (and optional steered frames); event display order is
otherwise unchanged.

## Out of scope here

- Any CF/Node **delete-flush** implementation — **cancelled / must not ship**.
- CMA **workflow runs** — tracked as issue **#400**; schedule/wakeup
  automation stays as today.
- Redesigning Console SessionDetail / outbox UI; this PR keeps the pure
  lib + tests so wiring can stay minimal.
- Full Node managed mid-run → steer injection (see coherent-turn doc
  follow-ups).

## Related

- [`cma-steer-coherent-turn.md`](./cma-steer-coherent-turn.md) — mid-run
  steer / coherent turn / retry hold / interrupt separation.
- Issue #398 / PR #399 — Console send-response outbox merge.
- Issue #400 — workflow runs (separate).
- Owner correction (2026-11-01): exhausted must **not** delete; advance
  with next round; user cannot withdraw.
