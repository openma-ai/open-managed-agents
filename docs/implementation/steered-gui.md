# Mid-turn steered state — GUI design note

Status: **design note** for Console / Backchat / `@openma/common` chat-ui
(2026-10-31, America/Detroit). Supplements
[`cma-steer-coherent-turn.md`](./cma-steer-coherent-turn.md) and Console
PR #399 / issue #398. **Not** a full UI implementation in this PR.

## Product rule (locked)

When the session is **running** and one or more accepted mid-turn
`user.message` events have been **steered** into the current turn
(`processed_at` stamped / OpenMA `delivery: "processed"` +
`turn.steered` / `system.user_message_steered`):

1. The **client** shows a **special mid-turn steered UI** (distinct from
   idle queue chrome and from ordinary idle→new-turn user bubbles).
2. **Event display order is unchanged** — do not reshuffle the timeline
   for chrome; steered rows stay in causal / `seq` order inside the
   active turn.
3. The **business-semantic queue** (edit / remove / reorder / explicit
   Steer) stays **client-side**. The server unstamped list is admission
   mid-state only, not the product queue.
4. Retry / exhausted semantics stay as locked in the coherent-turn doc:
   `retrying` / `status_rescheduled` → hold, no flush, no new turn;
   **only** `retries_exhausted` flushes (delete); unstamped inputs wait
   for the next consume boundary.

## What first-party clients have today

### Console (`apps/console`)

- Optimistic outbox + `QueueDock` (`@openma/common/chat-ui`) above the
  composer: edit / remove / **Steer** (`POST .../pending/:id/steer`) when
  `oma.session.steering=enabled` and status is `running`
  (`SessionDetail.tsx` queue dock + `steerQueued`).
- Queue detection is OpenMA-facing (`turn.queued` / `delivery: "queued"`),
  not raw CMA `processed_at` (`session-event-queue.ts`).
- Transcript: queued rows get muted “Queued…” treatment; once consumed,
  they become ordinary user bubbles. **No dedicated “steered mid-turn”
  chrome** after stamp / `turn.steered`.

### Backchat

- `ComposerProgress` + queued prompt rows with Steer / edit / remove /
  reorder (`src/renderer/src/components/chat/ComposerProgress.tsx`).
  Steer is rendered only when the host supplies `queueCallbacks.steer`.
- Host ACP / OpenMA paths already distinguish steering vs follow-up at
  the protocol layer; the shared progress chrome does **not** yet show a
  post-steer “in this turn” badge separate from the FIFO queue list.

### `@openma/common` (0.13.1-dev surveyed on box)

| Piece | Exists | Missing for steered GUI |
|---|---|---|
| `QueueDock` (`chat-ui/queue-dock`) | FIFO queued prompts; optional Steer = “Send now”; blocked-on-tool header | No “already steered / awaiting next LLM boundary” section |
| `projectCanonicalChat` (`session-events/managed`) | On `turn.steered` while busy, folds the user text into the **active** turn as `{ kind: "message", steered: true }` and drops it from `queued` | Consumers do not style `steered: true` specially |
| `turn.steered` / `delivery` | Wire + projection | No chat-ui primitive for “steered strip” / history badge |
| ComposerProgress | Lives in Backchat, not yet shared as the single Console+Backchat component | Steered parity with Codex TUI still TBD |

**Conclusion:** openma-common can *project* steered mid-turn messages;
neither QueueDock nor Console/Backchat chrome yet *presents* them as a
first-class mid-turn state. Prefer extending shared chat-ui over
forking Console-only widgets.

## Codex TUI patterns (cite, don’t invent)

Checkout surveyed: `/workspace/factcheck-src/codex` (`codex-rs/tui`).

### Bottom pane: three bands above the composer

`PendingInputPreview`
(`codex-rs/tui/src/bottom_pane/pending_input_preview.rs`) documents and
renders:

> “Widget that displays pending steers plus follow-up inputs held while a
> turn is in progress. … pending steers first, then rejected steers that
> will be resubmitted at end of turn, then ordinary queued user
> messages.”

Visible copy (from the widget + snapshot
`…pending_input_preview__tests__render_pending_steers_above_queued_messages.snap`):

- **Pending steers:** `• Messages to be submitted after next tool call`
  `(press esc to interrupt and send immediately)` with `↳` previews
  (dim).
- **Rejected steers:** `• Messages to be submitted at end of turn`.
- **Follow-ups:** `• Queued follow-up inputs` (dim + italic) + edit hint
  (`⇧← edit last queued message`).

State lives in `chatwidget/input_queue.rs` /
`chatwidget/user_messages.rs` (`pending_steers`,
`rejected_steers_queue`, `queued_user_messages`). Steers are **not** the
same list as next-turn follow-ups.

### Transcript: steers commit as normal user prompts; identity matched

