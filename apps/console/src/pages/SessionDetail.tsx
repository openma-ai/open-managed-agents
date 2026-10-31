import { Input } from "@/components/ui/input";
import { startTransition, useEffect, useMemo, useState, useRef } from "react";
import { useParams, Link } from "react-router";
import { ApiError } from "../lib/api";
import { useManagedApi } from "../lib/useManagedApi";
import { useScrollFade } from "../hooks/useScrollFade";
import { readManagedMetadataObject } from "../lib/managed-metadata";
import { toast } from "sonner";
import { Markdown } from "../components/Markdown";
import { formatDuration, formatRelative, shortenId } from "../lib/format";
import { Badge, StatusPill } from "../components/Badge";
import { Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { AgentIcon, ClockIcon, DurationIcon, EnvIcon, VaultIcon } from "../components/icons";
import { FilesPanel, ResourcePanel } from "./session-detail/Panels";
import {
  TrajectoryOutcomeChip,
  TrajectoryRewardChip,
  TrajectoryViewerModal,
} from "./session-detail/Trajectory";
import { TimelineView } from "../components/timeline/TimelineView";
import type { Event } from "../lib/events";
import {
  reduceManagedDeltaFrame,
  type ManagedDeltaState,
} from "../lib/managed-stream";
import {
  projectCanonicalChat,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import {
  decodeOmaQueueCancelResponse,
  type OmaQueueCancelResponse,
} from "@openma/common/gui";
import { ManagedSessionConversation } from "../components/session/ManagedSessionConversation";
import { isQueuedSessionEvent } from "../lib/session-event-queue";
import { upsertSessionEvent } from "../lib/session-event-upsert";
import { mergeSendResponseIntoOutbox } from "../lib/session-send-outbox";
import {
  encodeGuiInterrupt,
  encodeGuiUserMessage,
  ingestManagedWireEvent,
} from "../lib/managed-event-bridge";
import type { Trajectory, TrajectoryOutcome } from "../lib/trajectory";
import { rewardHeadline, outcomeToStatusTone } from "../lib/trajectory";
// Console-specific renderers used only inside OpenMA UI host slots.
import { Message, MessageContent } from "../components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "../components/ai-elements/tool";
import { CodeBlock } from "../components/ai-elements/code-block";
import { SessionComposer } from "../components/session/SessionComposer";
import { QueueDock, type QueuedPrompt } from "@openma/common/chat-ui";
import { awaitedToolNames } from "../components/session/CanonicalSessionTurn";
import { CONSOLE_API_BETAS, getActiveTenantId, useApi } from "../lib/api";
import { useI18n } from "../i18n";

type View = "chat" | "timeline";

function waitForStreamRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function SessionDetail() {
  const { id } = useParams();
  const managedApi = useManagedApi();
  const { apiRaw } = useApi();
  const { t } = useI18n();
  const [events, setEvents] = useState<Event[]>([]);
  /** In-flight assistant streams keyed by message_id. Each entry holds
   *  the deltas accumulated so far. Wiped on the matching agent.message
   *  (same message_id), which becomes the canonical render. */
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  /** In-flight reasoning streams keyed by thinking_id. Same lifecycle
   *  as messages — drained on matching agent.thinking. */
  const [thinkingStreams, setThinkingStreams] = useState<Map<string, string>>(new Map());
  const managedDeltaState = useRef<ManagedDeltaState>({
    kinds: new Map(),
    text: new Map(),
  });
  /** In-flight tool-input streams keyed by tool_use_id. Wiped when the
   *  canonical agent.tool_use / mcp_tool_use / custom_tool_use lands
   *  with the same id (toolCallId on the AI SDK side). The accumulated
   *  string is partial JSON — render as a code block, not Markdown. */
  const [toolInputStreams, setToolInputStreams] = useState<Map<string, { name?: string; partial: string }>>(new Map());
  const [view, setView] = useState<View>("chat");
  const [sending, setSending] = useState(false);
  // Optimistic outbox slot — what the user typed between hitting Send and
  // the official send response's accepted events being merged into
  // `events`. Without this, hitting Send clears the input field instantly
  // and the user stares at a blank conversation for the roundtrip. With it,
  // the message appears immediately. send() merges response.data first and
  // clears this slot only after a successful merge; empty data keeps it (no
  // pending-frame fallback). Single slot is intentional (we never let two
  // POSTs be in flight at once — Send is disabled while `sending`).
  const [localPending, setLocalPending] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  /** True when the optimistic send was made mid-turn, so its echo belongs in
   *  the queue dock (Backchat) rather than in the transcript. */
  const [localPendingQueued, setLocalPendingQueued] = useState(false);
  /** Queue rows with a local action awaiting the server's lifecycle event. */
  const [queueBusy, setQueueBusy] = useState<Map<string, "removing" | "steering" | "editing">>(new Map());
  /** Agent advertises OpenMA steering (metadata "oma.session.steering"). */
  const [agentSteering, setAgentSteering] = useState(false);
  /** Edit lost the race (server already started the item): the edited text
   *  goes back to the composer so it can be sent as a new message. */
  const [composerRestore, setComposerRestore] = useState<{ text: string; nonce: number } | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!composerNotice) return;
    const timer = setTimeout(() => setComposerNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [composerNotice]);
  /** GET /v1/sessions/:id answered 404 / not_found_error. Other failures
   *  (network, 5xx) keep the existing toast-and-continue handling. */
  const [notFound, setNotFound] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<{
    title?: string | null;
    environmentId?: string;
    vaultIds?: string[];
    vaults?: Array<{ id: string; name?: string }>;
    createdAt?: string;
    agentSnapshot?: { id?: string; name?: string; model?: string | { id: string }; description?: string | null; version?: number };
    envSnapshot?: { id?: string; name?: string; description?: string | null };
  }>({});
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [resourcePanel, setResourcePanel] = useState<
    | { kind: "agent"; id: string }
    | { kind: "environment"; id: string }
    | { kind: "vault"; id: string }
    | null
  >(null);
  const [showFiles, setShowFiles] = useState(false);
  const [linear, setLinear] = useState<{
    issueId?: string;
    issueIdentifier?: string;
    workspaceId?: string;
  } | null>(null);
  const [slack, setSlack] = useState<{
    channelId?: string;
    threadTs?: string;
    workspaceId?: string;
    eventKind?: string;
    publicationId?: string;
  } | null>(null);
  const [status, setStatus] = useState("idle");
  /** Lazy-fetched Trajectory v1 envelope. Drives the outcome + reward
   *  chips in the header strip and the Trajectory viewer modal. We don't
   *  block initial render on this — chips render as `—` until it lands.
   *  Sentinels mirror EvalRunDetail: "loading" while in flight, "error"
   *  if the fetch failed (404 = trajectory not built yet, 5xx = sandbox
   *  flaky); both keep the trigger from re-firing every render. */
  const [trajectory, setTrajectory] = useState<Trajectory | "loading" | "error" | undefined>(undefined);
  /** Sub-agent threads in this session. Primary is implicit at index 0
   *  (label "Main"). Empty when the session has only the primary thread,
   *  in which case the selector UI is hidden entirely. Refreshed on
   *  `session.thread_created` events arriving over SSE.
   *  parent_thread_id powers the tree view (coordinator → worker → sub-
   *  worker); missing parents fall back to the primary root. */
  const [threads, setThreads] = useState<
    Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>
  >([]);
  /** Currently-active thread id. Defaults to 'sthr_primary'. Filters
   *  the events array at render time. SSE-driven new threads don't
   *  auto-switch — the operator stays on whatever they're watching. */
  const [activeThreadId, setActiveThreadId] = useState<string>("sthr_primary");
  const [showTrajectory, setShowTrajectory] = useState(false);
  /** Synchronous mirror of `events` so addEvent can decide append/update/
   *  duplicate before React commits. Session history paging + SSE can call
   *  addEvent back-to-back; a state updater cannot drive side effects. */
  const eventsRef = useRef<Event[]>([]);

  const addEvent = (e: Record<string, unknown>) => {
    // Stream delta / chunk frames stay on the wire shape for live overlays.
    // Everything else crosses the CMA→OpenMA boundary so GUI never sees
    // Managed `processed_at`.
    const wireType = typeof e.type === "string" ? e.type : "";
    const isLiveStreamFrame =
      wireType === "event_start"
      || wireType === "event_delta"
      || wireType === "event_end"
      || wireType.endsWith("_chunk")
      || wireType.endsWith("_stream_start")
      || wireType.endsWith("_stream_end")
      || wireType === "agent.tool_use_input_stream_start"
      || wireType === "agent.tool_use_input_chunk"
      || wireType === "agent.tool_use_input_stream_end";
    const ev = (
      isLiveStreamFrame
        ? (e as Event)
        : (ingestManagedWireEvent(e, { sessionId: id ?? "unknown" }) ?? (e as Event))
    );

    // Managed Agents v2 streaming uses an event_start/event_delta pair for
    // both assistant text and thinking. Keep the correlation state outside
    // React so back-to-back frames cannot race a render; mirror only the
    // accumulated strings into component state.
    const reducedDelta = reduceManagedDeltaFrame(managedDeltaState.current, e);
    managedDeltaState.current = reducedDelta.state;
    if (reducedDelta.action?.type === "open" || reducedDelta.action?.type === "append") {
      const target = reducedDelta.action.stream === "agent.message"
        ? setStreams
        : setThinkingStreams;
      const id = reducedDelta.action.id;
      target((previous) => {
        const next = new Map(previous);
        next.set(id, reducedDelta.state.text.get(id) ?? "");
        return next;
      });
      return;
    }
    if (reducedDelta.action?.type === "close") {
      const target = reducedDelta.action.stream === "agent.message"
        ? setStreams
        : setThinkingStreams;
      const id = reducedDelta.action.id;
      target((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
    }

    // Streaming chunk lifecycle. None of these go into the events list
    // (would pollute history once the canonical agent.message lands);
    // they drive the `streams` map that the renderer overlays after
    // committed events. The matching agent.message arrives with the
    // same message_id and replaces the in-flight render.
    if (ev.type === "agent.message_stream_start" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (prev.has(mid)) return prev;
        const next = new Map(prev);
        next.set(mid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_chunk" && ev.message_id && typeof ev.delta === "string") {
      const mid = ev.message_id;
      const delta = ev.delta;
      setStreams((prev) => {
        const next = new Map(prev);
        next.set(mid, (next.get(mid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_stream_end") {
      // Hold the in-flight render until the canonical agent.message
      // arrives — keeps UI stable through the brief gap between the
      // SSE stream_end and the events-log commit. If the run was
      // aborted/interrupted, the canonical event will land via the
      // recovery path and clean up the same way.
      return;
    }

    // Thinking stream lifecycle. Same pattern as message stream:
    // start opens an entry, chunk appends, end is held, canonical
    // agent.thinking with same thinking_id closes it.
    if (ev.type === "agent.thinking_stream_start" && typeof ev.thinking_id === "string") {
      const tid = ev.thinking_id;
      setThinkingStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_chunk" && typeof ev.thinking_id === "string" && typeof ev.delta === "string") {
      const tid = ev.thinking_id;
      const delta = ev.delta;
      setThinkingStreams((prev) => {
        const next = new Map(prev);
        next.set(tid, (next.get(tid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_stream_end") return;

    // Tool-input stream lifecycle. The accumulated string is partial
    // JSON; once tool_use lands with the same id, drop the in-flight
    // render and let the EventBubble's collapsed tool widget take over.
    if (ev.type === "agent.tool_use_input_stream_start" && ev.tool_use_id) {
      const tid = ev.tool_use_id;
      const name = (ev as { tool_name?: string }).tool_name;
      setToolInputStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, { name, partial: "" });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_chunk" && ev.tool_use_id && typeof ev.delta === "string") {
      const tid = ev.tool_use_id;
      const delta = ev.delta;
      setToolInputStreams((prev) => {
        const cur = prev.get(tid);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(tid, { ...cur, partial: cur.partial + delta });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_stream_end") return;

    // Canonical agent.message lands → drop the in-flight render so
    // we don't double-show the same content.
    if (ev.type === "agent.message" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (!prev.has(mid)) return prev;
        const next = new Map(prev);
        next.delete(mid);
        return next;
      });
    }

    // Canonical agent.thinking → drop the in-flight reasoning entry.
    // If the canonical event has thinking_id we use it; otherwise we
    // bail-clear all live thinking streams (multi-stream-per-step is
    // rare and safer to err on closing them all).
    if (ev.type === "agent.thinking") {
      const tid = typeof ev.thinking_id === "string" ? ev.thinking_id : undefined;
      setThinkingStreams((prev) => {
        if (prev.size === 0) return prev;
        if (tid && !prev.has(tid)) return prev;
        const next = new Map(prev);
        if (tid) next.delete(tid);
        else next.clear();
        return next;
      });
    }

    // Canonical tool_use of any kind (built-in, MCP, custom) → drop
    // in-flight tool input. The canonical id field equals the AI SDK
    // toolCallId we used as tool_use_id.
    if ((ev.type === "agent.tool_use"
      || ev.type === "agent.mcp_tool_use"
      || ev.type === "agent.custom_tool_use") && ev.id) {
      const tid = ev.id;
      setToolInputStreams((prev) => {
        if (!prev.has(tid)) return prev;
        const next = new Map(prev);
        next.delete(tid);
        return next;
      });
    }

    // Optional OpenMA extensions. CF's SessionDO may still emit these
    // pending-queue notifications, but the Console does not depend on them
    // for the send/outbox path (official MA send response is authoritative).
    // Ignore them so they never become unknown user-visible rows in the
    // canonical events list. Queue-lifecycle frames (cancelled / steered)
    // arrive here already decoded by openma-common as OpenMA
    // `turn.cancelled` / `turn.steered` events and are kept: the canonical
    // projection uses them to drop or absorb queued rows.
    if (
      ev.type === "system.user_message_pending"
      || ev.type === "system.user_message_promoted"
    ) {
      return;
    }

    // Tag streamed events with arrival time so the timeline has a usable ts
    // even before the server-side stored copy round-trips.
    if (!ev.ts) ev.ts = new Date().toISOString();

    // Official MA redelivers the same event id once a queued event is
    // processed. Decode maps that to turn.queued → user.message (delivery
    // processed). Upsert replaces/repositions; only append runs side effects.
    const upserted = upsertSessionEvent(eventsRef.current, ev);
    if (upserted.action === "duplicate") return;
    eventsRef.current = upserted.events;
    setEvents(upserted.events);
    if (upserted.action === "update") return;

    // addEvent ingests through the OpenMA codec: CMA session.status_running /
    // status_idle arrive as OpenMA session.running / session.idle.
    if (ev.type === "session.running") setStatus("running");
    if (ev.type === "session.idle") setStatus("idle");
    // session.error → idle: defense-in-depth for the catch-all status_idle
    // emit (processUserMessage finally) in case a future code path forgets
    // to pair status_running with status_idle. Note: do NOT also map
    // status_rescheduled — that's a transient retry-pending state, not a
    // terminal one. Mapping it caused observed pill flicker
    // running→idle→running→idle×3 during exponential-backoff retries
    // (sess-y2bfxm1de4e1zqxm 2026-05-11). The next status_running event
    // for the retry attempt naturally restores the pill.
    if (ev.type === "session.error") {
      setStatus("idle");
    }

    // Official-path handoff for the optimistic bubble: when the send
    // response carried no data (or SSE redelivers the canonical event),
    // the real user.message is what replaces it. This does NOT use
    // OpenMA pending frames.
    if (ev.type === "user.message" || ev.type === "turn.queued") {
      const blocks = Array.isArray(ev.content) ? ev.content : [];
      const text =
        (typeof (ev as { text?: unknown }).text === "string"
          ? (ev as { text: string }).text
          : undefined)
        ?? blocks.find((block) => block.type === "text")?.text;
      if (typeof text === "string") {
        setLocalPending((cur) => (cur === text ? null : cur));
      }
    }
    // Live-update the thread selector when a sub-agent spawns. We don't
    // auto-switch the operator's view — they stay on whatever they're
    // watching; the new tab just appears alongside.
    if (ev.type === "session.thread_created") {
      const tc = ev as {
        session_thread_id?: string;
        agent_name?: string;
        parent_thread_id?: string | null;
      };
      if (tc.session_thread_id && tc.session_thread_id !== "sthr_primary") {
        setThreads((prev) =>
          prev.some((t) => t.id === tc.session_thread_id)
            ? prev
            : [
                ...prev,
                {
                  id: tc.session_thread_id!,
                  agent_name: tc.agent_name,
                  // SessionDO emits thread_created with parent_thread_id;
                  // older sessions (pre-Phase 1) may not — fall back to
                  // primary so the tree stays well-formed.
                  parent_thread_id: tc.parent_thread_id ?? "sthr_primary",
                },
              ],
        );
      }
    }
    // Don't return — Timeline's bucketIntoTurns uses these as the close
    // boundary of a turn. Conversation view's EventBubble switch silently
    // skips unknown types so leaving them in `events` is harmless there.
    // Previously this dropped every span.* and agent.thinking event before
    // they reached `events` state, so Timeline saw none of model/wakeup/
    // compaction/outcome spans (entire reason waterfall looked empty).
    // Conversation view's EventBubble silently ignores unknown types via
    // its switch — keeping the events here costs the chat view nothing
    // and gives Timeline the full trajectory it needs.

  };

  useEffect(() => {
    if (!id) return;
    // Full per-session state reset before loading the new id. The
    // canonical bug this fixes: clicking from /sessions/A to /sessions/B
    // re-runs this effect with a new id, but `events` (and the other
    // session-scoped state below) was retained from session A. Same
    // SessionDetail component instance handles both routes — React only
    // re-runs the effect, doesn't unmount/remount — so without an
    // explicit reset the user sees session A's content under session B's
    // URL until the SSE refill catches up. Hard refresh works because
    // it re-mounts the whole tree from a fresh state. Reported 2026-05-13.
    managedDeltaState.current = { kinds: new Map(), text: new Map() };
    eventsRef.current = [];
    setEvents([]);
    setStreams(new Map());
    setThinkingStreams(new Map());
    setToolInputStreams(new Map());
    setAgentId("");
    setSessionMeta({});
    setNotFound(false);
    setLinear(null);
    setSlack(null);
    setEditingTitle(false);
    setTitleDraft("");
    setSavingTitle(false);
    setStatus("idle");
    setTrajectory(undefined);
    setThreads([]);
    setActiveThreadId("sthr_primary");
    setLocalPending(null);

    // Load session info
    managedApi.sessions.retrieve(id)
      .then((s) => {
        setAgentId(s.agent?.id || "");
        const snapshotMeta = (s.agent as { metadata?: Record<string, string> } | undefined)?.metadata;
        if (snapshotMeta) {
          setAgentSteering(snapshotMeta["oma.session.steering"] === "enabled");
        } else if (s.agent?.id) {
          managedApi.agents.retrieve(s.agent.id)
            .then((agent) => setAgentSteering(
              (agent.metadata as Record<string, string> | undefined)?.["oma.session.steering"] === "enabled",
            ))
            .catch(() => setAgentSteering(false));
        }
        setStatus(s.status);
        setSessionMeta({
          title: s.title ?? null,
          environmentId: s.environment_id,
          vaultIds: s.vault_ids,
          createdAt: s.created_at,
          agentSnapshot: s.agent,
        });
        setTitleDraft(s.title ?? "");

        const linearMeta = readManagedMetadataObject(s.metadata, "linear") as
          | { issueId?: string; issueIdentifier?: string; workspaceId?: string }
          | null;
        setLinear(
          linearMeta && (linearMeta.issueId || linearMeta.issueIdentifier)
            ? linearMeta
            : null,
        );
        const slackMeta = readManagedMetadataObject(s.metadata, "slack") as
          | { channelId?: string; threadTs?: string; workspaceId?: string; eventKind?: string; publicationId?: string }
          | null;
        setSlack(
          slackMeta && (slackMeta.channelId || slackMeta.threadTs)
            ? slackMeta
            : null,
        );

        // Live-resolve env + vault names by id. Per the id-only ref decision
        // (memory: session-resource-refs), the session API does not pre-bake
        // display data — clients fetch resources on demand. Names appear a
        // tick later than the badge frame; until then the badge falls back
        // to the short-id label.
        if (s.environment_id) {
          managedApi.environments.retrieve(s.environment_id)
            .then((env) => setSessionMeta((prev) => ({ ...prev, envSnapshot: env })))
            .catch(() => {});
        }
        if (s.vault_ids?.length) {
          Promise.all(
            s.vault_ids.map((vid) =>
              managedApi.vaults.retrieve(vid)
                .then((v) => ({ id: v.id, name: v.display_name }))
                .catch(() => ({ id: vid })),
            ),
          ).then((vaults) => setSessionMeta((prev) => ({ ...prev, vaults })));
        }
      })
      .catch((error) => {
        if (isSessionNotFoundError(error)) setNotFound(true);
      });

    // Load canonical Managed Agents history. `next_page` is an opaque cursor;
    // do not parse it or depend on the old OMA `{seq, ts, data}` envelope.
    // Each page is applied as it arrives so long sessions render progressively.
    const loadHistory = async () => {
      let page: string | undefined;
      const seenPages = new Set<string>();
      const pageLimit = 100;
      // Bound the loop so a malformed `next_page` never spins forever.
      // Even at 200/page this covers 100k events, well past anything the
      // sandbox SQL store retains in practice.
      for (let i = 0; i < 500; i++) {
        try {
          const res = await managedApi.sessions.events.list(id, {
            limit: pageLimit,
            order: "asc",
            page,
          });
          for (const managedEvent of res.data) {
            // addEvent runs ingestManagedWireEvent (strips processed_at,
            // projects delivery / turn.queued).
            addEvent(managedEvent as unknown as Record<string, unknown>);
          }
          if (!res.next_page || seenPages.has(res.next_page)) break;
          seenPages.add(res.next_page);
          page = res.next_page;
        } catch {
          break;
        }
      }
    };
    void loadHistory();

    // Connect the official Managed Agents async event stream. Reconnect only
    // transport/5xx failures; 4xx responses are terminal until navigation or
    // auth state changes, so retrying them would only hammer the API.
    const abort = new AbortController();
    void (async () => {
      const backoffMs = [1_000, 2_000, 4_000, 8_000];
      let failures = 0;
      let connected = false;
      while (!abort.signal.aborted) {
        try {
          const liveEvents = await managedApi.sessions.events.stream(
            id,
            { event_deltas: ["agent.message", "agent.thinking"] },
            { signal: abort.signal },
          );
          failures = 0;
          // The official stream has no replay, so anything emitted while the
          // previous connection was down (tool results, status_idle, queue
          // stamps) would be missing until a full reload. Re-list once the
          // new stream is open; upsertSessionEvent dedupes by event id.
          if (connected) void loadHistory();
          connected = true;
          for await (const event of liveEvents) {
            if (abort.signal.aborted) break;
            addEvent(event as unknown as Record<string, unknown>);
          }
        } catch (error) {
          if (abort.signal.aborted) break;
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            break;
          }
        }
        if (abort.signal.aborted) break;
        const delay = backoffMs[Math.min(failures, backoffMs.length - 1)];
        failures += 1;
        await waitForStreamRetry(delay, abort.signal);
      }
    })();

    // Threads list (primary + sub-agent). Primary is always present
    // (seeded by SessionDO on /init). Filter to non-primary so the
    // selector only renders when there's something to switch between
    // — single-thread sessions get zero UI clutter.
    managedApi.sessions.threads.list(id, { limit: 100 })
      .then((res) => {
        const subThreads = (res.data ?? [])
          .filter((t) => t.id !== "sthr_primary")
          .map((t) => ({
            id: t.id,
            parent_thread_id: t.parent_thread_id,
            agent_name: "name" in t.agent ? t.agent.name : undefined,
          }));
        setThreads(subThreads);
      })
      .catch(() => setThreads([]));

    return () => { abort.abort(); };
  }, [id]);

  const send = async (messageText: string, files?: File[]) => {
    const text = messageText.trim();
    if (!text && !files?.length) return;
    if (!id) return;
    const optimisticText =
      text || (files?.length ? (files.length === 1 ? "🖼️ Image" : `🖼️ ${files.length} images`) : "");
    setLocalPending(optimisticText);
    setLocalPendingQueued(status === "running");
    setSending(true);
    try {
      // Upload attachments first so the user.message can reference them
      // by file_id. File scope and downloadability are server-owned fields
      // in the Managed Files API. Per-file failures don't block the others — the text
      // still goes out and the user can retry the failed upload.
      const uploaded: Array<{ id: string; filename: string; media_type: string }> = [];
      if (files?.length) {
        for (const file of files) {
          try {
            const r = await managedApi.files.upload({ file });
            uploaded.push({ id: r.id, filename: r.filename, media_type: r.mime_type });
          } catch (e) {
            console.error("file upload failed", file.name, e);
          }
        }
      }

      // The + button is image-only — vision inputs go inline to the
      // model. Non-vision file attachments belong on a separate path
      // (env-mounted resources) and aren't reachable from this button,
      // so this loop only emits `image` content blocks.
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "file"; file_id: string } }
      > = [];
      if (text) content.push({ type: "text", text });
      for (const u of uploaded) {
        if (u.media_type.startsWith("image/")) {
          content.push({
            type: "image",
            source: { type: "file", file_id: u.id },
          });
        }
        // non-images can't slip through the accept filter, but if one
        // does (drag-drop on some browsers ignores accept) we drop it
        // silently rather than fall back to a document block the model
        // may not handle.
      }
      if (!text && uploaded.length) {
        content.unshift({
          type: "text",
          text: uploaded.length === 1 ? "Attached image." : "Attached images.",
        });
      }

      const encoded = encodeGuiUserMessage({
        sessionId: id,
        content,
        text: text || undefined,
        sessionThreadId: activeThreadId !== "sthr_primary" ? activeThreadId : undefined,
      });
      if (!encoded.ok) {
        toast.error(encoded.error);
        setLocalPending(null);
        setSending(false);
        return;
      }
      const response = await managedApi.sessions.events.send(id, {
        events: [encoded.wire as { type: "user.message"; content: typeof content }],
      });
      // Official MA contract: the send response carries the accepted
      // user.message events in response.data. Merge them into the canonical
      // log first; addEvent dedupes by id so the same event arriving later
      // over SSE cannot double-render. Only after a successful merge do we
      // drop the optimistic slot. Empty data keeps the optimistic bubble
      // visible — there is no pending-frame fallback.
      const handoff = mergeSendResponseIntoOutbox(
        response,
        { localPending: optimisticText, optimisticText },
        addEvent,
      );
      setLocalPending(handoff.localPending);
    } catch {
      // api() already toasted the error; clear the optimistic slot so
      // the user doesn't keep seeing a "stuck" optimistic row that will
      // never actually run.
      setLocalPending(null);
    }
    setSending(false);
  };

  // Stop button — posts user.interrupt to abort whatever turn(s) are
  // running on the active thread. Server-side this triggers the
  // thread-scoped AbortController, marks pending events cancelled, and
  // emits status_idle. Recovery path for the "stuck Running" failure
  // mode where a DO eviction killed an in-flight stream and no clean
  // status_idle was ever broadcast.
  const [interrupting, setInterrupting] = useState(false);
  const {
    turns: canonicalTurns,
    queued: canonicalQueued,
    activeTurnId,
    sessionState: projectedSessionState,
  } = useMemo(
    () => projectCanonicalChat(events as WireSessionEvent[], {
      threadId: activeThreadId,
      // Host status is authoritative for settle: idle/terminated → no turn
      // stays running (requires_action stays awaiting).
      sessionStatus: status,
    }),
    [activeThreadId, events, status],
  );
  /** Official requires_action: session idle, turn parked on tool calls. */
  const needsAction = status !== "running" && projectedSessionState === "requires_action";
  const activeTurn = activeTurnId ? canonicalTurns.find((turn) => turn.id === activeTurnId) : undefined;
  const blockedToolNames = needsAction && activeTurn ? awaitedToolNames(activeTurn) : [];
  /** Stable filtered list for Timeline — avoid reallocating on every
   *  SessionDetail render (SSE stream updates, keystrokes, etc.), which
   *  would otherwise invalidate TimelineView's bucketIntoTurns memo. */
  const timelineEvents = useMemo(
    () =>
      events.filter((e) => {
        const tid = (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
        return tid === activeThreadId;
      }),
    [events, activeThreadId],
  );
  const interrupt = async () => {
    if (!id) return;
    setInterrupting(true);
    try {
      const encoded = encodeGuiInterrupt({
        sessionId: id,
        sessionThreadId: activeThreadId !== "sthr_primary" ? activeThreadId : undefined,
      });
      if (!encoded.ok) {
        console.error("interrupt encode failed", encoded.error);
        setInterrupting(false);
        return;
      }
      await managedApi.sessions.events.send(id, {
        events: [encoded.wire as { type: "user.interrupt"; session_thread_id?: string }],
      });
    } catch (e) {
      console.error("interrupt failed", e);
    }
    setInterrupting(false);
  };

  const markQueueBusy = (messageId: string, state: "removing" | "steering" | "editing" | null) => {
    setQueueBusy((prev) => {
      const next = new Map(prev);
      if (state) next.set(messageId, state);
      else next.delete(messageId);
      return next;
    });
  };
  /**
   * Compare-and-cancel via DELETE pending. Body is OmaQueueCancelResponse
   * (openma-common): `{ cancelled: true, id }` vs
   * `{ cancelled: false, reason, id, processed_at? }`. Stream still emits
   * turn.cancelled on success as backup for other observers.
   */
  const cancelQueued = async (
    messageId: string,
    busy: "removing" | "editing" = "removing",
  ): Promise<OmaQueueCancelResponse | { cancelled: false; reason: "failed"; id: string }> => {
    if (!id) return { cancelled: false, reason: "failed", id: messageId };
    markQueueBusy(messageId, busy);
    try {
      const res = await fetch(
        `/v1/oma/sessions/${encodeURIComponent(id)}/pending/${encodeURIComponent(messageId)}`,
        {
          method: "DELETE",
          credentials: "include",
          headers: {
            "anthropic-beta": CONSOLE_API_BETAS,
            ...(getActiveTenantId() ? { "x-active-tenant": getActiveTenantId()! } : {}),
          },
        },
      );
      const raw = await res.json().catch(() => null);
      const decoded = decodeOmaQueueCancelResponse(raw);
      if (decoded) {
        if (!decoded.cancelled) markQueueBusy(messageId, null);
        return decoded;
      }
      markQueueBusy(messageId, null);
      if (res.status === 409) {
        return { cancelled: false, reason: "already_processing", id: messageId };
      }
      return { cancelled: false, reason: "failed", id: messageId };
    } catch {
      markQueueBusy(messageId, null);
      return { cancelled: false, reason: "failed", id: messageId };
    }
  };
  const steerQueued = async (messageId: string) => {
    if (!id) return;
    markQueueBusy(messageId, "steering");
    try {
      const res = await apiRaw(
        `/v1/oma/sessions/${encodeURIComponent(id)}/pending/${encodeURIComponent(messageId)}/steer`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      markQueueBusy(messageId, null);
    }
  };
  /** Save an edit: compare-and-cancel the queued row, then re-enqueue the
   * edited text (joins end of queue). If the server already started it, the
   * edited text goes back to the composer instead. */
  const updateQueued = async (messageId: string, text: string) => {
    const result = await cancelQueued(messageId, "editing");
    if (result.cancelled) {
      await send(text);
      return;
    }
    abandonQueueEdit(messageId, text, result.reason);
  };
  const abandonQueueEdit = (_messageId: string, draft: string, reason: string) => {
    setComposerRestore({ text: draft, nonce: Date.now() });
    setComposerNotice(
      reason === "already_processing" || reason === "already_completed"
        ? "Already sent, can't edit. Your text is in the composer: send it as a new message."
        : "Couldn't edit the queued message. Your text is in the composer.",
    );
  };
  const queueDockItems: QueuedPrompt[] = [
    ...canonicalQueued.map((item) => ({
      id: item.id,
      text: item.text,
      busy: queueBusy.has(item.id),
    })),
    ...(localPending !== null && localPendingQueued && activeThreadId === "sthr_primary"
      ? [{ id: "optimistic", text: localPending, busy: true }]
      : []),
  ];
  // A row that left the queue (started, steered, cancelled) drops its busy flag.
  useEffect(() => {
    setQueueBusy((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(canonicalQueued.map((item) => item.id));
      const next = new Map([...prev].filter(([key]) => live.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [canonicalQueued]);
  const composerPlaceholder = status === "running"
    ? queueDockItems.length > 0 ? `${queueDockItems.length} queued…` : "Add to queue…"
    : "Send a message…";

  const saveTitle = async () => {
    if (!id) return;
    setSavingTitle(true);
    try {
      const updated = await managedApi.sessions.update(id, { title: titleDraft.trim() });
      setSessionMeta((prev) => ({
        ...prev,
        title: updated.title ?? (titleDraft.trim() || null),
      }));
      setEditingTitle(false);
    } catch (e) {
      console.error("rename session failed", e);
    } finally {
      setSavingTitle(false);
    }
  };

  const hasTransientActivity = (
    (localPending !== null && !localPendingQueued && activeThreadId === "sthr_primary")
    || thinkingStreams.size > 0
    || toolInputStreams.size > 0
    || streams.size > 0
    || status === "running"
  );
  const transientActivity = (
    <>
      <SessionTransientActivity
        localPending={activeThreadId === "sthr_primary" && !localPendingQueued ? localPending : null}
        running={status === "running"}
        streams={streams}
        thinkingStreams={thinkingStreams}
        toolInputStreams={toolInputStreams}
      />
    </>
  );

  if (notFound) return <SessionNotFound id={id} />;

  return (
    <div className="flex flex-col h-full">
      {/* Header — badges row + page-specific action buttons.
          The redundant `← Sessions / sess-xxx` back-link + id heading
          was removed; AppBreadcrumb above the page now carries the
          trail and the entity id. Stop + Files actions live at the
          right (`ml-auto`) of the badges row so the page-level chrome
          stays one band tall. */}
      <div className="pl-3 pr-4 py-3 flex flex-col gap-2 shrink-0">
        {/* Editable session title — optional metadata; empty shows a
            muted "Untitled" affordance so rename is discoverable. */}
        <div className="flex items-center gap-2 min-h-8">
          {editingTitle ? (
            <>
              <Input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                className="flex-1 min-w-0 border border-border rounded-md px-2.5 py-1.5 text-sm bg-bg text-fg outline-none focus:border-brand"
                placeholder={t.sessions.sessionTitle}
                autoFocus
                disabled={savingTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                  if (e.key === "Escape") {
                    setEditingTitle(false);
                    setTitleDraft(sessionMeta.title ?? "");
                  }
                }}
              />
              <Button variant="ghost"
                onClick={() => void saveTitle()}
                disabled={savingTitle}
                className="inline-flex items-center px-2.5 py-1 min-h-11 sm:min-h-0 rounded-md text-xs font-medium bg-brand text-brand-fg disabled:opacity-50"
              >
                {savingTitle ? t.common.saving : t.common.save}
              </Button>
              <Button variant="ghost"
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(sessionMeta.title ?? "");
                }}
                disabled={savingTitle}
                className="inline-flex items-center px-2.5 py-1 min-h-11 sm:min-h-0 rounded-md text-xs text-fg-muted hover:text-fg"
              >
                {t.common.cancel}
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-sm font-medium text-fg truncate min-w-0">
                {sessionMeta.title?.trim() || (
                  <span className="text-fg-subtle font-normal">{t.sessions.untitledSession}</span>
                )}
              </h2>
              <Button variant="ghost"
                onClick={() => {
                  setTitleDraft(sessionMeta.title ?? "");
                  setEditingTitle(true);
                }}
                className="inline-flex items-center px-2 py-0.5 min-h-11 sm:min-h-0 rounded text-xs text-fg-subtle hover:text-fg hover:bg-bg-surface shrink-0"
              >
                {t.sessions.editTitle}
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill
            label={needsAction ? "Needs action" : undefined}
            status={needsAction ? "awaiting" : status as "idle" | "running" | "terminated" | "error" | string}
          />
          {/* Trajectory outcome chip — only when the trajectory has actually
              finished. While the session is still running we let StatusPill
              carry the "Running…" signal alone (per Phase 3 spec) instead of
              double-pilling. */}
          <TrajectoryOutcomeChip trajectory={trajectory} />
          {/* Reward chip — final_reward + verifier_id tooltip. Hidden when
              the verifier hasn't run (no trajectory.reward) so we don't
              imply "no reward = score 0". */}
          <TrajectoryRewardChip trajectory={trajectory} />
          {/* Always render env + agent + vault badges so an operator can
              see what makes up this session at a glance. Name falls back
              to a short ID slice if the snapshot didn't carry one — better
              "agent_…XYZ" than nothing. */}
          {(sessionMeta.agentSnapshot?.id || agentId) && (
            <Badge
              icon={<AgentIcon />}
              label={sessionMeta.agentSnapshot?.name || shortenId(sessionMeta.agentSnapshot?.id || agentId)}
              onClick={() =>
                setResourcePanel({ kind: "agent", id: sessionMeta.agentSnapshot?.id || agentId })
              }
            />
          )}
          {sessionMeta.environmentId && (
            <Badge
              icon={<EnvIcon />}
              label={sessionMeta.envSnapshot?.name || shortenId(sessionMeta.environmentId)}
              onClick={() =>
                setResourcePanel({ kind: "environment", id: sessionMeta.environmentId! })
              }
            />
          )}
          {(sessionMeta.vaults ?? sessionMeta.vaultIds?.map((id) => ({ id, name: undefined })) ?? []).map((v) => (
            <Badge
              key={v.id}
              icon={<VaultIcon />}
              label={v.name || shortenId(v.id)}
              onClick={() => setResourcePanel({ kind: "vault", id: v.id })}
            />
          ))}
          <SessionDurationBadge events={events} />
          {sessionMeta.createdAt && <RelativeTimeBadge iso={sessionMeta.createdAt} />}
          <div className="ml-auto flex items-center gap-2">
            {/* Stop / Interrupt — only while the session is actively running.
                Posts user.interrupt scoped to the active thread; server fires
                thread AbortController + flushes pending events + emits
                status_idle. Recovery path for stuck-Running sessions where a
                DO eviction killed the stream and no clean status_idle ever
                landed. */}
            {status === "running" && view !== "chat" && (
              <Button variant="ghost"
                onClick={() => void interrupt()}
                disabled={interrupting}
                className="inline-flex items-center justify-center px-2.5 py-1 min-h-11 sm:min-h-0 rounded-md text-xs font-medium bg-bg-surface/60 text-fg-muted hover:bg-bg-surface hover:text-fg disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                title="Interrupt the active turn on this thread"
              >
                {interrupting ? "Stopping…" : "Stop"}
              </Button>
            )}
            <Button variant="ghost"
              onClick={() => setShowFiles((v) => !v)}
              className={`inline-flex items-center justify-center px-2.5 py-1 min-h-11 sm:min-h-0 rounded-md text-xs font-medium transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                showFiles
                  ? "bg-bg-surface text-fg"
                  : "bg-bg-surface/60 text-fg-muted hover:bg-bg-surface hover:text-fg"
              }`}
              title="Files the agent wrote to /mnt/session/outputs/"
            >
              Files
            </Button>
          </div>
        </div>
      </div>

      {/* Thread selector — only when sub-agent threads exist. Primary
          is implicit at index 0 ("Main"); sub-agent tabs appear as new
          threads spawn (live-updated by session.thread_created handler).
          Selecting a thread filters both Conversation and Timeline views.
          Renders as a depth-indented tree when sub-agents themselves
          spawn sub-workers — flat horizontal row for the common case
          (single layer of workers under primary). */}
      {threads.length > 0 && (
        <ThreadTree
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={setActiveThreadId}
        />
      )}

      {/* View tabs */}
      <div role="tablist" aria-label="Session view" className="pl-3 pr-4 flex items-center gap-1 shrink-0">
        <ViewTab label="Conversation" active={view === "chat"} onClick={() => setView("chat")} />
        <ViewTab
          label="Timeline"
          active={view === "timeline"}
          onClick={() => startTransition(() => setView("timeline"))}
        />
        {view === "timeline" && (
          <span className="ml-auto text-xs text-fg-subtle font-mono">{events.length} events</span>
        )}
        {/* Trajectory viewer trigger — pushed to the right edge of the tab
            row. Disabled until the lazy fetch resolves so the click never
            opens an empty modal. Errors keep the button enabled (the modal
            shows the error). */}
        <Button variant="ghost"
          onClick={() => setShowTrajectory(true)}
          disabled={trajectory === undefined || trajectory === "loading"}
          className={`${view === "timeline" ? "ml-3" : "ml-auto"} inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed bg-bg-surface/60 hover:bg-bg-surface rounded px-2 py-1 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] my-1.5`}
          title={
            trajectory === "loading"
              ? "Loading trajectory…"
              : trajectory === "error"
              ? "Trajectory unavailable — click to inspect error"
              : "View raw Trajectory v1 envelope"
          }
        >
          Trajectory
        </Button>
      </div>

      {/* Linear context (when triggered by a Linear webhook) */}
      {linear && (
        <div className="pl-3 pr-4 py-2 bg-info-subtle text-xs flex items-center gap-2 text-info">
          <span>🔗</span>
          <span className="font-medium">Linear</span>
          <span className="opacity-60">·</span>
          <span>
            issue{" "}
            <span className="font-mono">{linear.issueIdentifier ?? linear.issueId}</span>
          </span>
          {linear.workspaceId && (
            <a
              href={`https://linear.app`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto hover:underline"
            >
              Open in Linear ↗
            </a>
          )}
        </div>
      )}

      {/* Slack context (when triggered by a Slack event) */}
      {slack && (
        <div className="pl-3 pr-4 py-2 bg-accent-violet-subtle text-xs flex items-center gap-2 text-accent-violet flex-wrap">
          <span>💬</span>
          <span className="font-medium">Slack</span>
          <span className="opacity-60">·</span>
          <span>
            {slack.channelId ? (
              slack.workspaceId ? (
                <a
                  href={`slack://channel?team=${slack.workspaceId}&id=${slack.channelId}`}
                  className="font-mono underline hover:no-underline"
                  title="Open in Slack desktop"
                >
                  channel {slack.channelId} ↗
                </a>
              ) : (
                <>
                  channel <span className="font-mono">{slack.channelId}</span>
                </>
              )
            ) : (
              "—"
            )}
            {slack.threadTs && (
              <>
                {" "}thread{" "}
                <span className="font-mono">{slack.threadTs}</span>
              </>
            )}
          </span>
          {slack.eventKind && (
            <span className="opacity-60 font-mono uppercase tracking-wider text-xs">
              {slack.eventKind}
            </span>
          )}
          {slack.publicationId && (
            <>
              <span className="opacity-60">·</span>
              <Link
                to={`/integrations/slack/publish?pub=${slack.publicationId}`}
                className="underline hover:no-underline"
                title="Open the Slack publication this session is bound to"
              >
                publication →
              </Link>
            </>
          )}
        </div>
      )}

      {/* Filter by selected thread. Untagged events (legacy + spans
          that haven't been thread-stamped yet) are treated as primary —
          matches the bridge filter in handleSSEStream. */}
      {(() => null)()}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
      {view === "chat" ? (
        <ManagedSessionConversation
          afterTurns={transientActivity}
          composer={<>
          {/* Shared Backchat queue UI. Console has no reorder API, so no
              reorder callback → no drag handle / arrows. Steer is the OpenMA
              extension and only offered while running on steering agents. */}
          <QueueDock
            blocked={needsAction
              ? {
                  reason: "requires_action",
                  toolNames: blockedToolNames,
                  toolCallIds: activeTurn?.awaitingToolCallIds,
                  onInterrupt: interrupt,
                }
              : undefined}
            callbacks={{
              update: updateQueued,
              remove: async (messageId) => { await cancelQueued(messageId); },
              ...(agentSteering && status === "running" ? { steer: steerQueued } : {}),
            }}
            prompts={queueDockItems}
          />
          <SessionComposer
            interrupting={interrupting}
            placeholder={composerPlaceholder}
            notice={composerNotice}
            restoreDraft={composerRestore}
            onError={(error) => toast.error(error.message)}
            onStop={() => void interrupt()}
            onSubmit={async ({ text, files }) => {
              const rawFiles = files
                .map((file) => file.file)
                .filter((file): file is File => file instanceof File);
              await send(text, rawFiles);
            }}
            running={status === "running"}
            sending={sending}
          />
          </>}
          empty={hasTransientActivity ? transientActivity : undefined}
          activeTurnId={activeTurnId}
          sessionId={id}
          turns={canonicalTurns}
        />
      ) : (
        <TimelineView key={`${id ?? "session"}:${activeThreadId}`} events={timelineEvents} />
      )}
        </div>
        {resourcePanel && (
          <ResourcePanel
            panel={resourcePanel}
            onClose={() => setResourcePanel(null)}
          />
        )}
        {showFiles && id && (
          <FilesPanel sessionId={id} onClose={() => setShowFiles(false)} />
        )}
      </div>
      <TrajectoryViewerModal
        open={showTrajectory}
        onClose={() => setShowTrajectory(false)}
        sessionId={id ?? ""}
        trajectory={trajectory}
      />
    </div>
  );
}

/** Outcome chip rendered in the session header strip. Hidden while
 *  the trajectory is loading / errored / still running so we never
 *  paint an inaccurate state. The "running" outcome is intentionally
 *  squelched here — StatusPill already renders the live status. */

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  // Wireless tab marker: picked the ghost-pill option (bg-bg-surface)
  // over an underline or accent dot because the entire session-detail
  // surface drops outer dividers in this refactor — leaving a per-tab
  // underline behind would have re-introduced exactly the stacked-lines
  // look the page is trying to escape. Bold + brand text + a subtle
  // surface fill keeps the active state clearly distinguishable without
  // any line at all.
  return (
    <Button variant="ghost"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`inline-flex items-center justify-center px-3 py-2 min-h-11 sm:min-h-0 text-sm rounded-md my-1.5 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        active
          ? "bg-bg-surface text-brand font-semibold"
          : "text-fg-subtle hover:text-fg-muted hover:bg-bg-surface/60"
      }`}
    >
      {label}
    </Button>
  );
}

/** Tighter visual than ViewTab — sub-agent tabs typically need to fit
 *  more than the 2-3 view options. Smaller padding + horizontal scroll
 *  in the parent keeps long sub-agent rosters readable. */
function ThreadTab({
  label,
  active,
  onClick,
  depth = 0,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  depth?: number;
}) {
  return (
    <Button variant="ghost"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`py-1 min-h-11 sm:min-h-0 text-xs whitespace-nowrap rounded-md my-1 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] flex items-center gap-1 ${
        active
          ? "bg-bg-surface text-info font-semibold"
          : "text-fg-subtle hover:text-fg-muted hover:bg-bg-surface/60"
      }`}
      style={{ paddingLeft: `${0.75 + depth * 0.75}rem`, paddingRight: "0.75rem" }}
    >
      {/* Tree branch glyph for depth>0 — visual cue that this thread
          was spawned by another (rather than being a sibling of Main).
          Plain text (not a unicode-only flair) so it survives in both
          dark and light themes without needing a separate icon. */}
      {depth > 0 && <span className="text-fg-subtle">└</span>}
      <span>{label}</span>
    </Button>
  );
}

/**
 * Depth-indented thread tree. Root = sthr_primary (rendered as "Main");
 * children indented by parent_thread_id. DFS pre-order so the tree
 * reads top-to-bottom like a stack trace: parents above their children.
 *
 * Orphans (parent_thread_id pointing at a thread we don't know about
 * — possible mid-spawn race or stale snapshot) get re-parented to
 * sthr_primary so they stay visible instead of being hidden in a
 * dangling subtree.
 */
function ThreadTree({
  threads,
  activeThreadId,
  onSelect,
}: {
  threads: Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>;
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  const listFade = useScrollFade<HTMLDivElement>();
  const knownIds = new Set<string>(["sthr_primary", ...threads.map((t) => t.id)]);
  const childrenOf = new Map<string, typeof threads>();
  for (const t of threads) {
    const parent =
      t.parent_thread_id && knownIds.has(t.parent_thread_id)
        ? t.parent_thread_id
        : "sthr_primary";
    const arr = childrenOf.get(parent) ?? [];
    arr.push(t);
    childrenOf.set(parent, arr);
  }
  const flat: Array<{ id: string; label: string; depth: number }> = [
    { id: "sthr_primary", label: "Main", depth: 0 },
  ];
  const walk = (parentId: string, depth: number) => {
    const kids = childrenOf.get(parentId) ?? [];
    for (const k of kids) {
      flat.push({ id: k.id, label: k.agent_name ?? k.id.slice(0, 12), depth });
      walk(k.id, depth + 1);
    }
  };
  walk("sthr_primary", 1);
  const maxDepth = flat.reduce((m, n) => Math.max(m, n.depth), 0);
  // When the tree is shallow (one layer of workers under Main), keep
  // the original horizontal row for zero visual change vs Phase 3.
  // Deeper trees switch to a vertical stacked layout so the indentation
  // is actually readable.
  const isFlat = maxDepth <= 1;
  const containerClass = isFlat
    ? "pl-3 pr-4 flex items-center gap-1 shrink-0 overflow-x-auto"
    : `console-scroll-fade ${listFade.className} pl-3 pr-4 py-1 flex flex-col items-stretch gap-0 shrink-0 overflow-y-auto max-h-40`;
  return (
    <div ref={isFlat ? undefined : listFade.ref} role="tablist" aria-label="Threads" className={containerClass}>
      {flat.map((n) => (
        <ThreadTab
          key={n.id}
          label={n.label}
          depth={isFlat ? 0 : n.depth}
          active={activeThreadId === n.id}
          onClick={() => onSelect(n.id)}
        />
      ))}
    </div>
  );
}

function SessionDurationBadge({ events }: { events: Event[] }) {
  if (events.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const raw =
      (typeof e.ts === "string" ? e.ts : undefined)
      ?? (typeof (e as { occurred_at?: unknown }).occurred_at === "string"
        ? (e as { occurred_at: string }).occurred_at
        : undefined);
    if (!raw) continue;
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < first) first = t;
    if (t > last) last = t;
  }
  if (!Number.isFinite(first) || last <= first) return null;
  return (
    <Badge
      icon={<DurationIcon />}
      label={formatDuration(last - first)}
      title="Wall-clock from first to last event"
    />
  );
}

function RelativeTimeBadge({ iso }: { iso: string }) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (
    <Badge
      icon={<ClockIcon />}
      label={formatRelative(Date.now() - t)}
      title={new Date(iso).toLocaleString()}
    />
  );
}

function SessionTransientActivity({
  localPending,
  running,
  streams,
  thinkingStreams,
  toolInputStreams,
}: {
  localPending: string | null;
  running: boolean;
  streams: ReadonlyMap<string, string>;
  thinkingStreams: ReadonlyMap<string, string>;
  toolInputStreams: ReadonlyMap<string, { name?: string; partial: string }>;
}) {
  return (
    <div className="chat-turn-frame mx-auto w-full max-w-3xl min-w-0 space-y-4">
      {localPending ? (
        <EventRender
          event={{ type: "user.message", content: [{ type: "text", text: localPending }] } as Event}
        />
      ) : null}
      {Array.from(thinkingStreams.entries()).map(([id, text]) => (
        <Reasoning defaultOpen isStreaming key={`think-${id}`}>
          <ReasoningTrigger />
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      ))}
      {Array.from(toolInputStreams.entries()).map(([id, { name, partial }]) => (
        <Tool defaultOpen key={`tool-input-${id}`}>
          <ToolHeader
            state="input-streaming"
            toolName={name ?? "tool"}
            type="dynamic-tool"
          />
          <ToolContent>
            {partial ? (
              <div className="space-y-2 overflow-hidden">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Streaming input
                </h4>
                <div className="rounded-md bg-muted/50">
                  <CodeBlock code={partial} language="json" />
                </div>
              </div>
            ) : null}
          </ToolContent>
        </Tool>
      ))}
      {Array.from(streams.entries()).map(([id, text]) => (
        <Message from="assistant" key={`stream-${id}`}>
          <MessageContent>
            <Markdown>{text}</Markdown>
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-fg-subtle/50 align-middle" />
          </MessageContent>
        </Message>
      ))}
      {running
        && streams.size === 0
        && thinkingStreams.size === 0
        && toolInputStreams.size === 0 ? (
        <div aria-label="Agent is working" className="flex gap-1 py-2" role="status">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:300ms]" />
        </div>
      ) : null}
    </div>
  );
}


/**
 * Renders a single canonical event using ai-elements primitives. Replaces
 * the pre-migration EventBubble + StreamingBubble + ThinkingStreamingBubble
 * + ToolInputStreamingBubble quartet — the in-flight streaming bubbles are
 * now inlined where they're consumed (using Reasoning isStreaming, Tool
 * input-streaming state, and an assistant Message with a cursor) so this
 * function only needs to handle the canonical event shapes.
 *
 * Type mapping:
 *   user.message              → <Message from="user|system">  (system for wakeups)
 *   agent.message             → <Message from="assistant"> + <Markdown>
 *   agent.thinking            → <Reasoning> + <ReasoningContent>
 *   agent.{tool_use,custom_tool_use,mcp_tool_use} → <Tool> + <ToolHeader> + <ToolInput> + <ToolOutput>
 *   agent.tool_result (orphan only, paired ones folded into use above)
 *                             → <Tool state="output-available"> with only ToolOutput
 *   session.error             → red alert div  (no ai-elements equivalent)
 *   session.warning           → amber alert div  (same)
 *   anything else             → null  (timeline-only events that shouldn't appear in chat)
 */

function EventRender({
  event,
  pairedResult,
  modelErrorCause,
}: {
  event: Event;
  /**
   * The matching `agent.tool_result` (or `agent.mcp_tool_result`) for
   * an `agent.tool_use` (or `custom_tool_use` / `mcp_tool_use`) event,
   * when present in the same filtered list. Caller pre-pairs by id and
   * suppresses the orphan tool_result render. Lets the Tool card show
   * input + output in one collapsible block instead of two disconnected
   * bubbles.
   */
  pairedResult?: Event;
  /**
   * Upstream model error context for `session.error` events. The
   * SSE-delivered session.error payload only carries a generic
   * "No output generated. Check the stream for errors." message; the
   * actionable cause (rate limit, billing, model 4xx, etc.) lives on
   * the preceding `span.model_request_end` with `is_error=true`. Caller
   * walks the events array and pairs them, passing the looked-up cause
   * here so operators see the real reason inline without diving into
   * the timeline tab. Only meaningful when `event.type === "session.error"`.
   */
  modelErrorCause?: { error: string; model?: string };
}) {
  // OpenMA delivery / turn.queued is authoritative for queue UI.
  // CMA processed_at is never consulted here (stripped at ingest).
  const isPending = isQueuedSessionEvent(event);

  switch (event.type) {
    case "turn.queued":
    case "user.message": {
      // Wakeups synthesized by the schedule tool's onScheduledWakeup callback
      // also wire-type as user.message (per EventBase metadata convention),
      // but the user did NOT send them — visually distinguish so operators
      // don't get confused. metadata.harness === "schedule" + kind === "wakeup"
      // is the contract: see apps/agent/src/runtime/session-do.ts:onScheduledWakeup.
      const metadata = (event as { metadata?: { harness?: string; kind?: string; scheduled_at?: string } }).metadata;
      const isWakeup = metadata?.harness === "schedule" && metadata?.kind === "wakeup";
      const text = Array.isArray(event.content) ? event.content[0]?.text ?? "" : "";

      if (isWakeup) {
        // System-origin: left-aligned via from="system" (Message only
        // applies its right-aligned brand bubble for from="user"; anything
        // else lays out as plain assistant text). Layered on top is a
        // small info chip identifying the wakeup + the scheduled time
        // tooltip for traceability.
        const scheduledAt = metadata?.scheduled_at;
        return (
          <Message from="system">
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle mb-1">
              <span
                className="inline-flex items-center gap-1 rounded-full bg-info-subtle text-info px-2 py-0.5 font-medium text-xs"
                title={scheduledAt ? `Scheduled at ${scheduledAt}` : undefined}
              >
                <span aria-hidden>🕒</span>
                Scheduled wakeup
              </span>
            </div>
            <MessageContent className="rounded-2xl rounded-bl-sm px-4 py-3 bg-info-subtle text-info">
              {text}
            </MessageContent>
          </Message>
        );
      }

      // Queued: same muted/dim treatment as the optimistic localPending
      // bubble, with an explicit label above it. Live: default ai-elements
      // user bubble (right-aligned, bg-secondary aliased to bg-surface).
      const pendingOverride = "opacity-80";
      return (
        <Message from="user">
          {isPending && (
            <div className="text-xs text-fg-subtle text-right flex items-center justify-end gap-1">
              <span aria-hidden>⏳</span>
              <span>Queued…</span>
            </div>
          )}
          <MessageContent className={isPending ? pendingOverride : undefined}>
            {text}
          </MessageContent>
        </Message>
      );
    }

    case "agent.message": {
      const text = (Array.isArray(event.content) ? event.content : [])
        .map((b) => b.text)
        .join("");
      return (
        <Message from="assistant">
          <MessageContent>
            <Markdown>{text}</Markdown>
          </MessageContent>
        </Message>
      );
    }

    case "agent.thinking": {
      // Canonical reasoning block — keep it visible after streaming
      // finishes. <Reasoning> defaults closed unless isStreaming; we
      // pass defaultOpen={false} so committed thoughts don't push the
      // active conversation off-screen but stay one click away.
      const text = (event as { text?: string }).text ?? "";
      if (!text) return null;
      return (
        <Reasoning isStreaming={false} defaultOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      );
    }

    case "agent.tool_use":
    case "agent.custom_tool_use":
    case "agent.mcp_tool_use": {
      // All three use-types share the same shape (id + name + input);
      // MCP additionally carries mcp_server_name which we append to
      // the title so operators can tell built-in vs MCP at a glance.
      const mcpServerName =
        event.type === "agent.mcp_tool_use"
          ? (event as { mcp_server_name?: string }).mcp_server_name
          : undefined;
      const baseName = event.name ?? "tool";
      const title = mcpServerName ? `${baseName} (mcp · ${mcpServerName})` : baseName;
      // Result text — Tool's <ToolOutput> takes the raw value and will
      // either CodeBlock-stringify an object or render a string in a
      // CodeBlock. We pre-stringify content arrays since they're an
      // OMA-specific shape, not a JSON-friendly object.
      const rawContent = pairedResult
        ? (pairedResult as { content?: unknown }).content
        : undefined;
      const output: unknown = rawContent === undefined
        ? undefined
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent, null, 2);
      // is_error is set by the agent runtime when a tool call failed
      // (bash non-zero exit + stderr surfaced, mcp tool returned an
      // error envelope, _finalizeStaleTurns injected an abort placeholder
      // for DO-eviction recovery, etc.). When present we route the same
      // payload through ToolOutput.errorText so the Tool block renders
      // in destructive styling, and badge to 'output-error' so the
      // header pill shows Failed instead of Completed. Without this,
      // bash returning "Sandbox container failed to start after 10
      // attempts..." looked identical to a successful run.
      const isError = pairedResult
        ? Boolean((pairedResult as { is_error?: boolean }).is_error)
        : false;
      const errorText = isError
        ? (typeof output === "string" ? output : JSON.stringify(output ?? null))
        : undefined;
      const state = pairedResult
        ? (isError ? "output-error" : "output-available")
        : "input-available";
      return (
        <Tool>
          <ToolHeader type="dynamic-tool" toolName={title} state={state} />
          <ToolContent>
            <ToolInput input={event.input ?? {}} />
            <ToolOutput
              output={isError ? undefined : output}
              errorText={errorText}
            />
          </ToolContent>
        </Tool>
      );
    }

    case "agent.tool_result":
    case "agent.mcp_tool_result": {
      // Orphan tool_result — caller couldn't pair it with a tool_use
      // (race / out-of-order delivery, or recovery-injected placeholder).
      // Render a degenerate Tool with output-only so the visual is still
      // a "tool" card (matching the rest of the timeline) but the header
      // signals it stands alone.
      const rawContent = (event as { content?: unknown }).content;
      const output: unknown = rawContent === undefined
        ? undefined
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent, null, 2);
      return (
        <Tool>
          <ToolHeader
            type="dynamic-tool"
            toolName="tool result (unpaired)"
            state="output-available"
          />
          <ToolContent>
            <ToolOutput output={output} errorText={undefined} />
          </ToolContent>
        </Tool>
      );
    }

    case "session.error":
      return (
        <div className="max-w-2xl bg-danger-subtle rounded-lg px-4 py-2.5 text-sm text-danger">
          <div>Error: {event.error}</div>
          {modelErrorCause && (
            <div className="mt-1.5 pt-1.5 text-sm opacity-90">
              <span className="font-medium">Cause</span>
              {modelErrorCause.model && (
                <span className="ml-1 font-mono opacity-75">({modelErrorCause.model})</span>
              )}
              : {modelErrorCause.error}
            </div>
          )}
        </div>
      );

    case "session.warning":
      return (
        <div className="max-w-2xl bg-warning-subtle rounded-lg px-4 py-2.5 text-sm text-warning">
          <div className="font-medium mb-0.5">Warning ({String(event.source ?? "")})</div>
          <div>{String(event.message ?? "")}</div>
        </div>
      );

    default:
      return null;
  }
}

/** True only for a missing session (404 / not_found_error); network and 5xx
 *  errors stay on the generic error path. */
export function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === "not_found_error");
}

export function SessionNotFound({ id }: { id?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8" data-testid="session-not-found">
      <EmptyState
        size="lg"
        kind="session"
        title="Session not found"
        body={
          <>
            No session with id <code className="font-mono">{id}</code> exists in this
            workspace. It may have been deleted, or the link is wrong.
          </>
        }
        action={
          <Link to="/sessions" className="text-sm text-brand underline-offset-2 hover:underline">
            Back to Sessions
          </Link>
        }
      />
    </div>
  );
}
