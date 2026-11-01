# Exhausted flush = delete; client reconcile (owner decision)

Status: **locked decision** for OMA alignment with CMA exhausted semantics
(2026-10-31, America/Detroit). Supplements Console PR #399 / issue #398.
Does **not** implement server-side delete flush or CMA workflow runs (#400).

## Decision (do not reopen)

1. **Server / CMA alignment:** on `retry_status: exhausted` / idle
   `stop_reason: retries_exhausted`, **flush = delete** unprocessed queued
   inputs (rows still `processed_at=null` that were never ingested). Do
   **not** retain a server-side hold queue.
2. **Recoverable UX is client-only:** Console (and peers) keep local pending
   ids/text; after exhausted, reconcile against `events.list` (or an
   equivalent post-exhausted history snapshot). Ids that vanished were
   flushed; the client may re-`send` to recover. The server does **not**
   keep `processed_at=null` hold markers for this case.
3. **Evidence bar:** official docs never proved delete vs stamp. This is an
   **owner assumption aligned with the CMA type comment** on
   `BetaManagedAgentsRetryStatusExhausted` ("queued inputs are flushed"),
   not a live-probed hosted fact.

## Supersedes server-hold memo

Earlier research memo `pending-seq-hold-design.md` (Codex-like **retain +
hold** after exhausted, with an explicit hold/block marker) is
**superseded for the exhausted case**. OMA does not ship a server-side
hold queue for `retries_exhausted`. Other memo sections (admission vs
ingest, seq-at-ingest, workflow runs = #400) may still inform later work;
do not cite that memo as authority for exhausted retention.

Contrast:

| Path | After exhausted |
|---|---|
| **Superseded (hold)** | Keep admitted rows; mark held; no auto-claim until resume |
| **Locked (this doc)** | Delete never-ingested queued inputs; client reconciles + may re-send |

pi/Codex retain-in-process queues after failure remain a separate harness
comparison (`queued-after-failure-pi-codex.md`); they are not the OMA
server outbox policy for CMA-aligned sessions.

## Client reconcile algorithm

Pure helper: `reconcilePendingAfterExhaustedFlush` in
`apps/console/src/lib/session-exhausted-reconcile.ts`.

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
   - **Absent from list** → treat as flushed/deleted; drop from local
     pending; surface in `flushedIds` (client may re-send that text).
   - **Present with null/absent `processed_at`** → **anomaly** under the
     delete-flush assumption; **keep** locally (`anomalyRetainedIds`) and
     do not pretend the server held it on purpose.
   - **Present with stamped `processed_at`** → ingested; drop from pending
     (`processedIds`); not a flush.
3. Optimistic composer text is cleared only when the caller associates it
   with flushed (or fully reconciled) sends; the helper reports id fate
   and does not invent server hold state.

GUI queue chrome continues to use OpenMA `delivery` / `turn.queued`
(`session-event-queue.ts`). This reconcile path is the intentional
exception that inspects CMA wire `processed_at` on a raw `events.list`
snapshot after exhausted.

## Out of scope here

- Full CF/Node server delete-flush implementation (follow-up when hosts
  align; fix lying comments only if trivial).
- CMA **workflow runs** — tracked as issue **#400**; schedule/wakeup
  automation stays as today.
- Redesigning Console SessionDetail / outbox UI; this PR adds the pure
  lib + tests so wiring can stay minimal.

## Related

- Issue #398 / PR #399 — Console send-response outbox merge.
- Issue #400 — workflow runs (separate).
- CMA SDK comment on `BetaManagedAgentsRetryStatusExhausted`.