When the server acknowledges a steer, TUI pops the matching
`PendingSteer` and calls `on_user_message_display` so the local text
(with attachments) lands in history
(`chatwidget.rs` pending-steer receipt path ~1348–1370). Display order
stays the history append order; backtrack refuses to edit a mid-turn
steer independently (`app_backtrack.rs`: “the selected prompt is a steer
and cannot be edited independently”). Interrupt path can surface
`• Model interrupted to submit steer instructions.`
(`…interrupted_turn_pending_steers_message.snap`).

### Takeaways for OpenMA

1. Split **pending-steer** vs **queued follow-up** in the dock (Codex’s
   three-band model), even if OMA’s server list is one mid-state table.
2. After steer is accepted / `processed_at` stamped, **leave the dock**
   and show the text **inside the running turn** (Codex history append;
   openma-common already sets `steered: true`).
3. Keep interrupt as a separate “send steers now” affordance; do not
   conflate with queue edit.
4. Do not invent Codex-specific badges we did not find (no separate
   “STEERED” glyph in the surveyed history cell — the distinction is
   **dock section** + **backtrack policy**).

## Third-party / ecosystem survey (paths cited; no invention)

| Source | What they show for queue / steer | Path / note |
|---|---|---|
| **pi / pi-acp** (OpenMA ACP adapter) | Protocol + TUI: steering vs follow-up queues; interactive status lines `Steering: …` and `↳ … to edit all queued messages`; Alt+Enter = follow-up; mid-run `prompt({ streamingBehavior: "steer" })` | `@earendil-works/pi-coding-agent` interactive-mode (~3840–3890); `/workspace/ro/pi-acp` `_session/steering` |
| **DeepSeek Harness** (OpenMA-adjacent client) | Busy Enter/Send mode **queue vs steer** (“插话发送”); QueueDock for next-turn inbox; steered admits become `SteeringMessageNode` (`kind: 'steering'`) in the flow, separate from ordinary user messages | `packages/client/ui-conversation` `SteeringMessageNode` in `contract/records.ts`; locales `queue.steer` / `input.send.steer` |
| **abacusai/abacusai-bot** (AG-UI host) | Host queue entries steered on arrival; AG-UI maps `user_message_steered` → `CUSTOM queue.steered` + **user** `TEXT_MESSAGE_*` with `messageId` `steer-<n>`, then `queue.updated`. Composer must not `sendMessage` while busy — enqueue instead | `packages/agent/src/agui/emit.ts` (`user_message_steered` case); `docs/rewrite/specs/00-agent-agui.md` § queue.* |
| **WakeUp-Jin/actspace-agent** | Client queue + durable steer inbox; UI “↳ 插入”; warns **not** to infer “read” from `user_message_steered` alone — use server `cancelSteer` → `cancelled \| claimed \| discarded \| missing` | `docs/learnings/2026-09/client-queue-server-inbox-handoff.md` |
| **moatai-io/towersource** | Treats `user_message_steered` / `user_message_queued` as “turn was not started as an independent root” for voice dispatch (protocol awareness, not a rich chat chrome cite) | `tower-session-turn-gateway.ts` |
| **Claude Console (platform.claude.com)** | Public docs cover send / queue / interrupt / exhausted flush; **no** public session-viewer steered chrome surveyed here — do not invent UI from docs alone | CMA docs only (see evidence tree) |
| **Desplega / unrelated “desplega” hits** | Prior flush research explicitly **not** used as CMA evidence (`cma-openai-flush-atomicity.md`) | Skip for steered GUI |

No public Console clone was found that already ships a polished
“running + steered” badge beyond the patterns above. Closest reusable
shapes: **Codex three-band dock**, **DeepSeek `SteeringMessageNode`**,
**AG-UI `queue.steered` + user text message**.

## Recommended OpenMA client UX (follow-up, not this PR)

1. **While running + unstamped mid-turn inputs:** keep them in
   `QueueDock` / ComposerProgress (existing). Optional copy hint:
   “Joins this turn at the next model step” when the agent advertises
   steering (CMA coherent-turn lock), vs “Runs after this turn” when it
   does not.
2. **On steer / stamp / `turn.steered`:** remove from dock; append (or
   highlight) inside the **active turn** with a light steered treatment
   (`steered: true` already projected) — e.g. muted caption “Steered into
   this turn” or DeepSeek-style dedicated node. **Do not reorder**.
3. **Interrupt** remains the jump-queue path; optional “interrupt & send
   now” for pending steers mirrors Codex Esc, not a second queue.
4. Share the chrome via `@openma/common/chat-ui` so Console and Backchat
   match (owner preference).
5. For AG-UI / external hosts: document `turn.steered` ↔ `queue.steered`
   + user text message mapping (abacusai pattern) without requiring raw
   `processed_at` in the GUI layer.

## Out of scope for PR #399

- Full QueueDock / ComposerProgress steered sections.
- Styling `steered: true` in Console `CanonicalSessionTurn`.
- Publishing a new `@openma/common` release solely for this chrome.

Ship this note + coherent-turn / exhausted-flush locks; implement UI in
a follow-up once shared chat-ui owns the presentation.
