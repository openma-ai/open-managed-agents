import { UNKNOWN_TOOL_RESULT_TEXT } from "@open-managed-agents/session-runtime-contract/history";
import { DurableObject } from "cloudflare:workers";
import { assertRuntimeAgentSnapshot, resolvePinnedSubagent, resolveThreadAgentSnapshot, resolveSubagentSkillReminders, resolveRuntimeSkillFiles } from "./multiagent";
import { SessionSubagents, type SubagentTurnInput, type SubagentTurnResult } from "@open-managed-agents/session-subagents";
import { cloudflareSubagentThreadId, cloudflareSubagentWireEvents } from "./subagents";
import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import { nanoid } from "nanoid";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { parseCronExpression } from "cron-schedule";
import type { Env } from "@open-managed-agents/shared";
import {
  logWarn,
  log,
  generateEventId,
  createMonotonicClock,
  generateOutcomeId,
  classifyExternalError,
  AuthError,
  PaymentRequiredError,
  admitViaSessionAdmissionHook,
  SessionAdmissionDeniedError,
  ConfigError,
  ModelError,
  TransientInfraError,
  fileR2Key,
} from "@open-managed-agents/shared";
import {
  CfDoStreamRepo,
  CfDoEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/cf-do";
import type {
  EventLogRepo,
  QueueInputRow,
  StreamRepo,
} from "@open-managed-agents/event-log";
import { recoverInterruptedState as runRecovery } from "./recovery";
import {
  RuntimeAdapterImpl,
  runAgentTurn,
  recoverAgentTurn,
  clearTurnRecoveryCount,
  TurnAborted,
  isTurnCancellationError,
  linkAbort,
  openTurnMarker,
  planTurnFailure,
  reportTurnFailure,
  type RuntimeAdapter,
  type TurnRuntimeAgent,
  type RecoveryDecision,
  type PartialStream,
} from "@open-managed-agents/session-runtime";
import { SessionExecutionHost, SessionSandboxRuntime } from "@open-managed-agents/session-runtime";
import { applyCapCliPlaceholderEnvironment } from "./cap-placeholder-env";
import { interruptedTurnStopReason } from "@open-managed-agents/session-runtime-contract";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionStore,
} from "@open-managed-agents/session-runtime-sql/coordination";
import {
  decideExpiredExecution,
  decideLeaseRenewal,
  decideRecoveryFromCanonicalStream,
  evaluateCoordinationPolicy,
  type ActiveTurnRecord,
  type CanonicalTurnEvidence,
  type CoordinationAction,
  type ExecutionLeaseRecord,
  type QueuedInputRecord,
  type ScheduleWakeRecord,
  consumeSessionInputs,
  takeQueuedSteeringInputs,
  type SessionExecution,
  type SessionExecutionFence,
} from "@open-managed-agents/session-runtime-contract/coordination";
import {
  settleOnlyReason,
  settleOnlyRejectMessage,
  type SettleOnlyReason,
} from "@open-managed-agents/session-runtime-contract/settle-events";
import { encodeRuntimeHistoryEvent, encodeRuntimeSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlSessionExecutionContextSource } from "@open-managed-agents/session-runtime-sql/context";
import type { SessionBudgetGate } from "@open-managed-agents/domain/sessions";
import {
  activeModelCardPricing,
  applyModelEgressRequest,
  budgetReachedStopEvents,
  createSessionUsageMeter,
  MODEL_EGRESS_ACTION_REQUIRED,
  openSessionBudgetGate,
  parseModelEgressRequest,
  reportModelSpanUsage,
  reportSessionUsage,
  sessionUsageSnapshot,
  sumModelSpanUsage,
  type SessionUsageMeter,
  type SessionUsageReport,
} from "@open-managed-agents/managed-agents-application";
import { sessionDoUsageStore } from "./session-usage-store";
import { createRuntimeRoomRelay } from "./runtime-room-relay";
import { cfWorkersAiToMarkdown } from "@open-managed-agents/markdown";
import { isSpecEvent } from "@open-managed-agents/api-types";
import type {
  EnvironmentConfig,
  CredentialConfig,
  SessionEvent,
  UserMessageEvent,
  UserInterruptEvent,
  UserToolConfirmationEvent,
  UserCustomToolResultEvent,
  UserDefineOutcomeEvent,
  AgentMessageEvent,
  AgentToolUseEvent,
  SystemUserMessagePendingEvent,
  SystemUserMessagePromotedEvent,
  SystemUserMessageCancelledEvent,
} from "@open-managed-agents/shared";
import type { HarnessContext, HarnessInterface, HistoryStore, SandboxExecutor, ProcessHandle, FileResolver } from "../harness/interface";
import {
  supportsManagedWorkspaceLifecycle,
  supportsSessionOutputMount,
  withSandboxExecutionGuard,
} from "@open-managed-agents/sandbox";
import { HarnessLease, resolveHarness } from "../harness/registry";
import { composeSystemPrompt } from "../harness/platform-guidance";
import { resolveRepositoryLocalPath } from "../harness/acp-proxy-delivery";
import {
  createPiModelRuntime,
  toAiSdkLanguageModel,
} from "../harness/pi-provider";
import {
  bindStoredModelCardCredentials,
  delegationCredentials,
  type ResolvedModelCardCredentials,
} from "../harness/model-card-credentials";
import { resolveWorkspaceModelCredentials } from "@open-managed-agents/model-cards-store";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { extractTextFromContent } from "@open-managed-agents/shared";
import {
  runOutcomeSupervisor,
  type ActiveOutcomeState,
  type OutcomeEvaluationRecord,
} from "./outcome-supervisor";
import { buildTools, disposeTools, ToolFailureError } from "../harness/tools";
import { resolveProxiedToolCall } from "../harness/tool-proxy";
import { MemoryStoreService } from "@open-managed-agents/memory-store";
import { buildCfServices, buildCfTenantDbProvider, getCfServicesForTenant } from "@open-managed-agents/services";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { ensureEnvironmentPackages } from "@open-managed-agents/sandbox";
import {
  resolveSkills,
  resolveCustomSkills,
  resolveCustomSkillMounts,
  type SkillMountDescriptor,
  getSkillFiles,
  getSkillFilesFromManagedSource,
  mountSkillFiles,
} from "../harness/skills";
import {
  agentUsesAssemblySkillMount,
  resolveSkillAssemblyConfig,
  skillMountsShouldFetchBodies,
} from "../harness/assembly/skill-config";
import { resolveAppendablePrompts } from "./appendable-prompts";
import { createCfBrowserHarness } from "@open-managed-agents/browser-harness/cf";
import type { BrowserHarness, BrowserBillingHook, BrowserSession } from "@open-managed-agents/browser-harness";
import { SqliteHistory, InMemoryHistory, INTERRUPTED_TOOL_RESULT_TEXT } from "./history";
import type { CloudflareSandboxImage } from "./sandbox";
import { createSessionSandbox } from "./session-sandbox-adapters";
import type { PortsSessionSandbox } from "@open-managed-agents/session-runtime";
import {
  loadManagedSessionResources,
  mountResources,
} from "./resource-mounter";
import { createSandboxWarmupFailureEvent } from "./warmup-failure-event";
import {
  createSessionWakeups,
  type SessionWakeupApplication,
  type SessionWakeupDelivery,
} from "@open-managed-agents/session-wakeup";
import {
  CloudflareSessionWakeupScheduler,
} from "@open-managed-agents/session-wakeup-cloudflare";

interface SessionInitParams {
  agent_id: string;
  environment_id: string;
  title: string;
  session_id?: string;
  tenant_id?: string;
  vault_ids?: string[];
  /**
   * Pre-fetched tenant config snapshots passed in by the main worker. Lets
   * SessionDO avoid reading CONFIG_KV with `t:tenantId:...` keys directly —
   * which is wrong when the SessionDO worker is bound to a different KV
   * namespace than the writing worker (e.g. shared sandbox-default serving
   * both prod and staging mains). Optional for backward compat: when absent,
   * SessionDO falls back to its own CONFIG_KV.
   */
  agent_snapshot?: AgentConfig;
  environment_snapshot?: EnvironmentConfig;
  /**
   * Pre-fetched credentials grouped by vault id. Mirrors what SessionDO would
   * otherwise read via `CONFIG_KV.list({ prefix: t:tenantId:cred:vaultId: })`.
   */
  vault_credentials?: Array<{ vault_id: string; credentials: CredentialConfig[] }>;
  /**
   * Generic per-event POST hooks. Each hook gets the canonical SessionEvent
   * verbatim on every broadcast. Use for provider-specific side effects
   * (Linear AgentActivity mirror, Slack thread mirror, observability
   * pipelines). SessionDO is provider-agnostic — the main worker sets
   * these up at /init based on session metadata.
   */
  event_hooks?: Array<{
    name: string;
    url: string;
    auth?: string;
  }>;
  /**
   * Pre-flight events to seed the session event stream at /init time.
   * Used by the main worker to surface warnings (e.g. failed pre-session
   * credential refreshes) the user should see in the console without
   * hard-failing session start. Each event is appended to SQLite + WS-broadcast
   * + fan-out to event_hooks, in order, before /init returns.
   */
  init_events?: SessionEvent[];
  /**
   * Operator catalog image for this session's sandbox, resolved by the main
   * worker from SANDBOX_IMAGES (`_oma.sandbox_image` alias -> container
   * binding + workdir). Absent: the default `SANDBOX` container.
   */
  sandbox_image?: CloudflareSandboxImage | null;
}

/**
 * Pending tool call data stored in session metadata so that
 * tool confirmation/custom tool result events can resume execution.
 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Persistent session state managed by Agent's setState/state system.
 * Automatically persisted to SQLite and broadcast to WebSocket clients.
 */
/**
 * `ActiveOutcomeState` (one slot — only one outcome supported at a time,
 * per AMA spec) and `OutcomeEvaluationRecord` (the aggregate row written
 * to `state.outcome_evaluations[]` on every terminal verdict) are
 * defined in outcome-supervisor.ts so the supervisor unit-test fixture
 * has a single source of truth. Re-exported here as the local aliases
 * the SessionState below uses.
 */
type ActiveOutcome = ActiveOutcomeState;
type PersistedOutcomeEvaluation = OutcomeEvaluationRecord;

interface SessionState {
  agent_id: string;
  environment_id: string;
  /** See SessionInitParams.sandbox_image. */
  sandbox_image?: CloudflareSandboxImage | null;
  session_id: string;
  tenant_id: string;
  title: string;
  /**
   * Stored only as a back-compat read for sessions written before status
   * became derived. New code MUST NOT write to this field. The runtime
   * status comes from `deriveStatus()`, which checks the in-memory
   * inflight-turn hint counter (mirrored from D1's `sessions.turn_id`
   * via the RuntimeAdapter callbacks) + `terminated_at` for the destroy
   * gate. See docs/contribute/recovery-and-idempotency.mdx for the
   * rationale.
   */
  status?: "idle" | "running" | "terminated";
  /** ms timestamp when /destroy ran. Replaces the persistent `terminated`
   *  status — the only state value that needed to survive in storage; the
   *  rest are derivable from cf_agents_runs row presence. */
  terminated_at: number | null;
  /**
   * Session-wide token totals. Kept in sync with the per-thread breakdown
   * in `thread_usage` so existing reads (POST /usage echo, /full-status)
   * keep working without a refactor at every call site. New code should
   * prefer `thread_usage` for per-thread granularity (AMA SessionThread
   * .usage shape).
   */
  input_tokens: number;
  output_tokens: number;
  /**
   * Per-thread cumulative usage. Keyed by session_thread_id
   * ("sthr_primary" or sub-agent "sthr_*"). Mirrors the AMA
   * BetaManagedAgentsSessionThreadUsage shape minus the cache_creation
   * sub-breakdown by lifetime (we only have one bucket today).
   * Optional: pre-thread-usage sessions read as `undefined` and the
   * serializer falls back to null; new sessions populate it.
   */
  thread_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }
  >;
  /** Session egress meter total (picodollars, integer string). Written only
   *  at model egress while a session budget is active; seeds the next gate. */
  list_cost_pico?: string;
  vault_ids: string[];
  pending_tool_calls: PendingToolCall[];
  /** Lane → ms of the last retries_exhausted settle. Persisted (DO state)
   *  so the local-pending fallback still holds pre-exhausted inputs after a
   *  DO eviction. Cleared once the lane runs a new execution and no
   *  pre-exhausted queued input row remains. */
  exhausted_at_by_lane?: Record<string, number>;
  outcome: ActiveOutcome | null;
  outcome_iteration: number;
  /**
   * Phase 4: AMA-aligned aggregate of every terminal `span.outcome_evaluation_end`
   * for this session. Returned as-is by GET /v1/sessions/:id under
   * `outcome_evaluations`. Sequential outcomes (each kicked off by a fresh
   * `user.define_outcome`) append here in iteration order.
   */
  outcome_evaluations?: PersistedOutcomeEvaluation[];
  /**
   * Tenant config snapshots provided at /init by main worker. Used by
   * getAgentConfig/getEnvConfig/getVaultCredentials so SessionDO doesn't
   * need to read tenant-scoped CONFIG_KV keys directly. Optional —
   * absence triggers KV fallback for backward compat with prod.
   */
  agent_snapshot?: AgentConfig;
  environment_snapshot?: EnvironmentConfig;
  vault_credentials?: Array<{ vault_id: string; credentials: CredentialConfig[] }>;
  /** Per-event POST hooks. See SessionInitParams.event_hooks. Currently
   *  unused in production — Linear's auto-mirror was removed in M7 — but
   *  the wiring stays so the harness fanout machinery stays compilable. */
  event_hooks?: Array<{ name: string; url: string; auth?: string }>;
  /**
   * One-shot guard: harness.onSessionInit must run exactly once, before the
   * first user-message-driven turn. Set true after the call lands so resumes
   * / restarts don't re-inject reminders (which would write duplicate cached
   * prefix bytes and bust the cache).
   */
  session_init_done?: boolean;
  /**
   * Wall-clock create timestamp (Unix ms). Used by the hybrid-billing
   * `session_alive_seconds` emit at terminate time. Set lazily on /init —
   * pre-billing sessions read undefined and the emit is skipped (the
   * cost would be 0 cents anyway after the rate cap).
   */
  created_at_ms?: number;
  /**
   * Idempotency guard for the session_alive_seconds emit. Set once at
   * terminate; the second terminate call (DO restart hits the same
   * /destroy) checks this and skips the duplicate emit.
   */
  session_alive_billed?: boolean;
}

const INITIAL_SESSION_STATE: SessionState = {
  agent_id: "",
  environment_id: "",
  session_id: "",
  tenant_id: "default",
  title: "",
  terminated_at: null,
  input_tokens: 0,
  output_tokens: 0,
  vault_ids: [],
  pending_tool_calls: [],
  outcome: null,
  outcome_iteration: 0,
};

/**
 * SessionDO is the "meta-harness" — it owns the event log, WebSocket
 * connections, and runtime primitives. It resolves a concrete harness
 * via the registry and delegates message processing to it, without
 * knowing anything about the harness implementation.
 *
 * Sandbox lifecycle: one sandbox per session, created on first event,
 * reused across turns, destroyed on session delete/terminate.
 */

// ── Constants inherited from cf-agents v0.11.2 schema ──────────────────
//
// We replaced `extends Agent` with `extends DurableObject` and reimplemented
// the small surface SessionDO actually used (state, schedule+alarm). Phase 3
// (this codebase) further dropped the runFiber/keepAlive primitives in favor
// of the unified RuntimeAdapter (begin/end on the shared `sessions` table).
// The cf_agents_state + cf_agents_schedules table NAMES are kept verbatim
// so existing prod DOs migrate transparently — schedule rows in flight at
// deploy time keep their SQL rows readable by the new code path. The
// cf_agents_runs table was dropped in Phase 4; orphan markers now live on
// `sessions.turn_id`. See _ensureCfAgentsSchema() below.
const STATE_ROW_ID = "cf_state_row_id";
/**
 * Durable execution lease cadence. A running turn owns a lease for 90s and
 * renews it every 30s through the shared renew path (SessionExecutionHost
 * heartbeat + the alarm's policy renewal). The alarm is not itself the lease
 * authority: if it is lost, a replacement DO reclaims after expiry.
 */
const KEEP_ALIVE_INTERVAL_MS = 30_000;
const EXECUTION_LEASE_TTL_MS = KEEP_ALIVE_INTERVAL_MS * 3;
/** Wake promptly when a queue row / claimable execution exists. */
const QUEUE_WAKE_DELAY_MS = 1_000;
/** Admission must arm the alarm before the synchronous drain can be lost. */
const ENQUEUE_WAKE_DELAY_MS = 1;
/** Recovery failures are retained and retried with capped exponential backoff. */
const RECOVERY_BACKOFF_BASE_MS = 1_000;
const RECOVERY_BACKOFF_MAX_MS = 60_000;
/** A drain/claim that makes no progress backs off 1s, 2s, … capped at 5 min. */
const QUEUE_DRAIN_BACKOFF_BASE_MS = 1_000;
const QUEUE_DRAIN_BACKOFF_MAX_MS = 5 * 60_000;
/** Blocked/held queue rows get a slow safety net instead of a hot wake. */
const BLOCKED_QUEUE_SAFETY_WAKE_MS = 5 * 60_000;
/** Bounded wait for an aborted turn to unwind tools before the interrupt is stamped. */
const INTERRUPT_GRACE_MS = 2_000;
const HUNG_SCHEDULE_TIMEOUT_SECONDS = 30;

/**
 * Low-noise structured lifecycle log: exactly one `console.log` JSON line per
 * transition (`sdo.<event>`). Keep payloads flat and small so `wrangler tail`
 * and log-search stay cheap; never call this from a tight loop or on every
 * heartbeat tick (the `alarm.fired` line already marks each wake).
 */
function sdoLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ msg: `sdo.${event}`, ...fields }));
  } catch {
    // Never let a logging failure break a turn.
    console.log(`{"msg":"sdo.${event}"}`);
  }
}

/** Next cron fire strictly after `nowMs`. `getNextDate` can return the current
 * tick on a boundary; a due row makes `_multiplexAlarm` re-arm at now+1ms
 * and the handler can invoke the callback again immediately. */
function nextCronFireSeconds(cron: string, nowMs = Date.now()): number {
  const expr = parseCronExpression(cron);
  let anchor = new Date(nowMs);
  let nextSec = Math.floor(expr.getNextDate(anchor).getTime() / 1000);
  const nowSec = Math.floor(nowMs / 1000);
  for (let guard = 0; nextSec <= nowSec && guard < 512; guard++) {
    anchor = new Date((nextSec + 1) * 1000);
    nextSec = Math.floor(expr.getNextDate(anchor).getTime() / 1000);
  }
  if (nextSec <= nowSec) {
    throw new Error(`Could not compute a future cron fire time for ${cron}`);
  }
  return nextSec;
}

export class SessionDO extends DurableObject<Env> {
  // ── cf-agents-replacement state (see _ensureCfAgentsSchema below) ─────
  private _state: SessionState | undefined;
  private _initialized = false;
  // Lazy-built runtime adapter (the unified one Node also uses). Built
  // on first turn so we can read this.state.tenant_id, which isn't set
  // until /init writes the row. _runtimeAdapter is the cached adapter
  // instance scoped to this DO's session.
  private _runtimeAdapter: RuntimeAdapter | null = null;
  private readonly _primaryHarness = new HarnessLease();
  private _managedProjectionChain: Promise<void> = Promise.resolve();
  private readonly _wakeupScheduler: CloudflareSessionWakeupScheduler;
  private readonly _wakeups: SessionWakeupApplication;

  /**
   * Set of turn ids currently in flight in THIS DO isolate.
   * Maintained via RuntimeAdapter.hintTurnInFlight / hintTurnEnded
   * callbacks (port contract; see ports.ts:111+). Each entry's
   * lifetime is exactly one runAgentTurn invocation.
   *
   * Sole consumer: `_checkOrphanTurns` filters out `o.turn_id ∈
   * _activeTurnIds` — exact match like Node SessionStateMachine's
   * `if (o.turn_id === this.activeTurnId) continue` (machine.ts:183).
   * Replaces a defensive `_inflightTurnHints + 90s grace period`
   * filter in the orphan check that was needed because earlier the
   * shell had no handle on the turnId minted inside runAgentTurn —
   * the hint callbacks now carry it (port v2).
   *
   * `deriveStatus()` also reads `.size > 0` — single source of truth
   * for "is anything running" replaces the prior `_inflightTurnHints`
   * counter.
   *
   * Lost on eviction; cold-start sees empty set, so a D1 row from a
   * dead incarnation is correctly identified as orphan.
   */
  private _activeTurnIds = new Set<string>();

  /**
   * Per-step model request start timestamps, keyed by the
   * `span.model_request_start` event id. Diagnostics only: the matching
   * `span.model_request_end` logs the elapsed duration. Bounded so a lost
   * end event (isolate reset) cannot grow the map without limit.
   */
  private readonly _modelRequestStartedAt = new Map<string, number>();

  /**
   * Wall-clock ms at which THIS DO instance (isolate) was constructed.
   * `_finalizeStaleTurns` uses it to distinguish a turn started by a
   * previous incarnation (turn_started_at < this) from a turn that just
   * called beginTurn in this incarnation but hasn't reached the
   * `_activeTurnIds.add` yet (the D1-write / in-memory-set race the old
   * 30s wall-clock grace period was working around).
   *
   * Why this matters: after an isolate reset mid-turn, `turn_started_at`
   * can be only a few seconds old. The old age-only grace period made
   * the first cold-start pass skip it; if that pass came from fetch()
   * (fire-and-forget) and the keep-alive alarm was lost with the
   * isolate, nothing ever ran a second pass and the session stayed
   * status_running forever. A turn that started before this instance
   * existed cannot be ours, regardless of its age.
   */
  private readonly _instanceStartedAt = Date.now();

  /**
   * Cold-start flush guard. The first fetch() after DO activation
   * triggers _finalizeStaleTurns() once; subsequent fetch()es skip it
   * (alarm() takes over for ongoing detection). false → not yet done.
   * Set to true synchronously at fetch() entry so concurrent first
   * requests don't double-fire.
   */
  private _coldStartFlushDone = false;

  /**
   * Synchronous re-entry guard for drainEventQueue, keyed by
   * session_thread_id. Single-isolate JS single-thread makes Set add/has
   * a true mutex within the same thread. Cross-thread drains run
   * concurrently — drainEventQueue('sthr_primary') and
   * drainEventQueue('sthr_xyz') don't block each other; that's the
   * whole point of per-thread parallelism.
   *
   * Distinct from _activeTurnIds: _draining is the *entry guard*,
   * checked synchronously before any await. _activeTurnIds is the
   * *active set*, populated asynchronously after beginTurn returns.
   * Both signals together cover the gap between "drain entered" and
   * "turn registered via hintTurnInFlight".
   */
  private _draining = new Set<string>();

  /**
   * Per-thread abort controllers — replaces the single
   * `currentAbortController` we used pre-thread-aware. Set by
   * processUserMessage / sub-agent runs at turn start, cleared at
   * turn end. user.interrupt with `session_thread_id` uses this to
   * abort exactly that thread's in-flight turn without touching
   * siblings (AMA spec semantics). /destroy iterates the map.
   *
   * Distinct from _activeTurnIds — that one is for orphan
   * detection (keyed by turnId, the runAgentTurn nanoid), this one
   * is for caller-initiated abort (keyed by session_thread_id, the
   * AMA-spec thread id the SDK speaks). The two signals never
   * overlap; merging would force one consumer to scan the other's
   * key shape.
   */
  private _threadAbortControllers = new Map<string, AbortController>();
  /** Threads whose aborted turn already got its status_idle from the
   *  user.interrupt handler; the turn's catch-all idle must not repeat it. */
  private _interruptIdleOwned = new Set<string>();
  /** Resolves when the turn owning the thread's current AbortController has fully settled (finally ran). */
  private _turnSettled = new Map<AbortController, Promise<void>>();


  /** Execution authority lives in the tenant D1 outbox. The DO only owns a
   * lease while running one lane and never uses this map as durable state. */
  private _executionStore: SqlSessionExecutionStore | null = null;
  private _executionStoreReady: Promise<void> | null = null;
  private readonly _executionOwnerId = `cf-session:${nanoid()}`;
  /**
   * Ephemeral status mirror for a central execution lease.  The D1
   * execution row is the authority; this set only lets the synchronous DO
   * status endpoint report `running` while the host is awaiting a claim or
   * executing a lease.  It is deliberately cleared in a finally block and
   * is never consulted for recovery or fencing decisions.
   */
  private _executionActiveLanes = new Set<string>();
  private _executionFences = new Map<string, SessionExecutionFence>();
  /** Lane → ms of the last retries_exhausted settle (in-memory; hold for
   *  local-pending inputs admitted after that settle). */

  private _executionParentLane = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._ensureCfAgentsSchema();
    this._loadStateFromSql();
    this._wakeupScheduler = new CloudflareSessionWakeupScheduler({
      backend: {
        create: async (input) => {
          const record = await this.schedule(
            input.when,
            input.callback,
            input.payload,
          );
          return record;
        },
        list: () => this.getSchedules(),
        cancel: (input) => this.cancelSchedule(input.id),
      },
    });
    this._wakeups = createSessionWakeups({
      sessions: {
        find: async (input) => {
          const scope = this._wakeupScope();
          if (
            input.workspaceId !== scope.workspaceId ||
            input.sessionId !== scope.sessionId
          ) return { type: "not_found" };
          return {
            type: "found",
            session: {
              id: scope.sessionId,
              status: this.deriveStatus(),
            },
          };
        },
      },
      scheduler: this._wakeupScheduler,
      events: {
        wakeupScheduled: async ({ wakeup }) => {
          this.persistAndBroadcastEvent({
            type: "span.wakeup_scheduled",
            id: wakeup.causalEventId,
            schedule_id: wakeup.id,
            fire_at: wakeup.kind === "one_shot" ? wakeup.fireAt : undefined,
            cron: wakeup.kind === "cron" ? wakeup.cron : undefined,
            kind: wakeup.kind,
          } as unknown as SessionEvent);
        },
        wakeupFired: async ({ wakeup, firedAt }) => {
          const event: UserMessageEvent = {
            type: "user.message",
            content: [{ type: "text", text: wakeup.prompt }],
            parent_event_id: wakeup.causalEventId,
            metadata: {
              harness: "schedule",
              kind: "wakeup",
              wakeup_kind: wakeup.kind,
              scheduled_at: wakeup.scheduledAt,
              fired_at: firedAt,
            },
          };
          this.ensureSchema();
          this._stampEventForPending(event);
          if (this.enqueueQueueInputIfNew(event)) {
            this._broadcastPendingFrame(event, "sthr_primary");
          }
          try {
            await this.schedule(5, "recoverEventQueue" as keyof this);
          } catch {}
          this.drainEventQueue();
        },
      },
      clock: { now: () => new Date() },
      ids: { nextEventId: () => generateEventId() },
    });
    this._initialized = true;
  }

  /** Compatibility scope for v0 DO-level callers that schedule before /init. */
  private _wakeupScope(): { workspaceId: string; sessionId: string } {
    return {
      workspaceId: this.state.tenant_id || "default",
      sessionId: this.state.session_id || "__legacy_uninitialized_session__",
    };
  }

  /** Build a tenant-scoped KV key */
  private tk(...parts: string[]): string {
    return `t:${this.state.tenant_id}:${parts.join(":")}`;
  }

  /**
   * Resolve an agent config. Prefers the snapshot passed at /init; falls back
   * to a tenant-scoped CONFIG_KV read for backward compat or for agentIds that
   * weren't pre-snapshotted (e.g. sub-agents). Returns null on miss.
   *
   * Why this exists: sandbox-default's CONFIG_KV binding may point at a
   * different namespace than the worker that wrote the agent (e.g. shared
   * sandbox serving both prod-main and staging-main). Snapshots flow the
   * data through the init body and avoid the KV cross-binding issue.
   */
  private async getAgentConfig(agentId: string): Promise<AgentConfig | null> {
    // Integration resume writes a refreshed snapshot through sessions.update()
    // while the session is idle. The next turn must read that row: the DO
    // copy taken at /init would keep the publish-time MCP wiring forever.
    if (
      agentId === this.state.agent_id &&
      this.state.session_id &&
      this.state.tenant_id
    ) {
      let reloadedSnapshot: unknown;
      try {
        const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
        const session = await services.sessions.get({
          tenantId: this.state.tenant_id,
          sessionId: this.state.session_id,
        });
        reloadedSnapshot = session?.agent_snapshot;
      } catch (err) {
        logWarn(
          { op: "session_do.agent_snapshot_reload", session_id: this.state.session_id, err },
          "failed to reload agent snapshot; using the DO copy",
        );
      }
      if (reloadedSnapshot != null) {
        assertRuntimeAgentSnapshot(reloadedSnapshot);
        if (JSON.stringify(this.state.agent_snapshot) !== JSON.stringify(reloadedSnapshot)) {
          this.setState({ ...this.state, agent_snapshot: reloadedSnapshot });
        }
        return reloadedSnapshot;
      }
    }
    if (this.state.agent_snapshot && agentId === this.state.agent_id) {
      assertRuntimeAgentSnapshot(this.state.agent_snapshot);
      return this.state.agent_snapshot;
    }
    return null;
  }

  private async getThreadAgentConfig(threadId: string): Promise<AgentConfig | null> {
    if (threadId === "sthr_primary") return this.getAgentConfig(this.state.agent_id);
    const cached = this.threads.get(threadId)?.agentConfig;
    if (cached) {
      assertRuntimeAgentSnapshot(cached);
      return cached;
    }
    const row = [...this.ctx.storage.sql.exec<{ agent_id: string }>(
      "SELECT agent_id FROM threads WHERE id = ? LIMIT 1", threadId,
    )][0];
    if (!row || !this.state.agent_snapshot) throw new Error("Pinned child lane snapshot is unavailable");
    const agent = resolveThreadAgentSnapshot(this.state.agent_snapshot, row.agent_id);
    this.threads.set(threadId, { agentId: row.agent_id, agentConfig: agent });
    return agent;
  }

  /** Same idea as getAgentConfig but for environments. */
  private async getEnvConfig(envId: string): Promise<EnvironmentConfig | null> {
    if (this.state.environment_snapshot && envId === this.state.environment_id) {
      return this.state.environment_snapshot;
    }
    const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
    const row = await services.environments.get({
      tenantId: this.state.tenant_id,
      environmentId: envId,
    });
    return row ? toEnvironmentConfig(row) : null;
  }

  /**
   * Resolve all credentials for the listed vaults. Prefers the pre-fetched
   * snapshot from /init; falls back to KV list/get loops if absent.
   */
  private async getVaultCredentials(
    vaultIds: string[],
  ): Promise<CredentialConfig[]> {
    const fromSnapshot = this.state.vault_credentials;
    if (fromSnapshot) {
      const snapshotMap = new Map(fromSnapshot.map((v) => [v.vault_id, v.credentials]));
      const out: CredentialConfig[] = [];
      for (const vaultId of vaultIds) {
        const creds = snapshotMap.get(vaultId);
        if (creds) out.push(...creds);
      }
      return out;
    }
    // Fallback: KV list/get loop. Mirrors the original logic at the call sites.
    const out: CredentialConfig[] = [];
    for (const vaultId of vaultIds) {
      const credList = await this.env.CONFIG_KV.list({ prefix: this.tk("cred", vaultId) + ":" });
      for (const k of credList.keys) {
        const credData = await this.env.CONFIG_KV.get(k.name);
        if (!credData) continue;
        try {
          out.push(JSON.parse(credData) as CredentialConfig);
        } catch (err) {
          // skip malformed — but flag because vault data corruption silently
          // disables outbound auth injection for whatever this credential covered.
          logWarn(
            { op: "session_do.vault_cred_parse", session_id: this.state.session_id, vault_id: vaultId, kv_key: k.name, err },
            "skipping malformed credential entry",
          );
        }
      }
    }
    return out;
  }

  // observability stub kept as a defensive no-op slot — was set to null when
  // we used cf-agents Agent (which auto-instantiated an observability sink that
  // tripped SpanParent I/O isolation errors in vitest-plugin). After
  // dropping cf-agents the field is unused but harmless to keep so any
  // straggler `this.observability?.foo()` call elsewhere stays a no-op.
  observability: { emit?: (event: unknown) => void } | null = null;
  private initialized = false;
  private sandbox: SandboxExecutor | null = null;
  /** The Sandbox SDK v2 runtime (any SANDBOX_ADAPTER): the same object as `sandbox`. */
  private portsSandbox: PortsSessionSandbox<unknown> | null = null;
  private wrappedSandbox: SandboxExecutor | null = null;
  private sandboxRuntime: SessionSandboxRuntime | null = null;
  /** Strictly increasing processed_at stamps (list order = (processed_at, id)). */
  private readonly processedClock = createMonotonicClock();

  /** History stamped with this DO's monotonic clock (avoids same-ms idle/tool_result reorder). */
  private openHistory(): SqliteHistory {
    return new SqliteHistory(
      this.ctx.storage.sql,
      this.env.FILES_BUCKET ?? null,
      `t/${this.state.tenant_id ?? "default"}/sessions/${this.state.session_id ?? "unknown"}`,
      this.processedClock,
    );
  }
  /** Per-warmup random tag mirrored to /tmp/.oma-warm in the container.
   *  Lets the wrapSandboxWithLazyWarmup proxy detect a recycled container
   *  (CF Sandbox can die independently of SessionDO via OOM, sleepAfter,
   *  host migration). On mismatch we re-warm so restoreWorkspaceBackup
   *  runs and /workspace gets repopulated from the latest backup. */
  private currentWarmupGen: string | null = null;
  private hasWritableManagedMemoryMount = false;
  /**
   * Per-turn dedup of `agent.message` broadcasts. Recovery's
   * `loadRecoveryContext` reads prior agent messages out of SQL so the
   * next streamText resumes with the right context, but each recovery
   * attempt also calls `persistAgentMessage` for any partial streams it
   * found — without this Set, every recovery re-`broadcastEvent`s the
   * same message_id, producing the duplicate-broadcast storm we saw on
   * `sess-lyh1t4ilelc87ypk` 2026-05-02 (12 dupes at 5x recovery cap fire).
   * Reset at the START of each new turn (drainEventQueue loop) so a
   * legitimately re-emitted message_id in a new turn isn't suppressed.
   */
  private broadcastedMessageIds: Set<string> = new Set();
  /**
   * Browser session backed by Cloudflare Browser Rendering binding. Lazy-created
   * on first browser_* tool call (in-memory only — recreated if DO hibernates).
   * Closed on /destroy.
   */
  private browserSession: BrowserSession | null = null;
  /**
   * Per-DO BrowserHarness wrapper. Caches the BrowserSession across turns
   * so cookies/state persist within the DO lifetime (until hibernate or
   * /destroy). Built lazily on first getBrowserHarness() call.
   */
  private browserHarness: BrowserHarness | null = null;
  private threads = new Map<string, { agentId: string; agentConfig: AgentConfig }>();
  /** In-flight LLM stream state — separate from the events log so chunk
   *  deltas don't pollute history (the eventual `agent.message` is the
   *  source of truth). Lazy-initialized in ensureSchema(). */
  private streams: StreamRepo | null = null;
  /** Single-table queue repo: turn-input events live in `events` with
   *  processed_at NULL until drain stamps the same row/id. Lazy-initialized
   *  in ensureSchema(). Always access it through the `queue` getter below —
   *  alarm() can run before any fetch() has warmed the schema. */
  private _queue: EventLogRepo | null = null;

  /** The one-shot cold-start recovery scan started by ensureSchema().
   *  `_finalizeStaleTurns` awaits it before pairing tool_use/tool_result
   *  so the two recovery paths cannot race into a duplicate aborted
   *  result (provider 400: "each tool_use must have a single result"). */
  private _recoveryPromise: Promise<void> | null = null;

  /** Single-flight guard for `_finalizeStaleTurns`. fetch() starts a
   *  fire-and-forget cold-start pass while alarm() may run the same
   *  pass concurrently; without this both can read the same unpaired
   *  set and append two aborted results. */
  private _finalizePromise: Promise<void> | null = null;

  /**
   * Single-flight guard for the shared recovery hook. Cold start (first
   * request / ensureSchema) is the primary path; the persisted alarm is the
   * fallback. Both funnel through `_runRecovery`, so they can never sweep
   * the same execution twice.
   */
  private _recoveryRun: Promise<void> | null = null;
  /** Consecutive failed recovery passes. */
  private _recoveryFailures = 0;
  /** Earliest epoch ms the next recovery retry may run (backoff horizon). */
  private _recoveryRetryAtMs: number | null = null;
  /** Consecutive drain/claim passes that made no queue progress. */
  private _queueDrainFailures = 0;
  /** Earliest epoch ms the next drain/claim pass may run (backoff horizon). */
  private _queueDrainRetryAtMs: number | null = null;

  /**
   * Lazy queue accessor. `queue` used to be dereferenced as `this.queue`
   * from alarm()/recovery paths that can run on a cold DO before
   * ensureSchema() (e.g. alarm → recoverExecutionQueue → drainEventQueue).
   * That produced `TypeError: Cannot read properties of null (reading
   * 'listQueue')` and left the session status_running forever. Going
   * through this getter guarantees the schema (and thus the repo) exists.
   */
  private get queue(): EventLogRepo {
    if (!this.initialized || this._queue === null) this.ensureSchema();
    if (this._queue === null) {
      throw new Error("event-log queue unavailable: ensureSchema() did not initialize it");
    }
    return this._queue;
  }

  private ensureSchema() {
    if (this.initialized) return;
    sdoLog("isolate.cold_start", {
      session_id: this._state?.session_id,
      tenant_id: this._state?.tenant_id,
      first_init: true,
    });
    // Schema lives in the cf-do adapter so OMA's SessionDO doesn't have
    // to know SQLite syntax. Adapter is idempotent — CREATE TABLE IF NOT
    // EXISTS — so calling on every fetch hot path is fine. The first call
    // also copies any legacy pending_events rows into `events` and drops
    // the old table.
    ensureEventLogSchema(this.ctx.storage.sql);
    this.streams = new CfDoStreamRepo(this.ctx.storage.sql);
    this._queue = new CfDoEventLog(this.ctx.storage.sql, (e) => {
      const ev = e as SessionEvent & { id?: string; processed_at?: string };
      if (!ev.id) ev.id = `sevt_${generateEventId()}`;
      if (!ev.processed_at) ev.processed_at = this.processedClock.nowIso();
    });
    this.initialized = true;
    // Recovery scan: any in-flight state from before this cold start is
    // stale by definition (the runtime that owned it is gone). Reconcile
    // both kinds of orphans now so the events log is consistent before
    // drainEventQueue runs and the harness rebuilds messages.
    //
    // Keep the promise so _finalizeStaleTurns can await this scan before
    // it computes the unpaired tool_use set. Otherwise the two recovery
    // paths race: the scan injects a placeholder for the same tool_use
    // the finalizer is about to abort (or vice versa), producing either
    // a non-is_error result or two results.
    this._recoveryPromise = this.recoverInterruptedState();
    // Cold start is the PRIMARY recovery path (Cloudflare Agents SDK:
    // first request / onStart). It runs the exact same shared lease/sweep
    // hook as the persisted alarm fallback, so a dead incarnation's
    // queued/running executions are reclaimed (or finalized) before the
    // first drain, and the multiplexer is left armed for the next wake.
    // Fire-and-forget: recovery must not block request routing, and the
    // hook single-flights against the alarm path.
    void this._runRecovery("cold_start");
  }

  /**
   * The one shared recovery hook. Cold start (first request / ensureSchema =
   * onStart) is the primary path; the persisted alarm is the fallback. Both
   * call this so the lease sweep, renewal, stale-turn finalization, and queue
   * re-drive are identical no matter what woke the DO.
   *
   * A failed pass is retained, not dropped: the attempt counter grows and the
   * multiplexer is armed at a capped exponential backoff horizon, so the
   * persisted alarm retries the same work instead of silently losing it.
   */
  private async _runRecovery(reason: "cold_start" | "alarm"): Promise<void> {
    if (this._recoveryRun !== null) return this._recoveryRun;
    // Set the single-flight slot BEFORE the body runs: _runRecoveryInner may
    // cold-start ensureSchema(), which fires `void _runRecovery("cold_start")`
    // synchronously. Without this gate that nested call would start a second
    // pass and both would sweep the same execution.
    let release!: () => void;
    const start = new Promise<void>((resolve) => { release = resolve; });
    const run = start
      .then(() => this._runRecoveryInner(reason))
      .catch(async (err) => {
        this._recoveryFailures += 1;
        const backoffMs = Math.min(
          RECOVERY_BACKOFF_BASE_MS * 2 ** (this._recoveryFailures - 1),
          RECOVERY_BACKOFF_MAX_MS,
        );
        this._recoveryRetryAtMs = this.processedClock.nowMs() + backoffMs;
        sdoLog("recovery.failed", {
          session_id: this._state?.session_id,
          reason,
          attempt: this._recoveryFailures,
          backoff_ms: backoffMs,
          retry_at_ms: this._recoveryRetryAtMs,
          error: err instanceof Error ? err.message : String(err),
        });
        // Retain the wake through the single alarm slot. Never rethrow into
        // the request/alarm caller: the next wake retries the same hook.
        try {
          await this._multiplexAlarm({
            reason: "recovery_retry",
            atMs: this._recoveryRetryAtMs,
          });
        } catch { /* the persisted schedule/lease wake still covers us */ }
      })
      .finally(() => {
        if (this._recoveryRun === run) this._recoveryRun = null;
      });
    this._recoveryRun = run;
    release();
    return run;
  }

  private async _runRecoveryInner(reason: "cold_start" | "alarm"): Promise<void> {
    const nowMs = this.processedClock.nowMs();
    if (this._recoveryRetryAtMs !== null && nowMs < this._recoveryRetryAtMs) {
      // Backing off: do not re-run (and re-fail) the hook before the horizon.
      // Keep the slot armed at the retry time so this is not a dropped pass.
      sdoLog("recovery.held", {
        session_id: this._state?.session_id,
        reason,
        retry_at_ms: this._recoveryRetryAtMs,
      });
      await this._multiplexAlarm({ reason: "recovery_backoff" });
      return;
    }
    // alarm() can reach here before any fetch() warmed the in-memory schema.
    this.ensureSchema();
    // Join a request-level cold-start finalizer that is already in flight.
    // Without this the fetch()/onStart pass can finish and clear its
    // single-flight guard before this hook reaches finalization, causing a
    // second pass over the same orphans.
    const inFlightFinalize = this._finalizePromise;
    if (this._recoveryPromise !== null) {
      try {
        await this._recoveryPromise;
      } catch (err) {
        console.warn(`[recovery] cold-start stream scan failed:`, err);
      }
    }
    sdoLog("recovery.start", {
      session_id: this._state?.session_id,
      reason,
    });
    // The shared lease/sweep hook: expired owners are requeued (input
    // provably unapplied) or finalized-interrupted (applied work / unpaired
    // tool call) from canonical-stream evidence, then live leases renew.
    await this._sweepExpiredLeases(nowMs);
    await this._applyPolicyLeaseRenewals(nowMs);
    // Finalize dangling turns, then drain/claim whatever the policy exposes.
    if (inFlightFinalize !== null) {
      await inFlightFinalize;
    } else {
      await this._finalizeStaleTurns();
    }
    await this.recoverExecutionQueue();
    this._recoveryFailures = 0;
    this._recoveryRetryAtMs = null;
    sdoLog("recovery.done", {
      session_id: this._state?.session_id,
      reason,
    });
    await this._multiplexAlarm({ reason: `recovery_${reason}` });
  }

  /**
   * The ONE alarm-slot multiplexer. Every setAlarm/deleteAlarm in this class
   * funnels through it. It folds the next schedule, lease renewal/expiry,
   * drainable work, blocked/held rows, in-memory running turns, and the
   * recovery/queue backoff horizons into a single earliest wake (Cloudflare
   * Agents SDK durable-fiber shape), and never deletes the slot while
   * running work or any queue row is still present.
   */
  private async _multiplexAlarm(
    hint: { reason?: string; atMs?: number } = {},
  ): Promise<void> {
    try {
      const nowMs = this.processedClock.nowMs();
      const scheduleNextMs = this._nextScheduleWakeMs(nowMs);
      const queuedInputs = this._localQueuedInputs();
      let executions: ExecutionLeaseRecord[] = [];
      try {
        executions = await this._executionLeaseRecords();
      } catch (err) {
        console.warn(`[session-do] alarm policy read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const activeTurns = this._activeTurnRecords();
      const schedules: ScheduleWakeRecord[] = scheduleNextMs === null
        ? []
        : [{ id: "cf_agents_schedules", dueAtMs: scheduleNextMs }];
      const queueBackoffAtMs =
        this._queueDrainRetryAtMs !== null && this._queueDrainRetryAtMs > nowMs
          ? this._queueDrainRetryAtMs
          : undefined;
      const policy = evaluateCoordinationPolicy({
        nowMs,
        executions,
        queuedInputs,
        activeTurns,
        schedules,
        heartbeatIntervalMs: KEEP_ALIVE_INTERVAL_MS,
        queuedWakeDelayMs: QUEUE_WAKE_DELAY_MS,
        ...(queueBackoffAtMs === undefined
          ? {}
          : { queuedWakeNotBeforeMs: queueBackoffAtMs }),
      });

      const queuedExecutions = executions.filter((e) => e.state === "queued");
      const hasQueued =
        queuedInputs.length > 0 ||
        queuedExecutions.length > 0 ||
        policy.actions.some((action) => action.type === "requeue");
      const hasBlocked = policy.blockedQueuedRows > 0;
      const hasRunning =
        executions.some((e) => e.state === "running") || activeTurns.length > 0;
      const hasSchedule = scheduleNextMs !== null;
      // Hard invariant: queued or running work always keeps a wake armed.
      // Blocked/held rows still keep the slot, but only at a slow safety net.
      const mustStayArmed = hasQueued || hasRunning || hasBlocked;

      let nextMs = policy.nextWakeAtMs;
      if (hasBlocked) {
        const safetyAtMs = nowMs + BLOCKED_QUEUE_SAFETY_WAKE_MS;
        nextMs = nextMs === null ? safetyAtMs : Math.min(nextMs, safetyAtMs);
      }
      if (hint.atMs !== undefined) {
        const requested = Math.max(hint.atMs, nowMs);
        nextMs = nextMs === null ? requested : Math.min(nextMs, requested);
      }
      if (nextMs === null && mustStayArmed) {
        // Policy invariant guard: never disarm while any work exists. Queue
        // rows with no drainable action must not fall back to a near-zero
        // re-arm (that is the alarm hot loop this guard used to create).
        nextMs = nowMs + (hasRunning
          ? KEEP_ALIVE_INTERVAL_MS
          : BLOCKED_QUEUE_SAFETY_WAKE_MS);
      }
      if (this._recoveryRetryAtMs !== null && this._recoveryRetryAtMs > nowMs) {
        // Recovery is backing off. Hold recoverable queue/lease wakes until
        // the retry horizon (schedules still fire at their own time) so a
        // failing hook cannot spin the alarm once per second.
        nextMs = hasSchedule ? nextMs : this._recoveryRetryAtMs;
      }

      const reason = hint.reason ?? ([
        hasQueued ? "queued_work" : null,
        hasRunning ? "lease" : null,
        hasBlocked ? "blocked_rows" : null,
        hasSchedule ? "schedule" : null,
        queueBackoffAtMs !== undefined ? "queue_backoff" : null,
        this._recoveryRetryAtMs !== null ? "recovery_backoff" : null,
      ].filter((part): part is string => part !== null).join("+") || "policy");

      if (nextMs !== null) {
        await this.ctx.storage.setAlarm(nextMs);
        sdoLog("alarm.armed", {
          session_id: this._state?.session_id,
          reason,
          next_ms: nextMs,
          next_at: new Date(nextMs).toISOString(),
          queued: queuedInputs.length + queuedExecutions.length,
          blocked: policy.blockedQueuedRows,
          running_executions: executions.filter((e) => e.state === "running").length,
          schedule: hasSchedule,
          drainable_at_ms: policy.nextDrainableWakeAtMs,
        });
      } else if (mustStayArmed) {
        // Defensive duplicate of the invariant above; a future policy
        // regression must never strand queued/running work.
        const guardedAt = nowMs + (hasRunning
          ? KEEP_ALIVE_INTERVAL_MS
          : BLOCKED_QUEUE_SAFETY_WAKE_MS);
        await this.ctx.storage.setAlarm(guardedAt);
        sdoLog("alarm.armed", {
          session_id: this._state?.session_id,
          reason: `${reason}+guard`,
          next_ms: guardedAt,
          next_at: new Date(guardedAt).toISOString(),
        });
      } else {
        await this.ctx.storage.deleteAlarm();
        sdoLog("alarm.cleared", {
          session_id: this._state?.session_id,
          reason: "quiescent",
        });
      }
    } catch (err) {
      // Storage failure must not abort the turn. The durable execution lease
      // is still the authority and a later fetch/alarm recovers it.
      console.warn(`[session-do] alarm multiplex failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Durably arm the lease-renewal wake for an in-flight turn through the
   * multiplexer. MUST be awaited before the turn reaches the model request.
   */
  private async _armLeaseWake(reason = "turn_lease"): Promise<void> {
    await this._multiplexAlarm({
      reason,
      atMs: Date.now() + KEEP_ALIVE_INTERVAL_MS,
    });
  }

  /**
   * One structured line per model request span. `start` records the wall
   * clock keyed by the span id; `end`/`abort` pair it and report duration.
   * Called from broadcastEvent (every harness path funnels through it).
   */
  private _logModelRequestSpan(event: SessionEvent): void {
    const e = event as unknown as Record<string, unknown>;
    if (e.type === "span.model_request_start") {
      const eventId = typeof e.id === "string" ? e.id : undefined;
      if (!eventId) return;
      // Bound: a start whose end was lost with an isolate reset must not
      // grow this map forever in a long-lived DO.
      if (this._modelRequestStartedAt.size >= 512) {
        const oldest = this._modelRequestStartedAt.keys().next().value;
        if (typeof oldest === "string") this._modelRequestStartedAt.delete(oldest);
      }
      this._modelRequestStartedAt.set(eventId, Date.now());
      sdoLog("model_request.start", {
        session_id: this._state?.session_id,
        event_id: eventId,
        model: typeof e.model === "string" ? e.model : undefined,
      });
      return;
    }
    if (e.type !== "span.model_request_end") return;
    const startId = typeof e.model_request_start_id === "string"
      ? e.model_request_start_id
      : undefined;
    const startedAt = startId === undefined ? undefined : this._modelRequestStartedAt.get(startId);
    if (startId !== undefined) this._modelRequestStartedAt.delete(startId);
    const finishReason = typeof e.finish_reason === "string" ? e.finish_reason : undefined;
    const isAbort = finishReason === "aborted";
    sdoLog(isAbort ? "model_request.abort" : "model_request.end", {
      session_id: this._state?.session_id,
      event_id: startId,
      model: typeof e.model === "string" ? e.model : undefined,
      duration_ms: startedAt === undefined ? undefined : Date.now() - startedAt,
      finish_reason: finishReason,
      is_error: e.is_error === true,
    });
  }

  /** Latest session-level lifecycle status row, if any. Used to detect a
   *  markerless dangling turn (legacy outbox path wrote status events but
   *  never sessions.turn_id). */
  private _latestSessionStatusEvent(): { type: string; ts: number } | null {
    try {
      const row = this.ctx.storage.sql.exec<{ type: string; ts: number }>(
        `SELECT type, ts FROM events
          WHERE type IN ('session.status_running','session.status_idle',
                         'session.status_rescheduled','session.status_terminated')
          ORDER BY seq DESC LIMIT 1`,
      ).toArray()[0];
      return row ? { type: row.type, ts: row.ts } : null;
    } catch {
      // events table not created yet (very early cold start).
      return null;
    }
  }

  /**
   * Stream runtime helpers — broadcast lifecycle/chunk events AND
   * persist into the streams table (separate from the events log).
   * Sub-agent runtimes pass `threadId` so events get tagged with the
   * sub-agent's thread context, matching the existing `broadcast`
   * pattern in `runSubAgent`.
   */
  private buildStreamRuntimeMethods(
    threadId?: string,
    executionFence?: SessionExecutionFence,
  ): {
    broadcastStreamStart: (messageId: string) => Promise<void>;
    broadcastChunk: (messageId: string, delta: string) => Promise<void>;
    broadcastStreamEnd: (
      messageId: string,
      status: "completed" | "aborted",
      errorText?: string,
    ) => Promise<void>;
    broadcastThinkingStart: (thinkingId: string) => Promise<void>;
    broadcastThinkingChunk: (thinkingId: string, delta: string) => Promise<void>;
    broadcastThinkingEnd: (thinkingId: string, status: "completed" | "aborted") => Promise<void>;
    broadcastToolInputStart: (toolUseId: string, toolName?: string) => Promise<void>;
    broadcastToolInputChunk: (toolUseId: string, delta: string) => Promise<void>;
    broadcastToolInputEnd: (toolUseId: string, status: "completed" | "aborted") => Promise<void>;
  } {
    const tag = (event: SessionEvent): SessionEvent =>
      threadId ? ({ ...event, session_thread_id: threadId } as SessionEvent) : event;
    const assertCurrentFence = () => {
      if (executionFence !== undefined && !this.isExecutionFenceCurrent(executionFence)) {
        const error = new Error("session execution fence is no longer valid");
        error.name = "ExecutionFenceLostError";
        throw error;
      }
    };
    const fire = (event: SessionEvent) => {
      assertCurrentFence();
      this.broadcastEvent(event, executionFence);
      this.fanOutToHooks(event);
    };
    return {
      broadcastStreamStart: async (messageId: string) => {
        assertCurrentFence();
        if (!this.streams) this.ensureSchema();
        await this.streams!.start(messageId, Date.now());
        fire(tag({ type: "agent.message_stream_start", message_id: messageId } as SessionEvent));
      },
      broadcastChunk: async (messageId: string, delta: string) => {
        assertCurrentFence();
        if (!this.streams) this.ensureSchema();
        await this.streams!.appendChunk(messageId, delta);
        fire(tag({ type: "agent.message_chunk", message_id: messageId, delta } as SessionEvent));
      },
      broadcastStreamEnd: async (messageId: string, status, errorText?: string) => {
        assertCurrentFence();
        if (!this.streams) this.ensureSchema();
        // Aborted streams need their partial text persisted as a
        // canonical agent.message before we lose access to the
        // streams row. Without this, mid-stream aborts (user.interrupt,
        // model timeout, MCP cancel) leave the streams row stuck at
        // status='streaming' until cold-start recovery — meanwhile
        // eventsToMessages doesn't see the partial text and the next
        // turn's LLM context is missing what the model just said.
        //
        // Mirrors recovery.ts:69-78. Same dedup + placeholder fallback.
        // Done before finalize so a concurrent reader never observes
        // a stream that's both finalized AND missing from history.
        if (status === "aborted" && !this.broadcastedMessageIds.has(messageId)) {
          const row = await this.streams!.get(messageId);
          const partial = row?.chunks?.join("") ?? "";
          const partialEvent = tag({
            type: "agent.message",
            id: messageId,
            content: [{ type: "text", text: partial || "(interrupted before any tokens streamed)" }],
          } as unknown as SessionEvent);
          // Append directly to the events table — broadcastEvent's
          // dedup hits the broadcastedMessageIds set, but the persist
          // path is what matters most (Console replay, LLM context).
          const history = this.guardHistoryForExecution(
            this.openHistory(),
            executionFence,
          );
          history.append(partialEvent);
          this.broadcastedMessageIds.add(messageId);
          fire(partialEvent);
        }
        await this.streams!.finalize(messageId, status, errorText);
        fire(tag({
          type: "agent.message_stream_end",
          message_id: messageId,
          status,
          error_text: errorText,
        } as SessionEvent));
      },
      // Thinking + tool-input streams are broadcast-only — see notes
      // in interface.ts. No streams-table writes; if the runtime dies
      // before the canonical event lands, the harness retry path
      // produces a fresh attempt with new ids.
      broadcastThinkingStart: async (thinkingId: string) => {
        fire(tag({ type: "agent.thinking_stream_start", thinking_id: thinkingId } as SessionEvent));
      },
      broadcastThinkingChunk: async (thinkingId: string, delta: string) => {
        fire(tag({ type: "agent.thinking_chunk", thinking_id: thinkingId, delta } as SessionEvent));
      },
      broadcastThinkingEnd: async (thinkingId: string, status) => {
        fire(tag({ type: "agent.thinking_stream_end", thinking_id: thinkingId, status } as SessionEvent));
      },
      broadcastToolInputStart: async (toolUseId: string, toolName?: string) => {
        fire(tag({
          type: "agent.tool_use_input_stream_start",
          tool_use_id: toolUseId,
          tool_name: toolName,
        } as SessionEvent));
      },
      broadcastToolInputChunk: async (toolUseId: string, delta: string) => {
        fire(tag({ type: "agent.tool_use_input_chunk", tool_use_id: toolUseId, delta } as SessionEvent));
      },
      broadcastToolInputEnd: async (toolUseId: string, status) => {
        fire(tag({ type: "agent.tool_use_input_stream_end", tool_use_id: toolUseId, status } as SessionEvent));
      },
    };
  }

  /**
   * Build a `FileResolver` bound to this session's tenant. Used by the
   * harness's eventsToMessagesAsync projection to materialize file_id
   * sources on `user.message` ImageBlock/DocumentBlock content into inline
   * bytes for the model (Anthropic Managed Agents spec — image/document
   * blocks with `source.type === "file"` reference an uploaded file by id).
   *
   * Resolution path:
   *   1. `services.files.get({tenantId, fileId})` — D1 metadata lookup,
   *      enforces tenant scoping (returns null for other tenants' files).
   *   2. R2 fetch at the metadata's `r2_key` (or the canonical
   *      `fileR2Key(tenant, id)` fallback for rows missing r2_key).
   *
   * Returns null on any failure (missing metadata, deleted blob, R2 outage,
   * service init error) — derive layer maps null to a placeholder text
   * block so the turn doesn't crash. Errors are intentionally swallowed
   * here; the per-derive cache wrapping this caches the null result so a
   * single failure doesn't trigger a retry storm within one projection.
   *
   * No per-file logging — the existing default-loop log lines cover the
   * shape of each call (messages count) without paying per-attachment
   * verbosity.
   */
  private buildFileFetcher(tenantId: string | undefined): FileResolver | undefined {
    if (!tenantId || !this.env.FILES_BUCKET) return undefined;
    const tenant = tenantId;
    const bucket = this.env.FILES_BUCKET;
    return async (fileId: string) => {
      try {
        const services = await getCfServicesForTenant(this.env, tenant);
        const meta = await services.files.get({ tenantId: tenant, fileId });
        if (!meta) return null;
        const obj = await bucket.get(meta.r2_key || fileR2Key(tenant, fileId));
        if (!obj) return null;
        const buf = await obj.arrayBuffer();
        return {
          bytes: new Uint8Array(buf),
          mediaType: meta.media_type,
          filename: meta.filename,
        };
      } catch {
        return null;
      }
    };
  }

  /** Cold-start reconciliation. Pure logic lives in `recoverInterruptedState`
   *  (see ./recovery.ts) so it's testable end-to-end with in-memory adapters.
   *  This wrapper just glues it to DO storage + WS broadcast. */
  private async recoverInterruptedState(): Promise<void> {
    if (!this.streams) return;
    const history = this.openHistory();
    try {
      // Parked calls (custom_tool_use awaiting user.custom_tool_result,
      // always_ask awaiting user.tool_confirmation) are unpaired BY
      // DESIGN and survive restarts. Recovery must not fabricate a
      // placeholder next to the real answer the client will post later.
      const parkedToolUseIds = new Set(
        (this._state?.pending_tool_calls ?? []).map((pending) => pending.toolCallId),
      );
      const { warnings } = await runRecovery(
        this.streams,
        history,
        { skipToolUseIds: parkedToolUseIds },
      );
      for (const w of warnings) {
        this.broadcastEvent({
          type: "session.warning",
          source: w.source,
          message: w.message,
          details: w.details,
        } as SessionEvent);
      }
    } catch (err) {
      logWarn(
        { op: "session_do.recover", err },
        "recovery scan failed; continuing",
      );
    }
  }

  /**
   * Scheduled recovery callback: called by Agent's schedule system
   * 5 seconds after an event is received. If the primary waitUntil
   * path already drained the queue, this is a no-op.
   *
   * Drains every thread that has queued inputs. Cheap — the partial
   * processed_at-NULL index makes "list distinct thread_ids with queued
   * rows" an O(log n) scan, and per-thread mutex (_draining set) means a
   * thread that's already draining returns immediately.
   */
  async recoverEventQueue(): Promise<void> {
    this.ensureSchema();
    // Single-table queue: active queued inputs are events rows with
    // processed_at IS NULL. Cancelled rows are excluded.
    const threads = this.queue.threadsWithQueueInputs();
    if (threads.length === 0) {
      // Nothing pending anywhere. Do not invoke drainEventQueue just to
      // discover an empty queue: the central execution path arms a lease
      // heartbeat when it enters, which would leak a 30s alarm for an idle
      // session (and makes alarm() look like it has live work).
      return;
    }
    await Promise.all(threads.map((t) => this.drainEventQueue(t)));
  }

  /**
   * Schedule a future wake-up of THIS session. Backed by the agents framework's
   * durable scheduler (SQLite-persisted, survives DO eviction). When the timer
   * fires, `onScheduledWakeup` injects a synthetic user.message tagged with
   * `metadata.harness="schedule"`, which kicks the harness loop back into
   * "running" via the same path /event POST takes for user messages
   * (lines 721-730).
   *
   * Exactly one of delay_seconds | at | cron must be supplied. Cron schedules
   * recur until cancelled via cancelWakeup(id).
   */
  async scheduleWakeup(args: {
    delay_seconds?: number;
    at?: string;
    cron?: string;
    prompt: string;
  }): Promise<{ id: string; fire_at?: string; cron?: string; kind: "one_shot" | "cron" }> {
    const scope = this._wakeupScope();
    const result = await this._wakeups.schedule({
      ...scope,
      prompt: args.prompt,
      ...(args.delay_seconds !== undefined && {
        delaySeconds: args.delay_seconds,
      }),
      ...(args.at !== undefined && { at: args.at }),
      ...(args.cron !== undefined && { cron: args.cron }),
    });
    if (result.type === "scheduled") {
      return {
        id: result.wakeup.id,
        fire_at: result.wakeup.kind === "one_shot"
          ? result.wakeup.fireAt
          : undefined,
        cron: result.wakeup.kind === "cron" ? result.wakeup.cron : undefined,
        kind: result.wakeup.kind,
      };
    }
    if (result.type === "terminated") {
      throw new Error("session is terminated; cannot schedule wakeup");
    }
    if (result.type === "capacity_reached") {
      throw new Error(
        `pending wakeup cap reached (${result.pending}/${result.limit}); ` +
        "call list_schedules to inspect, cancel_schedule to free a slot",
      );
    }
    if (result.type === "invalid_input") {
      if (result.path === "timing") {
        throw new Error("must provide exactly one of delay_seconds | at | cron");
      }
      if (result.path === "at") {
        throw new Error(`invalid 'at' timestamp: ${args.at ?? ""}`);
      }
      if (result.path === "prompt") throw new Error("prompt is required");
      throw new Error(result.message);
    }
    throw new Error("session is not initialized; cannot schedule wakeup");
  }

  /**
   * Callback invoked by the agents framework when a wakeup schedule fires.
   * Mirrors the /event POST handler's user.message path (lines 721-730):
   * persist the synthetic message, arm a recoverEventQueue safety net, and
   * kick drain (no-await — drain handles its own concurrency guard).
   */
  async onScheduledWakeup(payload: {
    prompt: string;
    scheduled_at: string;
    kind: "one_shot" | "cron";
    parent_event_id?: string;
  } | SessionWakeupDelivery): Promise<void> {
    const scope = this._wakeupScope();
    const wakeup: SessionWakeupDelivery = "workspaceId" in payload
      ? payload
      : {
          ...scope,
          prompt: payload.prompt,
          scheduledAt: payload.scheduled_at,
          causalEventId: payload.parent_event_id ?? generateEventId(),
          kind: payload.kind,
        };
    await this._wakeups.fire({ wakeup });
  }

  /**
   * Cancel a previously scheduled wakeup by id. Returns whether a row was
   * actually removed (false = id not found / already fired / not a wakeup).
   */
  async cancelWakeup(id: string): Promise<{ cancelled: boolean }> {
    const scope = this._wakeupScope();
    const result = await this._wakeups.cancel({
      ...scope,
      wakeupId: id,
    });
    return { cancelled: result.type === "cancelled" };
  }

  /**
   * Cancel every pending wakeup for this session. Used when the managed MCP
   * proxy observes a terminal loss of access. Idempotent: a second call
   * finds an empty list.
   */
  async cancelAllWakeups(): Promise<{ cancelled: number }> {
    // This Durable Object is already one session. Cancel every wakeup
    // schedule on it, including rows whose stored scope was written before
    // state.session_id was hydrated.
    const pending = this.getSchedules().filter(
      (record) => record.callback === "onScheduledWakeup",
    );
    let cancelled = 0;
    for (const record of pending) {
      if (await this.cancelSchedule(record.id)) cancelled += 1;
    }
    return { cancelled };
  }

  /**
   * List pending wakeup schedules for THIS session. Filters on
   * `callback === "onScheduledWakeup"` so the agent never sees the
   * framework's internal recoverEventQueue / pollBackgroundTasks rows.
   */
  listWakeups(): Array<{
    id: string;
    fire_at?: string;
    cron?: string;
    prompt: string;
    kind: "one_shot" | "cron";
  }> {
    return this._wakeupScheduler.listNow(this._wakeupScope()).map((wakeup) => ({
      id: wakeup.id,
      fire_at: wakeup.kind === "one_shot" ? wakeup.fireAt : undefined,
      cron: wakeup.kind === "cron" ? wakeup.cron : undefined,
      prompt: wakeup.prompt,
      kind: wakeup.kind,
    }));
  }

  /**
   * Called by _checkOrphanTurns when an orphan turn (sessions row marked
   * status='running' with a turn_id we don't own) is detected at alarm
   * wake or cold-start. Historically this was wired into the cf-agents
   * runFiber/onFiberRecovered hook; Phase 3 unified the trigger via the
   * RuntimeAdapter, so the entry shape is identical to what the old
   * fiber API produced — { id, name, snapshot:null }. Recovery itself
   * works the same way: emit a session.status_rescheduled marker so
   * observers see what happened, reset stale state.status, and re-drain.
   * The unprocessed user.message at seq is still pending (we never
   * emitted status_idle for it) so drain re-runs the harness; generateText
   * sees prior tool_use/tool_result rows in history and continues from
   * roughly where it left off (at-least-once semantics — a tool may be
   * re-decided once, but no tool effect is lost since each result is in
   * SQL).
   */
  async onFiberRecovered(ctx: { id: string; name: string; snapshot: unknown }): Promise<void> {
    if (!ctx.name.startsWith("turn:")) {
      console.warn(`[orphan-recover] unknown turn name: ${ctx.name}`);
      return;
    }
    console.warn(
      `[orphan-recover] turn ${ctx.name} (id=${ctx.id}) interrupted; routing through recoverAgentTurn`,
    );
    this.ensureSchema();

    // Status is derived from cf_agents_runs row presence — onFiberRecovered
    // is invoked AFTER _checkRunFibers DELETEs the orphan, so deriveStatus
    // automatically reads "idle" here. No manual state mutation needed.

    const history = this.openHistory();

    const decision = await recoverAgentTurn(
      this.turnRuntimeAdapter(),
      ctx,
      // loadRecoveryContext: read SQL events + streams to reconstruct the
      // state at the moment of interruption. We deliberately do NOT use
      // ctx.snapshot from cf-agents stash — OMA's events table already
      // carries richer canonical state.
      async () => {
        const lastUserMsgSeq = this.getLastEventSeq("user.message");
        const eventsAfter = this.getEventsBetween(lastUserMsgSeq, Number.MAX_SAFE_INTEGER);
        const partialStreams: PartialStream[] = [];
        try {
          const cursor = this.ctx.storage.sql.exec(
            `SELECT message_id, status, chunks_json FROM streams WHERE status IN ('streaming', 'interrupted') ORDER BY started_at`,
          );
          for (const row of cursor) {
            try {
              const chunks = JSON.parse(row.chunks_json as string) as string[];
              partialStreams.push({
                message_id: row.message_id as string,
                partial_text: chunks.join(""),
                status: (row.status as "streaming" | "interrupted"),
              });
            } catch {}
          }
        } catch {
          // streams table might not exist yet (older session); fine, return empty
        }
        return { history: eventsAfter, partialStreams };
      },
      // Resume policy: always continue. recoverAgentTurn caps at 5 attempts;
      // on the 6th the cap fires and we get a session.error + force-idle
      // automatically (no need to track it here). Persist partial agent
      // messages so the trajectory shows what was streamed before the cut.
      async (rctx) => {
        const reschedEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: `Recovered after DO eviction (turn ${ctx.name}, recovery ${rctx.recoveryCount}/5)`,
        };
        history.append(reschedEvent);
        this.broadcastEvent(reschedEvent);
        return { continue: true, persistPartial: true };
      },
      {
        emitEvent: (e) => {
          history.append(e);
          this.broadcastEvent(e);
        },
        persistAgentMessage: (text, message_id) => {
          // Recovery's loadRecoveryContext seeds streamText with prior
          // partials; each recovery iteration also passes those same
          // (text, message_id) tuples through this callback. Without
          // dedup we'd re-append + re-broadcast each one per recovery
          // attempt — observed as 12 duplicate agent.message events at
          // 5x cap fire. Set is in-memory + per-turn (cleared at the
          // start of each drainEventQueue iteration).
          if (this.broadcastedMessageIds.has(message_id)) return;
          this.broadcastedMessageIds.add(message_id);
          const ev: SessionEvent = {
            type: "agent.message",
            id: message_id,
            content: [{ type: "text", text }],
          } as unknown as SessionEvent;
          history.append(ev);
          this.broadcastEvent(ev);
        },
        forceIdle: () => {
          // Status auto-derives to "idle" once recoverAgentTurn returns
          // and cf_agents_runs is empty. Just emit the trajectory event.
          const idleEvent: SessionEvent = { type: "session.status_idle", stop_reason: { type: "end_turn" } };
          history.append(idleEvent);
          this.broadcastEvent(idleEvent);
        },
        maxRecoveries: 5,
      },
    );

    if (decision.continue) {
      await this.drainEventQueue();
    }
  }

  /**
   * Read events strictly between two seq values (exclusive on both ends).
   * Helper used by recoverAgentTurn's loadRecoveryContext.
   */
  private getEventsBetween(afterSeq: number, beforeSeq: number): SessionEvent[] {
    const out: SessionEvent[] = [];
    try {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT data FROM events WHERE seq > ? AND seq < ? ORDER BY seq`,
        afterSeq,
        beforeSeq,
      );
      for (const row of cursor) {
        try {
          out.push(JSON.parse(row.data as string) as SessionEvent);
        } catch {
          // Skip rows that fail to parse (read-side resilience).
        }
      }
    } catch {
      // events table may not exist yet
    }
    return out;
  }

  /**
   * Drain the event queue for one thread: pull pending user events
   * (processed_at IS NULL AND cancelled_at IS NULL) in seq order and
   * run the harness for each. Loops until the thread's queue is empty.
   *
   * Per-thread mutex via _draining set: two callers for the same
   * thread early-return; cross-thread drains run in parallel.
   *
   * Pending boundary: each row's `processed_at` column is the
   * authoritative "this event has been ingested" marker. On successful
   * (or failed) turn completion we UPDATE events SET processed_at=now
   * for the row. Old behavior (lastIdleSeq window) lost any user.message
   * appended between turn start and turn-end status_idle (5 messages
   * sent during a long-running turn would all be skipped).
   */
  private async getExecutionStore(): Promise<SqlSessionExecutionStore | null> {
    if (!this.env.MAIN_DB || !this.state.tenant_id || !this.state.session_id) return null;
    if (this._executionStore === null) {
      const db = await buildCfTenantDbProvider(this.env).resolve(this.state.tenant_id);
      this._executionStore = new SqlSessionExecutionStore(new CfD1SqlClient(db), {
        recoveryScope: { workspaceId: this.state.tenant_id, sessionId: this.state.session_id },
      });
      this._executionStoreReady = ensureSessionExecutionCoordinatorSchema(
        new CfD1SqlClient(db),
      );
    }
    await this._executionStoreReady;
    return this._executionStore;
  }

  private executionFenceForEvent(event: SessionEvent): SessionExecutionFence | undefined {
    let lane = (event as unknown as { session_thread_id?: string }).session_thread_id
      ?? "sthr_primary";
    for (let depth = 0; depth < 8; depth += 1) {
      const fence = this._executionFences.get(lane);
      if (fence !== undefined) return fence;
      const parent = this._executionParentLane.get(lane);
      if (parent === undefined) break;
      lane = parent;
    }
    return undefined;
  }

  /** Queue rows are `events` rows with processed_at IS NULL. Delivery
   * retries are idempotent by the canonical managed event id. */
  private queueRowForEvent(eventId: string): QueueInputRow | null {
    if (!eventId) return null;
    for (const row of this.ctx.storage.sql.exec(
      `SELECT seq, ts, enqueued_at, session_thread_id, type, data, cancelled_at,
              json_extract(data, '$.id') AS event_id
         FROM events
        WHERE json_extract(data, '$.id') = ?
          AND processed_at IS NULL AND cancelled_at IS NULL
        ORDER BY seq ASC LIMIT 1`,
      eventId,
    )) {
      return {
        seq: row.seq as number,
        enqueued_at: (row.enqueued_at as number | null) ??
          ((row.ts as number | null) ?? 0) * 1000,
        session_thread_id: row.session_thread_id as string,
        type: row.type as string,
        event_id: (row.event_id as string | null) ?? "",
        data: row.data as string,
        cancelled_at: (row.cancelled_at as number | null) ?? null,
      };
    }
    return null;
  }

  private localEventExists(eventId: string): boolean {
    if (!eventId) return false;
    for (const row of this.ctx.storage.sql.exec(
      `SELECT 1 AS present FROM events
        WHERE json_extract(data, '$.id') = ? LIMIT 1`,
      eventId,
    )) {
      return row.present === 1;
    }
    return false;
  }

  /** Insert a turn input into the single-table queue (events row,
   *  processed_at NULL). Returns false when the id is already present. */
  private enqueueQueueInputIfNew(event: SessionEvent): boolean {
    const e = event as SessionEvent & { id?: string };
    if (!e.id) e.id = `sevt_${generateEventId()}`;
    if (this.localEventExists(e.id)) return false;
    const enqueued = this.queue.enqueueQueueInput(event);
    if (enqueued) {
      // New work always resets the no-progress horizon: a held/blocked lane
      // may just have become drainable.
      this._resetQueueDrainBackoff();
      sdoLog("queue.enqueue", {
        session_id: this._state?.session_id,
        thread_id: (event as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
        event_id: e.id,
        event_type: event.type,
      });
      // Admission persisted the queue row above; now schedule the near-zero
      // wake through the single alarm multiplexer (Flue: enqueue => alarm).
      // Routing through the multiplexer means the wake merges with the
      // heartbeat/schedule slot instead of clobbering it.
      void this._multiplexAlarm({
        reason: "queue_enqueued",
        atMs: this.processedClock.nowMs() + ENQUEUE_WAKE_DELAY_MS,
      });
    }
    return enqueued;
  }

  private executionInputFromWire(event: SessionEvent): unknown {
    const camelize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(camelize);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase()),
          camelize(child),
        ]),
      );
    };
    return camelize(event);
  }

  private setExhaustedAt(threadId: string, at: number | undefined): void {
    const next = { ...(this.state.exhausted_at_by_lane ?? {}) };
    if (at === undefined) delete next[threadId]; else next[threadId] = at;
    this.setState({ ...this.state, exhausted_at_by_lane: next });
  }

  private async admitQueueFallback(
    store: SqlSessionExecutionStore,
    threadId: string,
  ): Promise<boolean> {
    const exhaustedAt = this.state.exhausted_at_by_lane?.[threadId];
    // Walk the lane's queued inputs oldest-first; rows already admitted
    // (e.g. held after retries_exhausted) are skipped so a newer input can
    // still be admitted behind them.
    for (const row of this.queue.listQueue(threadId)) {
      let event: SessionEvent;
      try {
        event = JSON.parse(row.data) as SessionEvent;
      } catch {
        // Corrupt queue row: cancel it so it never blocks the lane.
        this.queue.cancelQueueByEventId(row.event_id, Date.now());
        continue;
      }
      const id = (event as unknown as { id?: string }).id ?? row.event_id;
      if (await store.find({ workspaceId: this.state.tenant_id!, executionId: id }) !== null) continue;
      const admitted = await store.admit({
        execution: {
          id,
          workspaceId: this.state.tenant_id!,
          sessionId: this.state.session_id!,
          laneId: threadId,
          admittedAt:
            (event as unknown as { processed_at?: string }).processed_at ??
            new Date().toISOString(),
          events: [this.executionInputFromWire(event) as never],
        },
      });
      if (admitted.type === "conflict") {
        throw new Error(`Session Execution ${id} conflicts with an existing admission`);
      }
      // Owner lock (exhausted retain): an input that arrived during the
      // turn that ended retries_exhausted is held, not run alone. It rides
      // the next admission (absorbHeldIntoUnheldAdmissions on claim).
      if (exhaustedAt !== undefined && row.enqueued_at <= exhaustedAt) {
        await store.markHeldAfterExhausted({
          workspaceId: this.state.tenant_id!,
          sessionId: this.state.session_id!,
          executionId: id,
          heldAt: new Date(exhaustedAt),
        });
        continue;
      }
      return true;
    }
    return false;
  }

  private ensureLocalQueueInput(event: SessionEvent): QueueInputRow | null {
    if (
      event.type !== "user.message" &&
      event.type !== "user.tool_confirmation" &&
      event.type !== "user.custom_tool_result"
    ) return null;
    const eventId = (event as unknown as { id?: string }).id ?? "";
    // A queue row already exists (normal POST /event path): promote that
    // same row. If only a processed event exists, it is already history.
    const existing = this.queueRowForEvent(eventId);
    if (existing !== null) return existing;
    if (this.localEventExists(eventId)) return null;
    // custom_tool_result is processed on receipt (official CMA): keep/set
    // its JSON stamp. message / tool_confirmation stay null until drain.
    if (event.type === "user.custom_tool_result") {
      const e = event as SessionEvent & { id?: string; processed_at?: string };
      if (!e.id) e.id = `sevt_${generateEventId()}`;
      if (!e.processed_at) e.processed_at = this.processedClock.nowIso();
    } else {
      this._stampEventForPending(event);
    }
    this.queue.enqueueQueueInput(event);
    // New admission resets the no-progress horizon (see enqueueQueueInputIfNew).
    this._resetQueueDrainBackoff();
    sdoLog("queue.enqueue", {
      session_id: this._state?.session_id,
      thread_id: (event as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
      event_id: (event as { id?: string }).id ?? eventId,
      event_type: event.type,
    });
    void this._multiplexAlarm({
      reason: "queue_enqueued",
      atMs: this.processedClock.nowMs() + ENQUEUE_WAKE_DELAY_MS,
    });
    return this.queueRowForEvent(eventId);
  }

  /** Promote a queued input in place: stamp processed_at on the SAME row
   *  and id (never insert a second event id), then emit the canonical
   *  event + promotion frame so live clients can drop the outbox bubble. */
  private promoteQueueRow(row: QueueInputRow, alreadyBroadcast = false): SessionEvent {
    const nowMs = this.processedClock.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const event = JSON.parse(row.data) as SessionEvent & { processed_at?: string };
    // Official CMA: custom_tool_result is stamped on receipt — do not replace
    // that stamp at drain. message / tool_confirmation stay null until here.
    const stamp =
      event.type === "user.custom_tool_result" && typeof event.processed_at === "string"
        ? event.processed_at
        : nowIso;
    const stampMs = Date.parse(stamp);
    event.processed_at = stamp;
    this.queue.stampProcessed(row.seq, Number.isFinite(stampMs) ? stampMs : nowMs);
    // Canonical consumption is awaited by the caller before local promotion.
    sdoLog("queue.stamp", {
      session_id: this._state?.session_id,
      thread_id: row.session_thread_id,
      event_id: row.event_id,
      seq: row.seq,
      processed_at: stamp,
    });
    // Legacy admissions may have only a DO-local row even when MAIN_MCP is
    // bound. Suppress this echo only if canonical consumption actually sent it.
    if (!alreadyBroadcast) this.broadcastEvent(event);
    this.broadcastEvent({
      type: "system.user_message_promoted",
      event_id: row.event_id,
      pending_seq: row.seq,
      seq: row.seq,
      processed_at: stamp,
      session_thread_id: row.session_thread_id,
    } as SystemUserMessagePromotedEvent);
    return event;
  }

  /**
   * CMA coherent-turn steering: absorb every queued user.message on this lane
   * into the running turn at the next model boundary. Queue is mid-state only
   * (`processed_at` null until here). The execution outbox row settles as
   * completed (so it never runs as its own next turn), the local row is
   * promoted with the official CMA stamp and re-emit, and
   * `system.user_message_steered` tells clients it joined the current turn.
   * Rows another host already claimed are left alone.
   * See docs/implementation/cma-steer-coherent-turn.md.
   */
  private async takeSteeringInputs(threadId: string): Promise<SessionEvent[]> {
    const store = await this.getExecutionStore();
    const fence = this._executionFences.get(threadId);
    const stamp = this.processedClock.nowIso();
    if (store !== null && !fence) return [];
    const inputs = store !== null
      ? await takeQueuedSteeringInputs(store, {
          workspaceId: this.state.tenant_id!, sessionId: this.state.session_id!, laneId: threadId,
          steeredAt: stamp, consumer: fence!,
        })
      : this.queue.listQueue(threadId).filter(row => row.type === "user.message").map(row => ({ id: row.event_id }));
    const out: SessionEvent[] = [];
    if (!inputs.length) return out;
    for (const input of inputs) {
      this.broadcastEvent({ type: "system.user_message_steered", event_id: input.id,
        session_thread_id: threadId, steered_at: Date.parse(stamp) } as unknown as SessionEvent);
    }
    const broadcastIds = await this.consumeAcceptedInputs(inputs, fence?.executionId ?? inputs[0]!.id, stamp);
    for (const input of inputs) {
      const row = this.queueRowForEvent(input.id);
      if (row) out.push(this.promoteQueueRow(row, broadcastIds.has(row.event_id)));
      else if ('type' in input) out.push(encodeRuntimeSessionEvent(input as never) as SessionEvent);
    }
    return out;
  }

  private async drainEventQueue(threadId: string = "sthr_primary"): Promise<void> {
    // Sync re-entry mutex per thread — two callers for the same thread
    // can't both reach the SQL pending lookup before either marks a
    // row as processed.
    if (this._draining.has(threadId)) return;
    if (this.deriveStatus() === "terminated") return;
    this._draining.add(threadId);

    try {
    const history = this.openHistory();

    // New path: execution admission is the tenant-D1 outbox. Resolve this
    // before touching the legacy DO-local events queue: a central execution
    // host must not reinterpret old rows while a concurrent interrupt is
    // trying to cancel them (that race used to turn `processed_at` on before
    // the interrupt could fence the input).
    const executionStore = await this.getExecutionStore();

    // Admission is the tenant-D1 outbox. The local events queue below is
    // the fallback for sessions/hosts that intentionally do not bind MAIN_DB;
    // managed Cloudflare deployments take the outbox path.
    if (executionStore !== null) {
      const host = new SessionExecutionHost({
        store: executionStore,
        scope: {
          workspaceId: this.state.tenant_id!,
          sessionId: this.state.session_id!,
          laneId: threadId,
        },
        ownerId: this._executionOwnerId,
        clock: { now: () => new Date() },
        ids: { nextAttemptId: () => `attempt_${nanoid()}` },
        leaseTtlMs: EXECUTION_LEASE_TTL_MS,
        heartbeatIntervalMs: KEEP_ALIVE_INTERVAL_MS,
        onFenceChanged: (fence) => {
          const previous = this._executionFences.get(threadId);
          this._executionFences.set(threadId, fence);
          if (previous?.attemptId !== fence.attemptId) {
            sdoLog("lease.claim", {
              session_id: this.state.session_id,
              lane_id: threadId,
              execution_id: fence.executionId,
              attempt_id: fence.attemptId,
              generation: fence.generation,
              lease_expires_at: fence.expiresAt,
            });
          }
          // The host heartbeat is the renewal; keep the DO wake aligned so a
          // dead incarnation's lease is still swept at expiry if the alarm
          // outlives it.
          void this._multiplexAlarm({
            reason: "lease_fence",
            atMs: Date.now() + KEEP_ALIVE_INTERVAL_MS,
          });
        },
      });
      this._executionActiveLanes.add(threadId);
      // The 30s keep-alive is now a lease renewal, not a liveness hint. The
      // durable execution row remains valid if this alarm is dropped; a
      // replacement DO sweeps it after expiry via the shared policy.
      await this._armLeaseWake();
      try {
      while (true) {
        this.broadcastedMessageIds.clear();
        // Parked in requires_action: only the client's answers may run; a
        // queued user.message waits for the paused turn to finish.
        const awaitingClient = (this.state.pending_tool_calls?.length ?? 0) > 0;
        const result = await host.runOne(async (execution, fence, signal) => {
          this._executionFences.set(threadId, fence);
          const executionHistory = this.guardHistoryForExecution(history, fence);
          let holdQueuedOnLane = false;
          let turnFailed = false;
          const executionEventIds = execution.events
            .map((e) => (e as { id?: string }).id)
            .filter((id): id is string => typeof id === "string");
          sdoLog("queue.drain", {
            session_id: this.state.session_id,
            thread_id: threadId,
            source: "outbox",
            execution_id: execution.id,
            event_ids: executionEventIds,
          });
          sdoLog("queue.claim", {
            session_id: this.state.session_id,
            thread_id: threadId,
            execution_id: execution.id,
            event_ids: executionEventIds,
          });
          // The outbox path used to call processUserMessage directly, so it
          // never ran runAgentTurn's beginTurn/hintTurnInFlight pair. That
          // left no durable `sessions.turn_id` marker and relied solely on
          // the one-shot alarm above. If that alarm was lost with the
          // isolate, a cold alarm found no orphan row, finalized nothing,
          // and the multiplexer deleted it — exactly the stuck
          // status_running session from the 5d95d88 incident.
          //
          // Mark the turn in D1 and (re)arm the keep-alive BEFORE the
          // harness can issue its model request. D1 is the authority the
          // cold-start finalizer reads; the alarm is what wakes it.
          const turnId = `turn_${nanoid()}`;
          // A marker that couldn't be written doesn't fail the execution: the
          // event-log dangling-turn fallback in _finalizeStaleTurns still
          // ends it after a reset.
          const turnMarker = await openTurnMarker(this.runtimeAdapter, this.state.session_id, turnId, {
            began: (id) => { this._activeTurnIds.add(id); },
            ended: (id) => { this._activeTurnIds.delete(id); },
          });
          sdoLog("turn.begin", {
            session_id: this.state.session_id,
            thread_id: threadId,
            turn_id: turnId,
            execution_id: execution.id,
            d1_marked: turnMarker.marked,
          });
          // Await the durable write. A fire-and-forget setAlarm can be lost
          // if the isolate resets right after the turn starts.
          await this._armLeaseWake("turn_start");
          // Lane is running a new execution (held rows already absorbed on
          // claim): drop the exhausted mark unless a pre-exhausted queued
          // input still awaits fallback admission.
          {
            const at = this.state.exhausted_at_by_lane?.[threadId];
            if (at !== undefined && !this.queue.listQueue(threadId).some((r) =>
              r.enqueued_at <= at && !execution.events.some((e) => (e as { id?: string }).id === r.event_id))) {
              this.setExhaustedAt(threadId, undefined);
            }
          }
          try {
            const broadcastIds = await this.consumeAcceptedInputs(execution.events, execution.id, this.processedClock.nowIso());
            for (const rawEvent of execution.events) {
              if (rawEvent.type === "system.message") continue;
              if (rawEvent.type === "session.updated") {
                // Budget resume: continue from history, no new user input.
                if (rawEvent.resume === true) {
                  await this.processUserMessage({
                    type: "user.message",
                    content: [{ type: "text", text: "" }],
                  }, 0, true, signal, fence);
                }
                continue;
              }
              // Execution rows use the Managed Agents domain shape. The DO
              // runtime uses the legacy wire shape, so this is the one
              // explicit protocol projection at the host boundary.
              const event = encodeRuntimeSessionEvent(rawEvent as never) as SessionEvent;
              const localQueued = this.ensureLocalQueueInput(event);
              if (localQueued !== null) this.promoteQueueRow(localQueued, broadcastIds.has(localQueued.event_id));
              if (event.type === "user.message") {
                const turn = await this.processUserMessage(event as UserMessageEvent, 0, false, signal, fence);
                if (turn?.holdQueuedOnLane) {
                  holdQueuedOnLane = true;
                  this.setExhaustedAt(threadId, Date.now());
                }
              } else if (event.type === "user.tool_confirmation") {
                await this.handleToolConfirmation(event as UserToolConfirmationEvent, executionHistory, signal, fence);
              } else if (event.type === "user.custom_tool_result") {
                const customResult = event as UserCustomToolResultEvent;
                // Late answer for a call that is already closed (interrupt
                // settled it, or a duplicate POST): a second tool_result for
                // one tool_use makes the provider 400 the whole transcript.
                if (this.toolUseAlreadyAnswered(customResult.custom_tool_use_id, executionHistory)) continue;
                const toolResultEvent: SessionEvent = {
                  type: "agent.tool_result",
                  tool_use_id: customResult.custom_tool_use_id,
                  content: (customResult.content ?? [])
                    .map((b) => b.type === "text" ? b.text : "").join(""),
                  parent_event_id: customResult.custom_tool_use_id,
                };
                executionHistory.append(toolResultEvent);
                this.broadcastEvent(toolResultEvent, fence);
                await this.resumeWhenToolBatchSettled(customResult.custom_tool_use_id, executionHistory, signal, fence);
              }
            }
            // `broadcastEvent` deliberately serializes the managed-runtime
            // projection in a promise chain.  Drain that chain while this
            // lease is still active; otherwise the host could settle the
            // execution first and every fenced projection would correctly
            // be rejected as stale.  This is the commit barrier between the
            // harness side effects and execution settlement.
            await this._managedProjectionChain;
            // Node parity (runner `afterExecution`): terminal facts are
            // committed and this attempt still holds its fence, so completed
            // root-turn outputs become Agents API artifacts before settle.
            if (threadId === "sthr_primary" && !signal.aborted) {
              await this.publishAgentsApiArtifacts(fence);
            }
            return holdQueuedOnLane ? { holdQueuedOnLane: true } : undefined;
          } catch (err) {
            turnFailed = true;
            throw err;
          } finally {
            const currentFence = this._executionFences.get(threadId);
            if (
              currentFence?.executionId === fence.executionId &&
              currentFence.attemptId === fence.attemptId
            ) {
              this._executionFences.delete(threadId);
            }
            // Mirror runAgentTurn's finally: clear the D1 marker before the
            // host settles the execution so a successful turn never looks
            // like a cold-start orphan. Filter by turnId inside endTurn, so
            // a finalizer that already ended this turn makes this a no-op.
            const endTurnOk = await turnMarker.end();
            sdoLog("turn.end", {
              session_id: this.state.session_id,
              thread_id: threadId,
              turn_id: turnId,
              execution_id: execution.id,
              reason: signal.aborted
                ? "aborted"
                : turnFailed
                  ? "error"
                  : holdQueuedOnLane
                    ? "held"
                    : "completed",
              d1_marked: turnMarker.marked,
              end_turn_ok: endTurnOk,
            });
          }
        }, { continuationsOnly: awaitingClient });
        if (result.type === "empty") {
          // Direct DO callers and pre-outbox deliveries may have a queued
          // input row but no D1 admission yet. Admit it once as a
          // reconciliation step; normal main-worker traffic already has the
          // atomic D1 outbox row and takes the claim path directly.
          if (await this.admitQueueFallback(executionStore, threadId)) continue;
          break;
        }
        if (result.type === "completed") continue;
        // An interrupt cancels only the running execution; queued ones
        // survive and drain next (Backchat policy). After cancelSession the
        // queue is empty and the next runOne returns "empty".
        if (result.type === "cancelled") continue;
        if (result.type === "failed") {
          const errorEvent: SessionEvent = {
            type: "session.error",
            error: result.error.message,
          };
          history.append(errorEvent);
          this.broadcastEvent(errorEvent);
        } else {
          // A stale incarnation may still have emitted live chunks, but it
          // cannot commit a terminal event. The next alarm/request reclaims.
          console.warn(`[drain] execution ${result.execution.id} lost its lease`);
        }
        break;
      }
      } finally {
        this._executionActiveLanes.delete(threadId);
      }
      return;
    }

    while (true) {
      // Peek the next active queued input (events row, processed_at NULL).
      // Promotion stamps the same row/id in place — no re-insert, no
      // second event id, no delete-then-append window.
      const row = this.queue.peekQueueInput(threadId);
      if (!row) break;

      // Fresh per-turn dedup window for agent.message broadcasts. See
      // broadcastedMessageIds field doc for the recovery-replay context.
      this.broadcastedMessageIds.clear();

      // Stamp processed_at = now on the SAME row. AMA spec: processed_at is
      // the wall-clock ingestion time (when the agent picks the event up),
      // not when the turn finishes.
      sdoLog("queue.drain", {
        session_id: this.state.session_id,
        thread_id: threadId,
        source: "local_queue",
        event_id: row.event_id,
      });
      sdoLog("queue.claim", {
        session_id: this.state.session_id,
        thread_id: threadId,
        source: "local_queue",
        event_id: row.event_id,
      });
      const broadcastIds = await this.consumeAcceptedInputs([{ id: row.event_id }], row.event_id, this.processedClock.nowIso());
      const event = this.promoteQueueRow(row, broadcastIds.has(row.event_id));

      const turnName = `turn:${row.seq}`;
      sdoLog("turn.begin", {
        session_id: this.state.session_id,
        thread_id: threadId,
        turn_id: turnName,
        source: "local_queue",
        event_id: row.event_id,
        event_type: event.type,
      });
      let localTurnReason = "completed";
      try {
        // Run the turn through the unified runtime: adapter.beginTurn /
        // endTurn write the marker on `sessions.turn_id`, hintTurnInFlight
        // wires CF's setAlarm-30s keep-alive, backup/persist runs
        // synchronously at end (no waitUntil race). Same shape Node's
        // SessionStateMachine uses; the body here stays in SessionDO
        // because DO has CF-only features (DO state push, schedule API,
        // sandbox warmup, sub-agents) the machine doesn't speak.
        await runAgentTurn(
          this.turnRuntimeAdapter(),
          turnName,
          async () => {
            if (event.type === "user.message") {
              await this.processUserMessage(event as UserMessageEvent);
            } else if (event.type === "user.tool_confirmation") {
              await this.handleToolConfirmation(event as UserToolConfirmationEvent, history);
            } else if (event.type === "user.custom_tool_result") {
              const customResult = event as UserCustomToolResultEvent;
              if (this.toolUseAlreadyAnswered(customResult.custom_tool_use_id, history)) return;
              const toolResultEvent: SessionEvent = {
                type: "agent.tool_result",
                tool_use_id: customResult.custom_tool_use_id,
                content: customResult.content.map(b => b.type === "text" ? b.text : "").join(""),
                // v1-additive (docs/trajectory-v1-spec.md "Causality"):
                // matching agent.custom_tool_use's EventBase.id IS the
                // custom_tool_use_id (AgentCustomToolUseEvent.id overrides
                // EventBase.id with `id: string`).
                parent_event_id: customResult.custom_tool_use_id,
              };
              history.append(toolResultEvent);
              this.broadcastEvent(toolResultEvent);
              await this.resumeWhenToolBatchSettled(customResult.custom_tool_use_id, history);
            }
          },
          {},
        );
        // Turn finished cleanly — clear any prior recovery counter so the
        // next turn doesn't inherit stale state.
        await clearTurnRecoveryCount(this.turnRuntimeAdapter(), turnName);
      } catch (err) {
        if (err instanceof TurnAborted) {
          console.warn(`[drain] turn ${turnName} aborted: ${err.cause.kind}`);
        }
        // User-initiated interrupt is not a session.error — the
        // POST /event handler for user.interrupt has already
        // appended `user.interrupt` + `session.status_idle`, and
        // the harness's stream-end fixup persisted any partial
        // agent.message. Writing session.error here would just
        // pollute the timeline with a misleading "error" frame.
        // Other TurnAborted causes (model_error 402/403, MCP
        // timeout, manual destroy) still surface as session.error
        // since the user didn't trigger them.
        const isUserInterrupt =
          err instanceof TurnAborted && err.cause.kind === "user_aborted";
        localTurnReason = isUserInterrupt ? "user_aborted" : "error";
        if (!isUserInterrupt) {
          const errorMsg = this.describeError(err);
          const errorEvent: SessionEvent = { type: "session.error", error: errorMsg };
          history.append(errorEvent);
          this.broadcastEvent(errorEvent);
        }

        // AMA RetryStatusTerminal: certain model errors are unrecoverable
        // and must transition the session to `terminated` state. Today we
        // catch payment/quota-fatal HTTP statuses (402 payment required,
        // 403 forbidden — providers return these when an org is over its
        // spend cap; retrying the same key won't succeed).
        // Other terminal sources (MCP auth refresh failure) live in the
        // tools.ts / main proxy path and are not visible here.
        if (
          err instanceof TurnAborted &&
          err.cause.kind === "model_error" &&
          (err.cause.status === 402 || err.cause.status === 403)
        ) {
          this.terminate("payment_required");
        }
        // The promoted row is the same events row with processed_at now
        // set (no separate queue row to delete). Status auto-derives from
        // sessions.turn_id once the RuntimeAdapter.endTurn callback fires.
        // A user interrupt ends the active turn and has already cancelled
        // this thread's queued inputs. Any other failure stops the drain so
        // the client decides. (The continue simply re-checks the queue.)
        if (isUserInterrupt) continue;
        break;
      } finally {
        sdoLog("turn.end", {
          session_id: this.state.session_id,
          thread_id: threadId,
          turn_id: turnName,
          source: "local_queue",
          reason: localTurnReason,
        });
      }
      // Row is promoted in place (processed_at set). Loop back for the next
      // queued input on this thread.
    }
    } finally {
      this._draining.delete(threadId);
    }
  }

  /**
   * Build the adapter turn-runtime needs from this DO. Returns a
   * RuntimeAdapter (the unified adapter Node also uses) wrapped in the
   * thin TurnRuntimeAgent shape that pins it to this DO's sessionId
   * and exposes ctx.storage for the recovery counter.
   *
   * The RuntimeAdapter's `hintTurnInFlight` callback is wired here to
   * setAlarm(now+30s) — this is CF's keep-alive: the alarm rearms
   * itself in alarm() so the DO doesn't get evicted while a turn is
   * in flight. Cheap; setAlarm cost is one storage write.
   */
  private turnRuntimeAdapter(): TurnRuntimeAgent {
    return {
      adapter: this.runtimeAdapter,
      sessionId: this.state.session_id,
      storage: {
        get: <T = unknown,>(key: string) => this.ctx.storage.get<T>(key),
        put: <T = unknown,>(key: string, value: T) => this.ctx.storage.put(key, value),
        delete: (key: string) => this.ctx.storage.delete(key).then(() => undefined),
      },
    };
  }

  /**
   * Lazily-built unified RuntimeAdapter for this session. Reused across
   * turns. The adapter holds:
   *   - sql: per-tenant D1 (resolved via buildCfTenantDbProvider) for
   *     beginTurn/endTurn/listOrphanTurns against the unified `sessions`
   *     table.
   *   - eventLog/streams: this DO's CfDoEventLog/CfDoStreamRepo (per-DO
   *     storage SQL — fast, transactional with the rest of DO state).
   *   - hintTurnInFlight: setAlarm(now+30s). The alarm() handler
   *     rearms itself while a turn is still in flight (sessions row
   *     status='running'), so an LLM streaming call lasting > 30s
   *     keeps the DO warm.
   */
  private get runtimeAdapter(): RuntimeAdapter {
    if (this._runtimeAdapter) return this._runtimeAdapter;
    if (!this._state) {
      throw new Error("runtimeAdapter accessed before state loaded");
    }
    const tenantId = this._state.tenant_id;
    // Lazy-resolve the per-tenant D1 binding. buildCfTenantDbProvider
    // returns the MAIN_DB shard the routing table maps this tenant to.
    // We construct the SqlClient eagerly and cache the adapter — the
    // tenant doesn't change for the lifetime of a SessionDO instance.
    const provider = buildCfTenantDbProvider(this.env);
    // provider.resolve is async; we synchronously construct using a
    // wrapper SqlClient that resolves on first call. Simpler: just hold
    // a Promise-backed SqlClient. Even simpler: assume the synchronous
    // path (env.MAIN_DB) since most deploys are single-shard. Fall back
    // to async resolve via a thin wrapper when sharded.
    const db = (this.env as unknown as { MAIN_DB?: D1Database }).MAIN_DB;
    if (!db) {
      throw new Error(
        "runtimeAdapter: env.MAIN_DB binding missing — required for unified sessions table writes",
      );
    }
    const sql = new CfD1SqlClient(db);
    if (!this.streams) this.ensureSchema();
    const eventLog: EventLogRepo = new CfDoEventLog(
      this.ctx.storage.sql,
      (e) => {
        const ev = e as SessionEvent & { id?: string; processed_at?: string };
        if (!ev.id) ev.id = `sevt_${generateEventId()}`;
        if (!ev.processed_at) ev.processed_at = this.processedClock.nowIso();
      },
      this.env.MEMORY_BUCKET ?? null,
      `t/${tenantId}/sessions/${this._state.session_id}/events/`,
    );
    const streams = this.streams!;
    this._runtimeAdapter = new RuntimeAdapterImpl({
      sql,
      eventLog,
      streams,
      // No sandbox at adapter level — turn-runtime doesn't use it; the
      // legacy sandbox getter (this.getOrCreateSandbox()) stays as-is
      // for the harness path which constructs its own ctx.
      onTurnInFlight: (_sessionId, turnId) => {
        // The adapter hook is sync/fire-and-forget by contract. Callers
        // that can await (the outbox drain) also call _armLeaseWake()
        // directly before the model request; this keeps the legacy
        // runAgentTurn path covered too.
        void this._armLeaseWake();
        // Register this turn id so _checkOrphanTurns + deriveStatus
        // see it. Lost on eviction → cold-start sees empty set → real
        // orphans (D1 row from a dead incarnation) get recovered on
        // the first alarm pass.
        this._activeTurnIds.add(turnId);
      },
      onTurnEnded: (_sessionId, turnId) => {
        // Idempotent: turn-lifetime.ts also fires hintTurnEnded as a
        // safety net in its outer finally if endTurn itself throws.
        // Set.delete on missing key is a no-op.
        this._activeTurnIds.delete(turnId);
      },
    });
    // Provider call only used if sharding is in play; today the lazy
    // env.MAIN_DB path covers the single-shard default. Keep the
    // import live so future per-tenant shards plug in here.
    void provider;
    return this._runtimeAdapter;
  }

  /**
   * Get the sequence number of the last event of a given type.
   * Returns 0 if no such event exists.
   */
  private getLastEventSeq(type: string): number {
    const result = this.ctx.storage.sql.exec(
      "SELECT seq FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1",
      type
    );
    for (const row of result) return row.seq as number;
    return 0;
  }

  /**
   * Get the first event after a given sequence number matching any of the given types.
   * Returns null if no matching event exists.
   */
  private getFirstEventAfter(afterSeq: number, types: string[]): { seq: number; data: string } | null {
    const placeholders = types.map(() => "?").join(", ");
    const result = this.ctx.storage.sql.exec(
      `SELECT seq, data FROM events WHERE seq > ? AND type IN (${placeholders}) ORDER BY seq ASC LIMIT 1`,
      afterSeq,
      ...types,
    );
    for (const row of result) return { seq: row.seq as number, data: row.data as string };
    return null;
  }

  /**
   * Override fetch to keep our custom HTTP routing.
   * Agent (via partyserver) auto-handles WebSocket upgrades and calls
   * onRequest() for HTTP — but we have custom routing for both, so we
   * handle everything here and only delegate alarm() to Agent's scheduler.
   */
  async fetch(request: Request): Promise<Response> {
    // Cold-start orphan flush: first request after DO activation triggers
    // a one-shot scan of unpaired tool_use + stale 'running' turns and
    // emits abort events for them. Idempotent (cheap when there's nothing
    // stale). Captures the case where a previous incarnation died
    // mid-stream — the alarm path catches the same condition but only
    // after the first alarm tick fires, which can be many seconds after
    // the user's first request lands.
    //
    // Guard semantics: the boolean is set BEFORE the async flush so two
    // concurrent first-fetches don't both fire the flush. On flush
    // failure the guard resets to false so a subsequent fetch retries —
    // a permanently-sticky guard would leave the recovery primitive
    // dead after a transient error.
    if (!this._coldStartFlushDone) {
      this._coldStartFlushDone = true;
      void this._finalizeStaleTurns().catch((err) => {
        console.warn(`[cold-start-flush] failed:`, err);
        this._coldStartFlushDone = false;
      });
    }
    try {
      return await this.fetchInner(request);
    } catch (err) {
      // Top-level catch so a single bad row / parse / unhandled throw doesn't
      // collapse to opaque "Internal Server Error" text from the runtime.
      // Caller gets structured JSON + the route they hit + a stable shape.
      const url = new URL(request.url);
      const msg = err instanceof Error ? (err.message || err.name) : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : undefined;
      console.error(`[session-do.fetch] ${request.method} ${url.pathname} → 500: ${msg}\n${stack ?? ""}`);
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message: msg.slice(0, 500),
          method: request.method,
          path: url.pathname,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  private async fetchInner(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);

    // PUT /init — initialize session
    if (request.method === "PUT" && url.pathname === "/init") {
      const params = (await request.json()) as SessionInitParams;
      this.setState({
        ...this.state,
        agent_id: params.agent_id,
        environment_id: params.environment_id,
        title: params.title,
        session_id: params.session_id || this.state.session_id,
        tenant_id: params.tenant_id ?? "default",
        vault_ids: params.vault_ids ?? [],
        agent_snapshot: params.agent_snapshot,
        environment_snapshot: params.environment_snapshot,
        sandbox_image: params.sandbox_image ?? null,
        vault_credentials: params.vault_credentials,
        event_hooks: params.event_hooks,
        terminated_at: null,
        // Stamp wall-clock create on first /init only — re-init shouldn't
        // reset the alive-seconds counter mid-session. (D1's
        // sessions.created_at is the canonical source; this DO copy lets
        // terminate compute elapsed without an async D1 read on the way out.)
        created_at_ms: this.state.created_at_ms ?? Date.now(),
        session_alive_billed: false,
      });

      // Outbound credential snapshot — DELETED. The legacy path published
      // a per-session KV blob containing plaintext vault credentials so the
      // outbound interceptor (apps/agent/src/outbound.ts) could look them
      // up by sessionId without going back to D1. That blob lived in the
      // agent worker's KV namespace and contained OAuth tokens / API keys
      // — i.e. plaintext secrets visible to anyone with KV-read access in
      // the agent worker scope. Post-refactor the interceptor RPCs into
      // main on each call (apps/agent/src/oma-sandbox.ts → env.MAIN_MCP
      // .credentialEgress), main does the live vault lookup, and the agent
      // worker never holds plaintext credentials. See file-level comment
      // on apps/agent/src/oma-sandbox.ts for the full rationale.

      // Seed the primary thread row in DO SQLite. Done after setState so
      // _ensurePrimaryThread can read agent_id / agent_snapshot from
      // this.state. Idempotent (INSERT OR IGNORE) — safe across re-init.
      this._ensurePrimaryThread();

      // Pre-flight events from main worker (e.g. credential refresh warnings).
      // Append in order so the console renders them as the first items in the
      // session timeline. Use persistAndBroadcastEvent so each event also
      // fans out to event_hooks (Linear panel mirror, etc.) — state was just
      // set above so event_hooks is populated by the time we get here.
      if (params.init_events?.length) {
        for (const ev of params.init_events) {
          this.persistAndBroadcastEvent(ev);
        }
      }

      // Canonical session creation has already admitted bootstrap work in the
      // tenant outbox. Wake the same execution host used by later events;
      // replaying init must never create another input or execution entity.
      if (request.headers.has("x-oma-workspace-id")) {
        await this._multiplexAlarm({
          reason: "bootstrap_execution",
          atMs: Date.now() + ENQUEUE_WAKE_DELAY_MS,
        });
        void this.recoverExecutionQueue().catch(error => {
          console.error("[session_do] bootstrap execution wakeup failed", error);
        });
      }

      // NO ctx.waitUntil(this.warmUpSandbox()) — that pattern dies on
      // DO reset (which happens regularly under our concurrent traffic
      // pattern). Let warmUp fire lazily on the first /event handler
      // below, where it runs as part of the user's request and holds the
      // DO alive for the full duration. First user
      // message pays the cold-start cost (~1-3 min for an env that
      // needs install + snapshot); subsequent messages restore in
      // seconds from the persisted handle.

      return new Response("ok");
    }

    // DELETE /destroy — tear down sandbox and clean up
    if (request.method === "DELETE" && url.pathname === "/destroy") {
      // Abort every in-flight thread (primary + any sub-agents).
      for (const ctrl of this._threadAbortControllers.values()) {
        ctrl.abort();
      }
      this._threadAbortControllers.clear();
      await this._primaryHarness.dispose();
      // Snapshot /workspace BEFORE we destroy the container — once destroy()
      // runs the container is gone and we can't read its filesystem.
      // CF's "persist across sessions" pattern (changelog 2026-02-23):
      // squashfs of /workspace lands in BACKUP_BUCKET; the handle goes into
      // D1 keyed by (tenant, env). Next session in the same scope's warmup
      // looks it up and restoreBackup's it. Force=true bypasses the
      // turn-end debounce so we always get a final snapshot.
      //
      // Force-create the sandbox wrapper if this.sandbox is null (SessionDO
      // was hibernated, in-memory ref lost). Without this, a hibernated
      // SessionDO that gets a /destroy request would skip both the backup
      // AND the actual container destroy, leaving the container running
      // until sleepAfter SIGTERM (with no final snapshot).
      if (!this.sandbox) {
        try { await this.getOrCreateSandbox(); } catch {}
      }
      // Final snapshot — awaited so the squashfs lands in BACKUP_BUCKET
      // before sandbox.destroy() wipes the container. Implementation lives
      // on OmaSandbox.snapshotWorkspaceNow (single source of truth, also
      // used by the sleepAfter onActivityExpired hook). Best-effort: any
      // failure logs and we proceed with destroy.
      if (supportsManagedWorkspaceLifecycle(this.sandbox)) {
        try { await this.sandbox.snapshotWorkspaceNow(); } catch {}
      }
      // Emit sandbox_active_seconds BEFORE destroy. CF's onStop callback
      // runs async to destroy() and can be dropped if the OmaSandbox DO
      // gets evicted before it fires (observed empirically on staging).
      // The explicit emit here puts the write in SessionDO's request
      // lifecycle — synchronous and reliable. onStop still wired as a
      // fallback for non-/destroy teardowns (sleepAfter, OOM); the
      // emit is idempotent (storage delete after success).
      const sandboxBilling = this.sandbox as unknown as {
        emitSandboxActiveNow?: () => Promise<void>;
      } | null;
      if (sandboxBilling?.emitSandboxActiveNow) {
        try { await sandboxBilling.emitSandboxActiveNow(); } catch (err) {
          logWarn({ op: "session_do.destroy.sandbox_emit", session_id: this.state.session_id, err }, "sandbox usage emit failed");
        }
      }
      // Destroy the sandbox container (kills processes, unmounts, stops container)
      if (this.sandbox?.destroy) {
        try { await this.sandbox.destroy(); } catch (err) {
          logWarn({ op: "session_do.destroy.sandbox", session_id: this.state.session_id, err }, "sandbox destroy failed");
        }
      }
      this.sandbox = null;
      this.portsSandbox = null;
      this.wrappedSandbox = null;
      this.sandboxRuntime = null;
      // Close the browser session if one was created
      if (this.browserSession) {
        try { await this.browserSession.close(); } catch (err) {
          logWarn({ op: "session_do.destroy.browser", session_id: this.state.session_id, err }, "browser session close failed");
        }
        this.browserSession = null;
      }
      this.browserHarness = null;
      // Outbound snapshot delete — DROPPED. The publish at session init
      // is gone too (see comment above), so there's nothing here to clean
      // up. The outbound interceptor RPCs into main on each call and main
      // re-checks session.archived_at, so an archived session's outbound
      // calls naturally fail without any KV cleanup needed.
      this.terminate("session_deleted");

      return new Response("ok");
    }

    // POST /event — receive user event, kick off harness
    if (request.method === "POST" && url.pathname === "/event") {
      // AMA semantics: a terminated session is one-way; reject new
      // events at the door so callers see a clean 409 envelope rather
      // than appending a dead-letter event the harness will never run.
      // Mirrors the main worker's archived_at check on POST /v1/sessions/:id/events.
      if (this._state?.terminated_at != null || this._state?.status === "terminated") {
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Session is terminated and cannot receive new events",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      const raw = (await request.json()) as SessionEvent & { _mount_file_ids?: string[] };
      // Sidecar field set by main worker's events POST resolver. Strip it
      // before persisting — it is delivery metadata, not part of the canonical
      // event schema.
      const mountFileIds = raw._mount_file_ids;
      delete (raw as { _mount_file_ids?: string[] })._mount_file_ids;
      const body = raw as SessionEvent;
      // Reject events targeting an archived thread before any side effects
      // (history.append, broadcastEvent, drainEventQueue). Primary thread
      // can't be archived (handler at /threads/:tid/archive enforces 400),
      // so 'sthr_primary' is always allowed without a SQL lookup.
      const targetThreadId =
        (body as unknown as { session_thread_id?: string }).session_thread_id ??
        "sthr_primary";
      if (targetThreadId !== "sthr_primary") {
        let archived = false;
        for (const row of this.ctx.storage.sql.exec(
          `SELECT archived_at FROM threads WHERE id = ? LIMIT 1`,
          targetThreadId,
        )) {
          archived = row.archived_at != null;
        }
        if (archived) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: `Thread ${targetThreadId} is archived and cannot receive new events`,
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
      }
      const history = this.openHistory();

      // Auto-mount referenced files into the sandbox FS so agent's bash/read
      // tools see them at /mnt/session/uploads/{file_id}, while the model
      // already sees the inline base64 from the resolver. Mirrors Anthropic
      // managed-agents dual path. Best-effort — failure does not block the
      // event from being processed.
      if (mountFileIds && mountFileIds.length > 0 && this.env.FILES_BUCKET) {
        // Wrapped sandbox: first .exec/.writeFileBytes will await warmup.
        const sandbox = await this.getOrCreateSandbox();
        const tenantId = this.state.tenant_id;
        try { await sandbox.exec("mkdir -p /mnt/session/uploads", 5000); } catch {}
        for (const fid of mountFileIds) {
          try {
            const obj = await this.env.FILES_BUCKET.get(`t/${tenantId}/files/${fid}`);
            if (!obj) continue;
            const buf = await obj.arrayBuffer();
            const path = `/mnt/session/uploads/${fid}`;
            if (sandbox.writeFileBytes) {
              await sandbox.writeFileBytes(path, new Uint8Array(buf));
            } else {
              await sandbox.writeFile(
                path,
                new TextDecoder("utf-8").decode(new Uint8Array(buf)),
              );
            }
          } catch (err) {
            logWarn(
              { op: "session_do.auto_mount.file", session_id: this.state.session_id, file_id: fid, err },
              "auto-mount file write failed",
            );
          }
        }
      }

      if (body.type === "user.message") {
        const um = body as UserMessageEvent;
        const umThread =
          (um as unknown as { session_thread_id?: string })
            .session_thread_id ?? "sthr_primary";
        // Official CMA / t307u: while idle requires_action or budget_reached,
        // user.message is a 400 — only settle events are accepted.
        {
          const settleReason = this.laneSettleOnlyReason(history, umThread);
          if (settleReason !== null) {
            return new Response(
              JSON.stringify({
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: settleOnlyRejectMessage(settleReason, ["user.message"]),
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
        }
        // Stamp id and leave processed_at absent before enqueue. The queue
        // row IS this event; drain stamps the same row/id when promoting.
        this._stampEventForPending(um);
        const enqueued = this.enqueueQueueInputIfNew(um);
        // Broadcast the AMA-spec "pending" notification so live
        // consumers can render the outbox bubble immediately. Carries
        // pending_seq so the matching `system.user_message_promoted`
        // frame can correlate the bubble with the eventual events-log
        // row at drain time.
        if (enqueued) this._broadcastPendingFrame(um, umThread);
        if (enqueued) {
          try {
            await this.schedule(5, "recoverEventQueue");
          } catch {}
        }
        // Fire-and-forget the drain. ctx.waitUntil is a no-op inside DO classes
        // (Workers Context API is stateless-only — see CF docs), so don't try
        // to use it. The DO is kept alive instead by:
        //   (a) the unified RuntimeAdapter's hintTurnInFlight callback —
        //       wired in this DO's constructor to setAlarm(now+30s). The
        //       alarm() handler rearms itself while a turn is still in
        //       flight (sessions row status='running'), AND
        //   (b) the keepAliveWhile no-op the harness still receives in
        //       its HarnessRuntime — purely a stub today; the alarm-
        //       rearm path covers what it used to defend.
        // The 5s recoverEventQueue schedule above is the safety-net
        // re-trigger if this background promise dies before drain runs.
        console.log(`[post /event] user.message enqueued (thread=${umThread}), firing drainEventQueue`);
        if (enqueued) this.drainEventQueue(umThread);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.interrupt") {
        // AMA-spec semantics for user.interrupt:
        //   1. Abort the in-flight turn for the target thread (only that
        //      thread — siblings keep running). If no session_thread_id
        //      is set, defaults to primary.
        //   2. Flush queued user.* inputs (AMA: "queued inputs are
        //      flushed"): they are marked cancelled_at and never promote.
        //      DELETE /pending/:event_id can also cancel one specific row.
        //   3. Append the user.interrupt event itself + idle marker.
        const targetThread =
          (body as unknown as { session_thread_id?: string })
            .session_thread_id ?? "sthr_primary";
        const ctrl = this._threadAbortControllers.get(targetThread);
        const hadActiveTurn = !!ctrl;
        // Official CMA: "Against an already-idle session an interrupt is
        // normally a no-op." That includes idle requires_action: accept the
        // interrupt, leave event_ids / pending_tool_calls / stop_reason
        // untouched, and do not call interruptPending or emit a fresh idle.
        // (Self-hosted failed-claim re-queue is the documented exception and
        // is not this path.)
        {
          let idleStop: string | undefined;
          let lastStatus: string | undefined;
          for (const e of history.getEvents()) {
            if (((e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary") !== targetThread) continue;
            if (e.type === "session.status_running" || e.type === "session.status_idle") {
              lastStatus = e.type;
              idleStop = e.type === "session.status_idle"
                ? ((e as { stop_reason?: { type?: string } }).stop_reason?.type ?? "")
                : undefined;
            }
          }
          if (!hadActiveTurn && lastStatus === "session.status_idle") {
            const interrupt = body as UserInterruptEvent & { id?: string; processed_at?: string };
            const interruptAt = this.processedClock.nowIso();
            if (!interrupt.id) interrupt.id = `sevt_${generateEventId()}`;
            interrupt.processed_at = interruptAt;
            this.markAcceptedEventsProcessed([interrupt.id], interruptAt);
            history.append(interrupt);
            this.broadcastEventIgnoringExecutionFence(interrupt);
            void idleStop; // retained for readability / future budget carve-outs
            return new Response(null, { status: 202 });
          }
        }
        // The execution store is the durable interrupt authority. The local
        // AbortController is only a latency optimization for this DO
        // incarnation; a replacement host observes the same request through
        // its next renew/claim and cannot resurrect the cancelled generation.
        const executionStore = await this.getExecutionStore();
        if (executionStore !== null && this.state.tenant_id && this.state.session_id) {
          await executionStore.requestInterrupt({
            workspaceId: this.state.tenant_id,
            sessionId: this.state.session_id,
            laneId: targetThread,
            requestedAt: new Date().toISOString(),
          });
        }
        if (ctrl) {
          // The handler owns the interrupted turn's idle from here on.
          this._interruptIdleOwned.add(targetThread);
          ctrl.abort();
          this._threadAbortControllers.delete(targetThread);
          // Official CMA: "the interrupt can take longer to apply while tool
          // calls are running" and processed_at stays null until applied.
          // Give the aborted turn a short grace (Codex: cancel token, then
          // bounded wait) to unwind its tools before we stamp the interrupt.
          // Wait on THIS turn's settlement, not lane activity: the lane may
          // already be running the next queued user.message.
          const settledTurn = this._turnSettled.get(ctrl);
          if (settledTurn) {
            await Promise.race([settledTurn, new Promise((resolve) => setTimeout(resolve, INTERRUPT_GRACE_MS))]);
          }
        }
        const cancelTs = Date.now();
        // user.interrupt is separate from steer (cma-steer-coherent-turn.md):
        // interrupt → idle; a following user.message starts the NEXT turn.
        // AMA "queued inputs are flushed": cancel every active queued input
        // on this thread by stamping cancelled_at on the SAME events rows
        // (processed_at stays NULL, so they never promote). Cancelling one
        // specific row is also available through DELETE /pending/:event_id.
        const cancelledRows = this.queue.cancelQueueForThread(targetThread, cancelTs);
        const cancelledCount = cancelledRows.length;
        for (const row of cancelledRows) {
          this.broadcastEventIgnoringExecutionFence({
            type: "system.user_message_cancelled",
            pending_seq: row.seq,
            event_id: row.event_id,
            session_thread_id: row.session_thread_id,
            cancelled_at: cancelTs,
          } as SystemUserMessageCancelledEvent);
        }
        const settledRequests: string[] = [];
        if (!hadActiveTurn && (this.state.pending_tool_calls?.length ?? 0) > 0) {
          const pendingIds = new Set(this.state.pending_tool_calls.map((pending) => pending.toolCallId));
          const pendingActions = history.getEvents().filter((event) =>
            "id" in event && typeof event.id === "string" && pendingIds.has(event.id) &&
            ((event as { session_thread_id?: string }).session_thread_id ?? "sthr_primary") === targetThread,
          );
          if (pendingActions.length > 0) {
            const threadAgent = targetThread === "sthr_primary" ? this.state.agent_id
              : [...this.ctx.storage.sql.exec("SELECT agent_id FROM threads WHERE id = ? LIMIT 1", targetThread)][0]?.agent_id;
            const agent = typeof threadAgent === "string" ? await this.getAgentConfig(threadAgent) : null;
            if (agent) {
              try {
                // Resolve through the registry even after DO eviction; no
                // in-memory AbortController exists once a callback paused run.
                const harness = resolveHarness(agent.harness || "default");
                const settled = await harness.interruptPending?.({ agent, session_id: this.state.session_id,
                  tenant_id: this.state.tenant_id, runnerRelay: createRuntimeRoomRelay(this.env.RUNTIME_ROOM), pendingActions });
                settledRequests.push(...(settled ?? []).filter((id) => pendingActions.some((event) => "id" in event && event.id === id)));
              } catch {
                return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "Runner interrupt was not confirmed. The pending action is still available; reconnect and try again." } }),
                  { status: 503, headers: { "content-type": "application/json" } });
              }
            }
          }
          if (settledRequests.length > 0) {
            const settled = new Set(settledRequests);
            this.setState({ ...this.state, pending_tool_calls: this.state.pending_tool_calls.filter((pending) => !settled.has(pending.toolCallId)) });
            for (const requestId of settled) {
              // Reuse the same error extension emitted by orphan-tool recovery.
              const result: SessionEvent & { is_error: true } = { type: "agent.tool_result", tool_use_id: requestId,
                content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }], is_error: true,
                ...(targetThread !== "sthr_primary" ? { session_thread_id: targetThread } : {}),
              };
              history.append(result);
              this.broadcastEvent(result);
            }
          }
        }
        const interrupt = body as UserInterruptEvent & { id?: string; processed_at?: string };
        const interruptAt = this.processedClock.nowIso();
        if (!interrupt.id) interrupt.id = `sevt_${generateEventId()}`;
        interrupt.processed_at = interruptAt;
        this.markAcceptedEventsProcessed([interrupt.id], interruptAt);
        history.append(interrupt);
        // Claude Managed Agents: user.interrupt itself appears on the stream.
        this.broadcastEventIgnoringExecutionFence(interrupt);
        // Emit status_idle when interrupt actually changed thread state:
        // either an active turn was aborted, or queued events were
        // cancelled. Skip when both are false (no-op interrupt) — that
        // case had been emitting a duplicate status_idle right after a
        // natural-end one, observed 2026-05-11 sess-y5saq (seq 93 idle
        // stop_reason=end_turn, seq 95 idle stop_reason=None).
        // Scope: only synchronous calls of this thread's current turn that
        // never got a result. Anything that already returned (including a
        // future async/background handle) is untouched; OpenMA has no async
        // tool handles today, and their lifecycle is deliberately not tied to
        // interrupt (separate design).
        // Close every still-open tool_use / custom_tool_use / confirmation
        // BEFORE the idle so the turn never ends in requires_action and a
        // late answer cannot resume it (findings.md §3/§4).
        const closedCount = this.closeToolUsesAfterInterrupt(history, undefined, targetThread);
        // Decide idle from durable history, not only the in-memory controller.
        // After DO eviction / wrangler HMR / a concurrent interrupt that already
        // deleted the controller, hadActiveTurn can be false while the last
        // status is still running — skipping idle leaves the session stuck
        // (race NOT_SETTLED, interrupt-v2 double_interrupt). Official CMA:
        // interrupt ends the turn with status_idle end_turn.
        // True no-op: already idle end_turn and nothing was closed/cancelled.
        let lastStatusType: string | undefined;
        let lastStop: string | undefined;
        for (const e of history.getEvents()) {
          if (((e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary") !== targetThread) continue;
          if (e.type === "session.status_running" || e.type === "session.status_idle") {
            lastStatusType = e.type;
            lastStop = e.type === "session.status_idle"
              ? ((e as { stop_reason?: { type?: string } }).stop_reason?.type ?? "")
              : undefined;
          }
        }
        const lastIsRunning = lastStatusType === "session.status_running";
        // Official CMA: interrupt against an already-idle session is normally
        // a no-op (handled above). This emitIdle path is for an active or
        // still-running turn only.
        const emitIdle =
          closedCount > 0 ||
          settledRequests.length > 0 ||
          cancelledCount > 0 ||
          hadActiveTurn ||
          lastIsRunning;
        if (emitIdle) {
          // If a zombie turn's finally still runs, suppress its catch-all idle.
          if (lastIsRunning || hadActiveTurn) this._interruptIdleOwned.add(targetThread);
          // stop_reason is required on session.status_idle per Anthropic
          // spec — pydantic v2 in @anthropic-ai/sdk-python rejects events
          // without it. Anthropic's StopReason union has no `interrupted`
          // variant, so use `end_turn` (the closest semantic — agent
          // stopped, user can send the next message). The accompanying
          // user.interrupt event in the log carries the actual cause.
          const idleEvent: SessionEvent = {
            type: "session.status_idle",
            stop_reason: interruptedTurnStopReason(),
            ...(targetThread !== "sthr_primary" ? { session_thread_id: targetThread } : {}),
          };
          history.append(idleEvent);
          // Interrupt ends the turn's execution fence; broadcastEvent would
          // drop this as stale and never project to D1 (GET /events reads D1).
          // Force-publish lifecycle idle without a fence.
          this.broadcastEventIgnoringExecutionFence(idleEvent);
        }
        return new Response(null, { status: 202 });
      }

      if (body.type === ("session.updated" as SessionEvent["type"])) {
        // Budget update that lifted a budget_reached pause. The canonical
        // event and its continuation execution are already in D1 (store
        // append + outbox); just wake the primary lane to claim it.
        if ((body as unknown as { resume?: boolean }).resume === true) {
          this.drainEventQueue("sthr_primary");
        }
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.tool_confirmation") {
        const tc = body as UserToolConfirmationEvent;
        const tcThread =
          (tc as unknown as { session_thread_id?: string }).session_thread_id ??
          "sthr_primary";
        if (this.toolUseAlreadyAnswered(tc.tool_use_id, history)) {
          return this.acceptNoEffectAnswer(tc, history);
        }
        this._stampEventForPending(tc);
        const enqueued = this.enqueueQueueInputIfNew(tc);
        if (enqueued) this._broadcastPendingFrame(tc, tcThread);
        if (enqueued) {
          try {
            await this.schedule(5, "recoverEventQueue");
          } catch {}
        }
        console.log("[post /event] tool_confirmation enqueued, firing drainEventQueue (no await)");
        if (enqueued) this.drainEventQueue(tcThread);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.custom_tool_result") {
        const customResult = body as UserCustomToolResultEvent;
        const ctrThread =
          (customResult as unknown as { session_thread_id?: string })
            .session_thread_id ?? "sthr_primary";
        if (this.toolUseAlreadyAnswered(customResult.custom_tool_use_id, history)) {
          return this.acceptNoEffectAnswer(customResult, history);
        }
        if (!this.toolUseExists(customResult.custom_tool_use_id, history)) {
          return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
            message: `custom_tool_use_id ${customResult.custom_tool_use_id} does not match any tool use in this session` } }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        // Official CMA: custom_tool_result (like tool_result) is processed on
        // receipt — stamp processed_at before enqueue/echo, do not clear it.
        const stamped = customResult as UserCustomToolResultEvent & { id?: string; processed_at?: string };
        if (!stamped.id) stamped.id = `sevt_${generateEventId()}`;
        stamped.processed_at = this.processedClock.nowIso();
        this.markAcceptedEventsProcessed([stamped.id], stamped.processed_at);
        const enqueued = this.enqueueQueueInputIfNew(customResult);
        if (enqueued) this._broadcastPendingFrame(customResult, ctrThread);
        if (enqueued) {
          try {
            await this.schedule(5, "recoverEventQueue");
          } catch {}
        }
        console.log("[post /event] custom_tool_result enqueued, firing drainEventQueue (no await)");
        if (enqueued) this.drainEventQueue(ctrThread);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.define_outcome") {
        const raw = body as UserDefineOutcomeEvent & {
          outcome?: {
            description?: string;
            criteria?: string[];
            rubric?: UserDefineOutcomeEvent["rubric"];
            verifier?: UserDefineOutcomeEvent["verifier"];
            max_iterations?: number;
          };
        };
        const legacyCriteria = raw.outcome?.criteria;
        const e: UserDefineOutcomeEvent = {
          ...raw,
          description: raw.description ?? raw.outcome?.description ?? "",
          rubric:
            raw.rubric ??
            raw.outcome?.rubric ??
            (Array.isArray(legacyCriteria) && legacyCriteria.length > 0
              ? legacyCriteria.join("\n")
              : undefined),
          verifier: raw.verifier ?? raw.outcome?.verifier,
          max_iterations: raw.max_iterations ?? raw.outcome?.max_iterations,
        };
        const legacyOutcome =
          raw.outcome ??
          {
            description: e.description,
            ...(Array.isArray(legacyCriteria) ? { criteria: legacyCriteria } : {}),
          };
        // AMA-spec: validate at-least-one-of(rubric|verifier). Reject the
        // event before persisting so callers get a clean 400 instead of a
        // silently degraded supervisor loop.
        const hasRubric =
          typeof e.rubric === "string"
            ? e.rubric.trim().length > 0
            : !!e.rubric && (
                (e.rubric.type === "text" && !!e.rubric.content) ||
                (e.rubric.type === "file" && !!e.rubric.file_id)
              );
        if (!e.description && !hasRubric && !e.verifier) {
          return new Response(
            JSON.stringify({ error: "user.define_outcome requires description, rubric, or verifier" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        // Mint outcome_id server-side (AMA-style `outc_…` prefix). Honour
        // a client-supplied id only when it's already prefixed (used by
        // tests / replays); otherwise mint fresh.
        const outcome_id =
          e.outcome_id && e.outcome_id.startsWith("outc_")
            ? e.outcome_id
            : generateOutcomeId();
        const echoed: UserDefineOutcomeEvent = {
          ...e,
          outcome_id,
          outcome: legacyOutcome,
        } as UserDefineOutcomeEvent;
        // Sequential outcomes: any prior `state.outcome` is dropped (it
        // either already terminated and was nulled by the supervisor, or
        // we're explicitly replacing it). Existing `outcome_evaluations`
        // history stays intact.
        this.setState({
          ...this.state,
          outcome: {
            outcome_id,
            description: echoed.description,
            rubric: echoed.rubric,
            verifier: echoed.verifier,
            max_iterations: echoed.max_iterations,
          },
          outcome_iteration: 0,
        });
        history.append(echoed);
        this.broadcastEvent(echoed);
        return new Response(null, { status: 202 });
      }

      return new Response("Unknown event type", { status: 400 });
    }

    // POST /__debug_recovery__ — gated test endpoint that lets ops verify
    // recoverInterruptedState fires correctly against a real production
    // SessionDO. Body lists orphan rows to inject (streaming row with
    // chunks, builtin/mcp/custom tool_use), then the recovery scan runs
    // synchronously and the report is returned in the response. The next
    // GET /events shows the resulting reconciliation events.
    //
    // Auth: requires the X-Debug-Token header to match env.DEBUG_TOKEN
    // (set as a wrangler secret in environments where this should work).
    // 401s if either side is unset, so prod-without-secret is safe.
    if (request.method === "POST" && url.pathname === "/__debug_recovery__") {
      const expected = (this.env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN;
      const provided = request.headers.get("x-debug-token");
      if (!expected || !provided || expected !== provided) {
        return new Response("Forbidden", { status: 403 });
      }
      this.ensureSchema();
      if (!this.streams) {
        return new Response("streams unavailable", { status: 500 });
      }
      type Seed =
        | { kind: "stream"; message_id: string; chunks?: string[] }
        | { kind: "tool_use"; id: string; name?: string; tool_kind?: "builtin" | "mcp" | "custom" };
      const body = (await request.json().catch(() => ({}))) as { seed?: Seed[] };
      const seeds = body.seed ?? [];
      const history = this.openHistory();
      for (const s of seeds) {
        if (s.kind === "stream") {
          await this.streams.start(s.message_id, Date.now());
          for (const ch of s.chunks ?? []) await this.streams.appendChunk(s.message_id, ch);
        } else {
          const k = s.tool_kind ?? "builtin";
          const evType =
            k === "mcp" ? "agent.mcp_tool_use" :
            k === "custom" ? "agent.custom_tool_use" :
            "agent.tool_use";
          history.append({ type: evType, id: s.id, name: s.name ?? "test_tool" } as SessionEvent);
        }
      }
      const report = await runRecovery(this.streams, history);
      // Broadcast warnings same as the cold-start path.
      for (const w of report.warnings) {
        this.broadcastEvent({
          type: "session.warning",
          source: w.source,
          message: w.message,
          details: w.details,
        } as SessionEvent);
      }
      return Response.json({ seeded: seeds.length, ...report });
    }

    // GET /ws — WebSocket upgrade
    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();

      // Wire-protocol opt-ins forwarded by cf-session-router.ts. Defaults
      // (no headers) = Anthropic-spec behavior: no replay, only spec event
      // types broadcast. `Last-Event-ID` is SSE-native resume — its
      // presence implies replay-from-seq regardless of x-oma-replay.
      const includes = (request.headers.get("x-oma-include") ?? "")
        .split(",")
        .map((s) => s.trim());
      const includeChunks = includes.includes("chunks");
      // Managed stream adapter opts into the OMA queue-lifecycle extension
      // (system.user_message_cancelled / _steered) without the chunk firehose.
      const includeQueue = includes.includes("queue_lifecycle");
      const replayHeader = request.headers.get("x-oma-replay") === "1";
      const lastEventIdRaw = request.headers.get("Last-Event-ID");
      const lastEventId = lastEventIdRaw !== null
        ? Number.parseInt(lastEventIdRaw, 10)
        : NaN;
      const wantsReplay = replayHeader || Number.isFinite(lastEventId);

      // Tag the socket so broadcastEvent (line ~3120) can filter per-ws.
      // Chunks-opted sockets get the "chunks" tag → broadcastEvent routes
      // OMA extension events only to them; spec events go to all sockets.
      // Pass undefined (not []) when no tags so the runtime skips the
      // tag-array path entirely — empty-tags semantics differ across CF
      // runtime versions and the cleanest contract is "no tags arg".
      if (includeChunks || includeQueue) {
        this.ctx.acceptWebSocket(pair[1], [
          ...(includeChunks ? ["chunks"] : []),
          ...(includeQueue ? ["queue_lifecycle"] : []),
        ]);
      } else {
        this.ctx.acceptWebSocket(pair[1]);
      }

      // Conditional history replay. Skip entirely when neither flag set —
      // this is the spec-default ("only events after open"). When set,
      // filter by seq > lastEventId for clean SSE resume semantics.
      if (wantsReplay) {
        const history = this.openHistory();
        // Use the repo-level afterSeq filter — the SQL layer drops rows
        // server-side, which is the only place that can see `seq` (the
        // returned SessionEvent objects are bare wire payloads with no
        // `seq` field stitched on).
        const events = history.getEvents(
          Number.isFinite(lastEventId) ? lastEventId : undefined,
        );
        for (const event of events) {
          // Same spec-vs-extension filter applied to the live broadcast
          // path (broadcastEvent below); replayed history must respect the
          // same wire contract or a spec-only client would silently get
          // OMA extension events on reconnect.
          if (!includeChunks && !isSpecEvent(event.type)) continue;
          pair[1].send(JSON.stringify(event));
        }
      }

      // Queued-input replay — emit a system.user_message_pending frame for
      // every active queue row across every thread (same event id the list
      // API returns), so a fresh client sees the outbox without an extra
      // GET /pending (that endpoint is gone). `system.*` is an OMA
      // extension type, so this is gated by the chunks opt-in.
      if (includeChunks) {
        try {
          for (const threadId of this.queue.threadsWithQueueInputs()) {
            for (const row of this.queue.listQueue(threadId)) {
              let parsed: SessionEvent;
              try {
                parsed = JSON.parse(row.data) as SessionEvent;
              } catch {
                continue;
              }
              const pendingFrame: SystemUserMessagePendingEvent = {
                type: "system.user_message_pending",
                event_id: row.event_id,
                pending_seq: row.seq,
                enqueued_at: row.enqueued_at,
                session_thread_id: row.session_thread_id,
                event: parsed,
              };
              pair[1].send(JSON.stringify(pendingFrame));
            }
          }
        } catch (err) {
          console.warn(
            `[ws-replay] pending queue replay failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (request.method === "POST" && url.pathname === "/wakeups/cancel") {
      const cancelled = await this.cancelAllWakeups();
      return Response.json(cancelled);
    }

    // GET /status
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: this.deriveStatus(),
        agent_id: this.state.agent_id,
        environment_id: this.state.environment_id,
        usage: {
          input_tokens: this.state.input_tokens,
          output_tokens: this.state.output_tokens,
        },
      });
    }

    // DELETE /pending/:event_id — queue cancel shim (AMA/OMA extension).
    //
    // GET /pending is gone: queued inputs are ordinary events rows with
    // processed_at NULL and are listed through GET /events (wire seq null
    // until promoted). The DELETE path is kept for one release so older
    // Console/SDK clients can still remove a queued input by event id; it
    // cancels the same null-processed row (cancelled_at) rather than
    // deleting it, preserving the audit trail. GET has no equivalent here.
    if (request.method === "DELETE" && url.pathname.startsWith("/pending/")) {
      const eventId = decodeURIComponent(url.pathname.slice("/pending/".length));
      const cancelledAt = Date.now();
      const cancelledAtIso = new Date(cancelledAt).toISOString();
      // Compare-and-cancel: the D1 execution outbox is the queue authority.
      // Response body is the edit-race contract (openma-common documents it):
      //   { cancelled: true, id, cancelled_at }  — still queued, removed
      //   { cancelled: false, reason, id, processed_at? } — too late
      // On success we also broadcast system.user_message_cancelled so stream
      // observers stay in sync with the HTTP outcome.
      const store = await this.getExecutionStore();
      type NotQueuedReason = "already_processing" | "already_cancelled" | "already_completed" | "held_after_exhausted" | "not_found";
      let notQueued: { reason: NotQueuedReason; processedAt?: string } | null = null;
      let durableCancelled = store === null;
      if (store !== null) {
        const result = await store.cancelQueued({
          workspaceId: this.state.tenant_id!,
          sessionId: this.state.session_id!,
          executionId: eventId,
          cancelledAt: cancelledAtIso,
        });
        if (result.type === "cancelled") {
          durableCancelled = true;
        } else {
          durableCancelled = false;
          notQueued = {
            reason: result.reason,
            ...(result.execution?.attempt?.claimedAt
              ? { processedAt: result.execution.attempt.claimedAt }
              : result.execution?.settledAt
                ? { processedAt: result.execution.settledAt }
                : {}),
          };
        }
      }
      const localRow = durableCancelled
        ? this.queue.cancelQueueByEventId(eventId, cancelledAt)
        : null;
      if (store === null && localRow === null) {
        durableCancelled = false;
        notQueued = { reason: "not_found" };
      }
      if (!durableCancelled) {
        return new Response(JSON.stringify({
          cancelled: false,
          reason: notQueued?.reason ?? "already_processing",
          id: eventId,
          ...(notQueued?.processedAt ? { processed_at: notQueued.processedAt } : {}),
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      const row = localRow ?? {
        seq: 0,
        event_id: eventId,
        session_thread_id: "sthr_primary",
        enqueued_at: cancelledAt,
        type: "",
        data: "",
        cancelled_at: cancelledAt,
      };
      this.broadcastEvent({
        type: "system.user_message_cancelled",
        pending_seq: row.seq,
        event_id: row.event_id,
        session_thread_id: row.session_thread_id,
        cancelled_at: cancelledAt,
      } as SystemUserMessageCancelledEvent);
      return new Response(JSON.stringify({ cancelled: true, id: row.event_id, cancelled_at: cancelledAtIso }),
        { status: 200, headers: { "content-type": "application/json" } });
    }

    // GET /events — paginated event list
    if (request.method === "GET" && url.pathname === "/events") {
      const limitParam = url.searchParams.get("limit");
      let limit = limitParam ? parseInt(limitParam, 10) : 100;
      if (isNaN(limit) || limit < 1) limit = 100;
      if (limit > 1000) limit = 1000;

      const order = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";
      const afterSeqParam = url.searchParams.get("after_seq");
      const afterSeq = afterSeqParam ? parseInt(afterSeqParam, 10) : 0;

      // Fetch limit + 1 to determine has_more. Null-processed rows are
      // queued turn inputs: include them in the list (the frontend outbox
      // reads this list), but expose seq: null until promotion stamps the
      // same row/id — canonical seq only exists once processed_at is set.
      const query = `SELECT seq, type, data, ts, processed_at, cancelled_at FROM events WHERE seq > ? ORDER BY seq ${order} LIMIT ?`;
      // Retry the SQL exec on transient "Durable Object storage operation
      // exceeded timeout" errors only — these surface during write-contention
      // storms (e.g. 49+ concurrent model_request_start events), and a
      // 100-ms-backoff retry window is enough to clear them. All other
      // errors (parse, schema, NULL row) propagate untouched to the
      // top-level 500 handler so real bugs aren't swallowed.
      let rows: ReturnType<ReturnType<typeof this.ctx.storage.sql.exec>["toArray"]>;
      {
        let lastErr: unknown;
        let attempt = 0;
        const maxAttempts = 3;
        for (;;) {
          try {
            rows = this.ctx.storage.sql.exec(query, afterSeq, limit + 1).toArray();
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const transient = /storage operation exceeded timeout|object to be reset/i.test(msg);
            attempt++;
            if (!transient || attempt >= maxAttempts) {
              lastErr = err;
              break;
            }
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
        if (!rows!) throw lastErr;
      }

      const hasMore = rows.length > limit;
      const resultRows = hasMore ? rows.slice(0, limit) : rows;

      const events = resultRows.map((row) => {
        let data: unknown;
        try {
          data = JSON.parse(row.data as string);
        } catch (err) {
          // One bad row used to throw and 500 the whole endpoint, hiding all
          // valid events for the session. Surface the parse failure in-band
          // so callers can still iterate the rest of the trajectory.
          const msg = err instanceof Error ? err.message : String(err);
          data = { _parse_error: msg, _raw_preview: String(row.data ?? "").slice(0, 200) };
        }
        const queued = row.processed_at === null || row.processed_at === undefined;
        if (data !== null && typeof data === "object") {
          const record = data as Record<string, unknown>;
          if (!queued) record.processed_at_ms = row.processed_at;
          if (row.cancelled_at !== null && row.cancelled_at !== undefined) {
            record.cancelled_at_ms = row.cancelled_at;
          }
        }
        return {
          // Queued input: internal seq exists but is not canonical yet.
          seq: queued ? null : row.seq,
          type: row.type,
          data,
          ts: row.ts,
        };
      });

      // Resolve any spilled events back from R2 so callers see full payloads.
      // Lazy + parallel — small events skip the R2 fetch entirely.
      if (this.env.FILES_BUCKET) {
        await Promise.all(
          events.map(async (e) => {
            const meta = (e.data as { _spilled?: { r2_key: string; original_bytes: number } } | null)?._spilled;
            if (!meta) return;
            try {
              const obj = await this.env.FILES_BUCKET!.get(meta.r2_key);
              if (!obj) {
                (e.data as Record<string, unknown>)._spill_lost = true;
                return;
              }
              const text = await obj.text();
              try {
                e.data = JSON.parse(text);
              } catch (parseErr) {
                (e.data as Record<string, unknown>)._spill_parse_error = (parseErr instanceof Error ? parseErr.message : String(parseErr)).slice(0, 200);
              }
            } catch (err) {
              (e.data as Record<string, unknown>)._spill_get_error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
            }
          }),
        );
      }

      const lastSeq = resultRows.length > 0 ? resultRows[resultRows.length - 1].seq : null;
      return Response.json({
        data: events,
        has_more: hasMore,
        next_page: hasMore && lastSeq !== null ? `seq_${lastSeq}` : null,
      });
    }

    // POST /usage — increment token usage counters. Now thread-aware:
    // body may carry session_thread_id (defaults to sthr_primary) and
    // optional cache_creation_input_tokens / cache_read_input_tokens for
    // the per-thread breakdown that GET /threads/:id surfaces. The
    // session-wide echo (input_tokens / output_tokens) stays unchanged
    // for back-compat with existing /full-status consumers.
    if (request.method === "POST" && url.pathname === "/usage") {
      const body = (await request.json()) as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        session_thread_id?: string;
      };
      const threadId = body.session_thread_id ?? "sthr_primary";
      this.usageMeter.credit(threadId, {
        input_tokens: body.input_tokens ?? 0,
        output_tokens: body.output_tokens ?? 0,
        cache_creation_input_tokens: body.cache_creation_input_tokens,
        cache_read_input_tokens: body.cache_read_input_tokens,
      });
      return Response.json({
        input_tokens: this.state.input_tokens,
        output_tokens: this.state.output_tokens,
      });
    }

    // POST /exec — run a raw shell command in this session's sandbox
    // WITHOUT going through the agent. Designed for eval / verifier
    // workflows where the harness needs to run pytest (or similar) on
    // post-agent state without trusting the agent to invoke a tool.
    // Returns { exit_code, output } where output is the combined
    // stdout+stderr text. Body:
    //   { command: string, timeout_ms?: number (default 60000) }
    if (request.method === "POST" && url.pathname === "/exec") {
      const body = (await request.json()) as { command?: string; timeout_ms?: number };
      const command = body.command;
      const timeoutMs = body.timeout_ms ?? 60_000;
      if (!command || typeof command !== "string") {
        return new Response(JSON.stringify({ error: "command (string) required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const sandbox = await this.getOrCreateSandbox();
        // Wrap multi-line / set-e style scripts in a subshell `( ... )` so
        // they run in a child process. Otherwise commands like `set -e`
        // followed by a failing step (e.g. pytest exit 1) terminate the
        // underlying persistent shell session — every subsequent exec
        // fails with SessionTerminatedError. Subshell parens preserve
        // newlines verbatim (unlike `bash -c "<json-stringified>"` which
        // would escape \n as a literal backslash-n).
        const needsSubshell = command.includes("\n") || /\bset\s+-[a-z]*e[a-z]*\b/.test(command);
        const wrapped = needsSubshell ? `( ${command}\n)` : command;
        const raw = await sandbox.exec(wrapped, timeoutMs);
        // sandbox.exec returns "exit=N\n<merged-output>"
        const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
        const exit_code = m ? parseInt(m[1], 10) : -1;
        const output = m ? m[2] : raw;
        return Response.json({
          exit_code,
          output: output.length > 100_000 ? output.slice(0, 100_000) + "\n...(truncated)" : output,
          truncated: output.length > 100_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json(
          { exit_code: -1, output: `sandbox exec error: ${msg}`, error: true },
          { status: 500 },
        );
      }
    }

    // GET /threads — list session threads (AMA shape).
    //
    // Reads from the `threads` SQL table (DO storage), not the in-memory
    // Map — that one only holds sub-agent threads spawned in the current
    // isolate; the SQL table survives DO eviction and includes the
    // primary thread (seeded on /init).
    //
    // Query params:
    //   ?include_archived=true  → include archived rows (default off)
    //
    // Response shape mirrors BetaManagedAgentsSessionThread minimally:
    // id / agent_id / agent_name / parent_thread_id / created_at /
    // archived_at / status / stats. usage stays null until per-thread
    // token accounting lands (today tokens are session-wide on
    // state.input_tokens / state.output_tokens — no thread breakdown).
    if (request.method === "GET" && url.pathname === "/threads") {
      const includeArchived = url.searchParams.get("include_archived") === "true";
      const cursor = includeArchived
        ? this.ctx.storage.sql.exec(
            `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
               FROM threads ORDER BY created_at`,
          )
        : this.ctx.storage.sql.exec(
            `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
               FROM threads WHERE archived_at IS NULL ORDER BY created_at`,
          );
      const data = [] as Array<Record<string, unknown>>;
      for (const row of cursor) {
        data.push(this._serializeThreadRow(row));
      }
      return Response.json({ data });
    }

    // GET /threads/:thread_id — single thread metadata.
    const threadGetMatch = url.pathname.match(/^\/threads\/([^/]+)$/);
    if (request.method === "GET" && threadGetMatch) {
      const threadId = threadGetMatch[1];
      let row: Record<string, unknown> | undefined;
      for (const r of this.ctx.storage.sql.exec(
        `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
           FROM threads WHERE id = ? LIMIT 1`,
        threadId,
      )) {
        row = r;
      }
      if (!row) {
        return Response.json(
          { error: { type: "not_found", message: `thread ${threadId} not found` } },
          { status: 404 },
        );
      }
      return Response.json(this._serializeThreadRow(row));
    }

    // POST /threads/:thread_id/archive — soft-delete (status flips to
    // archived; subsequent POST /event for this thread should 409).
    // Idempotent — re-archive returns the existing archived_at.
    const threadArchiveMatch = url.pathname.match(/^\/threads\/([^/]+)\/archive$/);
    if (request.method === "POST" && threadArchiveMatch) {
      const threadId = threadArchiveMatch[1];
      // Refuse archiving the primary thread — the session itself is the
      // primary thread's lifecycle, not the thread row's.
      if (threadId === "sthr_primary") {
        return Response.json(
          { error: { type: "invalid_request", message: "cannot archive the primary thread" } },
          { status: 400 },
        );
      }
      let exists = false;
      for (const _ of this.ctx.storage.sql.exec(
        `SELECT 1 FROM threads WHERE id = ? LIMIT 1`,
        threadId,
      )) {
        exists = true;
      }
      if (!exists) {
        return Response.json(
          { error: { type: "not_found", message: `thread ${threadId} not found` } },
          { status: 404 },
        );
      }
      // Set archived_at only if not already set — preserves the original
      // archive timestamp on idempotent re-archive.
      this.ctx.storage.sql.exec(
        `UPDATE threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL`,
        Date.now(), threadId,
      );
      // Drop the in-memory config map entry — future agent calls referencing
      // this thread should fail loudly rather than silently spawn against an
      // archived row.
      this.threads.delete(threadId);
      // Echo the (now archived) thread back so the caller can read the
      // archived_at timestamp without an extra GET.
      let row: Record<string, unknown> | undefined;
      for (const r of this.ctx.storage.sql.exec(
        `SELECT id, agent_id, agent_name, parent_thread_id, created_at, archived_at
           FROM threads WHERE id = ? LIMIT 1`,
        threadId,
      )) {
        row = r;
      }
      return Response.json(this._serializeThreadRow(row!));
    }

    // GET /threads/:thread_id/events — paginated event list scoped to
    // one thread. Filter happens at the SQL level via the
    // session_thread_id column populated by CfDoEventLog.append.
    const threadEventsMatch = url.pathname.match(/^\/threads\/([^/]+)\/events$/);
    if (request.method === "GET" && threadEventsMatch) {
      const threadId = threadEventsMatch[1];
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "200", 10) || 200,
        1000,
      );
      const afterSeq = parseInt(url.searchParams.get("after_seq") ?? "0", 10) || 0;
      const order = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";
      const cursor = this.ctx.storage.sql.exec(
        `SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id
           FROM events
           WHERE session_thread_id = ? AND seq > ?
           ORDER BY seq ${order} LIMIT ?`,
        threadId, afterSeq, limit,
      );
      const data = [] as Array<Record<string, unknown>>;
      for (const row of cursor) {
        const ev = JSON.parse(row.data as string);
        const queued = row.processed_at == null;
        if (!queued) ev.processed_at_ms = row.processed_at;
        if (row.cancelled_at != null) ev.cancelled_at_ms = row.cancelled_at;
        if (row.session_thread_id != null) ev.session_thread_id = row.session_thread_id;
        data.push({
          // Same contract as GET /events: queued inputs are listed with a
          // null canonical seq until promoted in place.
          seq: queued ? null : row.seq,
          type: row.type,
          ts: row.ts,
          data: ev,
        });
      }
      return Response.json({ data });
    }

    // GET /full-status — session status with usage and outcome evaluations.
    //
    // Phase 4 / AMA alignment: outcome_evaluations is now sourced from
    // `state.outcome_evaluations` (written by the supervisor loop on every
    // terminal `span.outcome_evaluation_end`). Falls back to scanning the
    // event log for legacy spellings (`session.outcome_evaluated`,
    // `outcome.evaluation_end`, `span.outcome_evaluation_end`) so sessions
    // written before this change still surface their verdicts.
    if (request.method === "GET" && url.pathname === "/full-status") {
      const history = this.openHistory();

      const stateEvaluations = this.state.outcome_evaluations ?? [];
      let outcomeEvaluations: PersistedOutcomeEvaluation[] = stateEvaluations;
      if (outcomeEvaluations.length === 0) {
        // Back-compat scan. Only runs for sessions whose supervisor never
        // wrote into state.outcome_evaluations[] (pre-Phase-4 emit
        // sites). Cheap because the event scan is local to this DO.
        const allEvents = history.getEvents();
        outcomeEvaluations = allEvents
          .filter(
            (e) =>
              e.type === "session.outcome_evaluated" ||
              e.type === "outcome.evaluation_end" ||
              e.type === "span.outcome_evaluation_end",
          )
          .map((e: SessionEvent) => {
            const ev = e as Partial<PersistedOutcomeEvaluation> & {
              feedback?: string;
            };
            return {
              outcome_id: ev.outcome_id ?? "",
              result: (ev.result ?? "needs_revision") as PersistedOutcomeEvaluation["result"],
              iteration: typeof ev.iteration === "number" ? ev.iteration : 0,
              explanation: ev.explanation ?? ev.feedback,
              feedback: ev.feedback ?? ev.explanation,
              usage: ev.usage,
              processed_at: (e as { processed_at?: string }).processed_at,
            };
          });
      }

      return Response.json({
        status: this.deriveStatus(),
        usage: {
          input_tokens: this.state.input_tokens,
          output_tokens: this.state.output_tokens,
        },
        outcome_evaluations: outcomeEvaluations,
      });
    }

    // POST /model-egress — HTTP adapter for the application egress protocol
    // (parse/applyModelEgressRequest over the domain meter). Main's
    // inference-proxy hits this so OpenSandbox shares the ONE meter.
    if (request.method === "POST" && url.pathname === "/model-egress") {
      const egress = parseModelEgressRequest(await request.json().catch(() => null));
      if (egress === null) {
        return Response.json({ error: MODEL_EGRESS_ACTION_REQUIRED }, { status: 400 });
      }
      let gate = this.activeBudgetGate;
      if (!gate) {
        const handle = this.agentModelHandle(
          (this.state.agent_snapshot ?? { model: this.env.ANTHROPIC_MODEL }) as AgentConfig,
        );
        gate = await this.resolveBudgetGate(handle);
      }
      return Response.json(applyModelEgressRequest(gate, egress));
    }

    // GET /file?path=... — read a file from the sandbox FS as raw bytes.
    // Used by main worker's POST /v1/sessions/:id/files (container_upload):
    // promotes an agent-emitted artefact to a first-class file_id.
    if (request.method === "GET" && url.pathname === "/file") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("path query param required", { status: 400 });
      try {
        const sandbox = await this.getOrCreateSandbox();
        let bytes: Uint8Array;
        try {
          bytes = await readSandboxFileBytes(sandbox, path, 15000);
        } catch (err) {
          return new Response(`read failed: ${(err as Error).message.slice(0, 300)}`, { status: 404 });
        }
        return new Response(bytes, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`read error: ${msg}`, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  // WebSocket Hibernation API handlers
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // Client-to-DO messages not used in Phase 1
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    ws.close();
  }

  /**
   * Get or create the session's sandbox. Singleton per session — reused
   * across turns so files persist within the session lifetime.
   */
  private sessionSandboxRuntime(): SessionSandboxRuntime {
    return this.sandboxRuntime ??= new SessionSandboxRuntime({
      mode: async () => {
        const source = await this.env.MAIN_MCP?.resolveManagedSessionInputs({
          tenantId: this.state.tenant_id, sessionId: this.state.session_id,
        });
        return source?.type === "found" ? source.session.sandboxMode ?? "sandbox" : "sandbox";
      },
      create: () => {
        this.ensureSandboxCreated();
        return this.wrappedSandbox!;
      },
      prepare: () => this.doWarmUpSandbox(),
    });
  }

  private async getOrCreateSandbox(): Promise<SandboxExecutor> {
    const sandbox = await this.sessionSandboxRuntime().acquire();
    this.sandbox ??= sandbox;
    return sandbox;
  }

  /**
   * Bind provider/container calls to the currently claimed execution.
   *
   * SessionDO owns the durable lease, while the sandbox package enforces the
   * local call boundary. The map is refreshed by SessionExecutionHost on each
   * renewal, so an idle-but-still-running turn sees the extended expiry. A
   * child harness shares its parent's lane and therefore passes the same
   * fence through this helper instead of acquiring a second authority.
   */
  private bindSandboxToExecution(
    sandbox: SandboxExecutor,
    signal: AbortSignal | undefined,
    fence: SessionExecutionFence | undefined,
    laneId: string,
  ): SandboxExecutor {
    if (signal === undefined && fence === undefined) return sandbox;
    const executionId = fence?.executionId;
    const attemptId = fence?.attemptId;
    return withSandboxExecutionGuard(sandbox, {
      signal,
      isValid: fence
        ? () => {
            const current = this._executionFences.get(laneId);
            if (current === undefined) return false;
            if (
              current.executionId !== executionId ||
              current.attemptId !== attemptId
            ) {
              return false;
            }
            return Date.parse(current.expiresAt) > Date.now();
          }
        : undefined,
    });
  }

  private isExecutionFenceCurrent(fence: SessionExecutionFence): boolean {
    for (const current of this._executionFences.values()) {
      if (
        current.executionId === fence.executionId &&
        current.attemptId === fence.attemptId &&
        current.generation === fence.generation
      ) {
        return Date.parse(current.expiresAt) > Date.now();
      }
    }
    return false;
  }

  /**
   * Make the DO-local event log obey the same fence as the managed projection.
   * The durable execution row remains the authority, but a stale incarnation
   * must not append a local canonical event before its fenced projection is
   * rejected. Legacy callers without a fence retain the old history object.
   */
  private guardHistoryForExecution(
    history: HistoryStore,
    fence: SessionExecutionFence | undefined,
  ): HistoryStore {
    if (fence === undefined) return history;
    return {
      getMessages: () => history.getMessages(),
      getEvents: (afterSeq?: number) => history.getEvents(afterSeq),
      append: (event: SessionEvent) => {
        if (!this.isExecutionFenceCurrent(fence)) {
          const error = new Error("session execution fence is no longer valid");
          error.name = "ExecutionFenceLostError";
          throw error;
        }
        // Stale worker result: the interrupt already closed this call with a
        // synthetic interrupted result. Drop it so the model history
        // never gets two results for one tool_use (Codex/Claude SDK: output
        // of an aborted tool is discarded).
        if (event.type === "agent.tool_result") {
          const id = (event as unknown as { tool_use_id?: string }).tool_use_id;
          if (id && this.toolUseAlreadyAnswered(id, history)) return;
        }
        history.append(event);
      },
    };
  }

  /** Used inside warmup itself to avoid the wrap → warmup → wrap recursion. */
  private getRawSandbox(): SandboxExecutor {
    this.ensureSandboxCreated();
    return this.sandbox!;
  }

  private ensureSandboxCreated() {
    if (!this.sandbox) {
      this.portsSandbox = createSessionSandbox(this.env.SANDBOX_ADAPTER, {
        env: this.env,
        storage: this.ctx.storage,
        // Sandbox ID must be 1-63 chars; DO hex ID is 64 chars — truncate to fit
        sandboxId: this.ctx.id.toString().slice(0, 63),
        // Operator catalog image (#545 / ADR 0016) for the Cloudflare adapter.
        sandboxImage: this.state.sandbox_image ?? null,
        session: () => ({
          tenantId: this.state.tenant_id,
          environmentId: this.state.environment_id,
          sessionId: this.state.session_id,
          agentId: this.state.agent_id || null,
        }),
        networking: async () => {
          const envId = this.state.environment_id;
          const config = envId ? await this.getEnvConfig(envId) : null;
          return (config?.config as { networking?: { type?: string; allowed_hosts?: string[]; allow_package_managers?: boolean } } | undefined)?.networking;
        },
        // Sandbox egress follows a current execution attempt of this
        // Session; none between turns (design §0.0 rule 10).
        fence: () => this._executionFences.values().next().value,
        warn: (message) => {
          try {
            this.persistAndBroadcastEvent({ type: "session.warning", message } as unknown as SessionEvent);
          } catch {}
        },
      });
      this.sandbox = this.portsSandbox;
      this.wrappedSandbox = this.wrapSandboxWithLazyWarmup(this.sandbox);
    }
  }

  /**
   * Returns a Proxy of the sandbox where any "real-work" method (exec,
   * readFile, etc.) awaits sandboxWarmupPromise before delegating. The main
   * turn also awaits warmup before tool/harness construction; this proxy is
   * the second safety barrier for confirmation callbacks, background work,
   * and container recycle between calls.
   *
   * Container-recycle detection: CF Sandbox container has its own idle
   * lifecycle independent of SessionDO. If it dies (sleepAfter, OOM, host
   * migration), our cached sandboxWarmupPromise still resolves but the
   * underlying /workspace is empty. We probe a per-warmup marker file
   * (/tmp/.oma-warm) — if missing or value-mismatched, invalidate cache
   * and re-warmup so restoreWorkspaceBackup runs again. Probe is one
   * `cat`, throttled to once per 30s to bound steady-state cost.
   *
   * The non-method properties and helpers like setEnvVars are passed
   * through synchronously — they don't talk to the container itself.
   */
  private wrapSandboxWithLazyWarmup(raw: SandboxExecutor): SandboxExecutor {
    const needsWarm = new Set<string>([
      "exec",
      "startProcess",
      "readFile",
      "writeFile",
      "writeFileBytes",
      "readFileBytes",
      "mountWorkspace",
      "gitCheckout",
    ]);
    // Methods we additionally want to run through classifyExternalError on
    // throw — covers the workspace-backup R2 path (createWorkspaceBackup /
    // restoreWorkspaceBackup) that doesn't go through warmup but still
    // raises CF-shaped errors ("version rollout", "Sandbox error", 503).
    // exec / startProcess / readFile / writeFile already classify via the
    // needsWarm wrapper below; everything in this set additionally
    // classifies even though it doesn't need warmup.
    const classifyOnly = new Set<string>([
      "createWorkspaceBackup",
      "restoreWorkspaceBackup",
      "snapshotWorkspaceNow",
      "mountSessionOutputs",
    ]);
    const ensureWarm = async (): Promise<void> => {
      // Cold path — warmup never ran or was reset by a recycle below.
      if (!this.sessionSandboxRuntime().preparing) {
        await this.warmUpSandbox();
        return;
      }
      // Warm path — wait for the cached promise (handles concurrent calls).
      await this.sessionSandboxRuntime().preparing;
      // Probe marker every call. Container can recycle (OOM, sleepAfter,
      // host migration) between any two calls; throttling the probe
      // misses fast-cluster-then-die patterns. ~5ms cost per tool call.
      let probed: string | null = null;
      try {
        const raw_out = await raw.exec("cat /tmp/.oma-warm 2>/dev/null");
        const m = /^exit=(-?\d+)\n([\s\S]*)$/.exec(raw_out);
        probed = (m && m[1] === "0") ? m[2].trim() : "";
      } catch { probed = null; }
      if (probed === this.currentWarmupGen) return; // alive, marker matches
      // Container recycled — reset cache and re-warm now (which includes
      // restoreWorkspaceBackup) so the upcoming user call sees /workspace
      // restored, not an empty fresh container.
      logWarn(
        { op: "session_do.warmup.recycle_detected", session_id: this.state.session_id, expected: this.currentWarmupGen, got: probed },
        "container marker mismatch — re-warming",
      );
      this.sessionSandboxRuntime().invalidatePreparation();
      this.currentWarmupGen = null;
      this.hasWritableManagedMemoryMount = false;
      await this.warmUpSandbox();
    };
    return new Proxy(raw, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const name = prop as string;
        const wantsWarm = needsWarm.has(name);
        const wantsClassify = wantsWarm || classifyOnly.has(name);
        if (!wantsWarm && !wantsClassify) return value.bind(target);
        return async (...args: unknown[]) => {
          if (wantsWarm) await ensureWarm();
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (err) {
            // Boundary: turn raw CF Containers / SDK errors into typed
            // OmaErrors (TransientInfraError for "version rollout",
            // RateLimitedError for 429, etc.) so processUserMessage's
            // retry switch can dispatch via instanceof. Falls back to
            // re-throwing the original error if no pattern matches.
            // TODO: extend wrapper coverage to other boundaries as new
            // failure modes surface (D1 client, KV ops, MCP transport).
            throw classifyExternalError(err);
          }
        };
      },
    }) as SandboxExecutor;
  }

  /**
   * Lazy-build a per-DO BrowserHarness. Wraps the package's
   * createCfBrowserHarness with caching so launch() always returns the
   * same BrowserSession across turns within the DO lifetime — preserving
   * the cross-turn cookie/state behaviour from before the package split.
   * Returns null if the BROWSER binding isn't configured.
   */
  private getBrowserHarness(): BrowserHarness | null {
    if (!this.env.BROWSER) return null;
    if (!this.browserHarness) {
      const tenantId = this.state.tenant_id;
      const sessionId = this.state.session_id;
      const agentId = this.state.agent_id || null;
      // Hybrid-billing hook: emit one browser_active_seconds row when the
      // BrowserSession closes (DELETE /destroy path or hibernation
      // teardown). Skipped when tenant/session aren't set yet (early-init
      // edge — no usage to attribute).
      const hook: BrowserBillingHook | null = tenantId && sessionId
        ? {
            tenantId,
            sessionId,
            agentId,
            onClose: async (elapsedSeconds: number) => {
              try {
                const { getCfServicesForTenant } = await import("@open-managed-agents/services");
                const services = await getCfServicesForTenant(this.env, tenantId);
                await services.usage.recordUsage({
                  tenantId,
                  sessionId,
                  agentId,
                  kind: "browser_active_seconds",
                  value: elapsedSeconds,
                });
                console.log(
                  `[session_do] usage emit browser_active_seconds=${elapsedSeconds} session=${sessionId.slice(0, 12)}`,
                );
              } catch (err) {
                console.error(
                  `[session_do] browser usage emit failed: ${(err as Error).message ?? err}`,
                );
              }
            },
          }
        : null;
      const inner = createCfBrowserHarness(
        this.env.BROWSER as unknown as { fetch: typeof fetch },
      );
      this.browserHarness = {
        launch: async () => {
          if (!this.browserSession) {
            this.browserSession = await inner.launch({ hook });
          }
          return this.browserSession;
        },
      };
    }
    return this.browserHarness;
  }

  /**
   * Pre-warm the sandbox: run a no-op command to trigger container startup,
   * then install environment packages if configured.
   * Returns a promise that resolves when warmup is complete.
   * Multiple callers share the same promise — warmup runs exactly once.
   */
  private warmUpSandbox(): Promise<void> {
    return this.sessionSandboxRuntime().prepare();
  }

  private async doWarmUpSandbox(): Promise<void> {

    try {
      // Raw sandbox — wrapped one would recurse back into warmUpSandbox here.
      const sandbox = this.getRawSandbox();
      const sessionId = this.state.session_id;

      // Sandbox SDK v2 Ports (session-sandbox.ts): attach the Session's
      // sandbox, else resume from its latest restore point, else acquire;
      // then egress.attach and storage.attach. A failed step rolls back and
      // throws. The generation is the /tmp/.oma-warm marker and the private
      // Memory runtime generation.
      this.currentWarmupGen = await this.portsSandbox!.prepare();

      // image_strategy fast path REMOVED. Was a base_snapshot lazy-prepare
      // path that ran a multi-minute install + tar + R2 upload via a single
      // sandbox.exec — the SDK wraps each exec in blockConcurrencyWhile,
      // which CF cancels at ~10-15s. Every retry restarted the install
      // from scratch, zombie SessionDOs alarmed in a loop, and the
      // container pool capped at max_instances starved real sessions.
      //
      // Until the platform exposes a primitive for "snapshot a container
      // filesystem outside the DO request loop," base_snapshot envs fall
      // through to the install-on-every-boot loop below — same path as
      // dockerfile/null. The base image already has python/uv/requests/
      // httpx/pandas/pytest/Go/Rust pre-baked, so envs without extra
      // packages skip install entirely.
      const envId = this.state.environment_id;
      const environmentConfig = envId ? await this.getEnvConfig(envId) : null;
      const imagePathHandled = false;

      // Install environment packages if configured. Replaces the old
      // "always re-install everything every cold start" loop with a
      // marker-aware 3-path flow (warm/restored/fresh) — see
      // packages/sandbox/src/environment-packages.ts for the full design.
      //
      // Lang packages (pip/npm/cargo/go) install to /workspace/.<lang>/
      // so they're captured by the workspace backup just restored above.
      // On the next cold restart the "restored" path skips them and only
      // re-runs apt (which can't be backed up via SDK whitelist).
      if (envId && !imagePathHandled) {
        const pkgs = environmentConfig?.config?.packages;
        if (pkgs) {
          const result = await ensureEnvironmentPackages(
            { exec: (cmd: string, timeout?: number) => sandbox.exec(cmd, timeout) },
            pkgs,
            (event) => {
              // Best-effort: emit a console line per step so it shows up
              // in CF tail. A future commit threads this into the session
              // event_log so the frontend can render the AMA-style ticker
              // inline in chat (see demo/env-prep README for the design).
              if (event.kind === "step") {
                console.log(`[setup-on-warmup] step=${event.step}${event.reason ? ` reason=${event.reason}` : ""}`);
              } else {
                console.log(`[setup-on-warmup] done path=${event.path} duration_ms=${event.durationMs}`);
              }
            },
          );
          if (result.error) {
            throw new Error(
              `Environment setup failed at ${result.path}: ${result.error}`,
            );
          }
        }
      }

      // Mount FILES_BUCKET at /mnt/session/outputs/ so any file the agent
      // writes there immediately appears via the caller-facing
      // GET /v1/sessions/:id/outputs endpoint. Mirrors AMA's `/mnt/session
      // /outputs/` magic dir contract — agent uses the standard `write` tool,
      // platform takes care of persistence + listing. When FILES_BUCKET is
      // configured this is required: a failed mount aborts warmup so the
      // session never falsely advertises durable, caller-visible outputs.
      if (this.state.session_id && this.state.tenant_id) {
        if (!supportsSessionOutputMount(sandbox)) {
          throw new Error(
            "Session outputs are enabled but the sandbox has no output mount capability",
          );
        }
        await sandbox.mountSessionOutputs({
          tenantId: this.state.tenant_id,
          sessionId: this.state.session_id,
        });
        if (sandbox.setEnvVars === undefined) {
          throw new Error(
            "Session outputs are mounted but the sandbox cannot publish their environment contract",
          );
        }
        await sandbox.setEnvVars({ OMA_OUTPUTS_DIR: "/mnt/session/outputs" });
      }

      // Materialize the current canonical Managed Session resources. The
      // main worker owns the Session/source Ports; this execution worker only
      // consumes a service-binding projection and performs provider I/O.
      // Resolve on every warmup so files added after Session creation are
      // visible before the first model request.
      if (sessionId) {
        const source = this.env.MAIN_MCP;
        if (source === undefined) {
          throw new Error(
            "Managed Session input source service binding is unavailable",
          );
        }
        const loaded = await loadManagedSessionResources(source, {
          tenantId: this.state.tenant_id,
          sessionId,
          runtimeGeneration: this.currentWarmupGen,
        });
        const resources = loaded.resources;
        this.hasWritableManagedMemoryMount = resources.some((resource) =>
          resource.type === "memory_store" && resource.access !== "read_only"
        );

        if (resources.length) {
          await mountResources(
            sandbox,
            resources,
            this.env.CONFIG_KV,
            new Map(),
            undefined,
            this.state.tenant_id,
            undefined,
            loaded.fileSource,
          );
        }
      }

      // CLI auth lives in main worker via cap_cli credentials — sandbox
      // outbound handler RPCs to MAIN_MCP.credentialEgress on
      // every HTTPS request, main resolves cap spec + token, injects
      // Bearer at proxy. Sandbox never holds plaintext token in env or
      // memory. Sentinel env vars (e.g. GITHUB_TOKEN=__cap_managed__) are
      // set here from the cap spec's bootstrap.env so CLIs that refuse to
      // dial out without a token-shaped env value still try; the proxy
      // replaces the sentinel-bearing Authorization header at HTTPS time.
      // v1 managed Sessions keep credentials in the managed Vault store, which
      // only the main worker reads; it returns the placeholders. Legacy
      // `/v1/oma` Sessions (not_found) keep the vault snapshot path unchanged.
      await applyCapCliPlaceholderEnvironment({
        source: this.env.MAIN_MCP,
        tenantId: this.state.tenant_id,
        sessionId: this.state.session_id,
        sandbox,
        legacy: async () => {
          const vaultIds = this.state.vault_ids;
          if (vaultIds.length && sandbox.setEnvVars) {
            try {
              const { builtinSpecs, createSpecRegistry } = await import("@open-managed-agents/cap");
              const registry = createSpecRegistry(builtinSpecs);
              const sentinelEnv: Record<string, string> = {};
              const creds = await this.getVaultCredentials(vaultIds);
              for (const cred of creds) {
                if (cred.auth?.type !== "cap_cli" || !cred.auth.cli_id) continue;
                const spec = registry.byCliId(cred.auth.cli_id);
                if (!spec?.bootstrap?.env) continue;
                for (const [k, v] of Object.entries(spec.bootstrap.env)) {
                  // First cap_cli for a given env var wins. Sentinels are
                  // identical across credentials anyway (all `__cap_managed__`),
                  // so collisions are no-op in practice.
                  if (!(k in sentinelEnv)) sentinelEnv[k] = v;
                }
              }
              if (Object.keys(sentinelEnv).length > 0) {
                await sandbox.setEnvVars(sentinelEnv);
              }
            } catch (err) {
              console.error(
                `[session-do] cap sentinel env injection failed (continuing without): ${(err as Error).message}`,
              );
            }
          }
        },
      });

    } catch (err) {
      this.currentWarmupGen = null;
      this.hasWritableManagedMemoryMount = false;
      console.error(
        `[warmup] failed session=${this.state.session_id ?? "unknown"}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Warmup failed — broadcast error event and re-throw to prevent harness from running
      this.broadcastEvent(createSandboxWarmupFailureEvent(err));
      throw err;
    }
  }

  /** Agents API artifact publication for an execution whose terminal just
   * committed. Main owns the sealed Session mapping, Files and the fence
   * check (shared publisher, idempotent by path + content); this DO only
   * serves its sandbox outputs. A copy failure is reported and never turns
   * the completed execution into a failure. */
  private async publishAgentsApiArtifacts(executionFence: SessionExecutionFence): Promise<void> {
    const binding = this.env.MAIN_MCP;
    const tenantId = this.state.tenant_id;
    const sessionId = this.state.session_id;
    if (binding?.publishManagedSessionArtifacts === undefined || !tenantId || !sessionId) return;
    try {
      await binding.publishManagedSessionArtifacts({
        tenantId,
        sessionId,
        executionFence,
        outputManifest: async () => sandboxStdout(
          await this.getOrCreateSandbox(),
          "cd /workspace && if test -d ./outputs; then find ./outputs -type f -print0 | base64 -w0; fi",
          30_000,
        ),
        readOutput: async (path: string) => readSandboxFileBytes(await this.getOrCreateSandbox(), path, 60_000),
      });
    } catch (error) {
      logWarn(
        {
          op: "session_do.openai_agents.artifact_publication_failed",
          session_id: sessionId,
          execution_id: executionFence.executionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Completed Session output could not be published as an Agents API artifact",
      );
    }
  }

  /** Commit writable canonical Memory mounts before the public idle boundary.
   * The main worker revalidates the durable execution fence before every CAS
   * mutation, so a stale SessionDO may keep running briefly but cannot publish
   * its filesystem view after ownership moves. */
  private async synchronizeManagedMemoryStores(
    executionFence: SessionExecutionFence | undefined,
  ): Promise<void> {
    const binding = this.env.MAIN_MCP;
    const tenantId = this.state.tenant_id;
    const sessionId = this.state.session_id;
    const runtimeGeneration = this.currentWarmupGen;
    if (
      !this.hasWritableManagedMemoryMount
      || binding === undefined
      || executionFence === undefined
      || tenantId.length === 0
      || sessionId.length === 0
      || runtimeGeneration === null
    ) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await binding.synchronizeManagedMemorySnapshots({
          tenantId,
          sessionId,
          runtimeGeneration,
          executionFence,
        });
        if (result.type === "fence_lost") {
          const error = new Error("Managed Memory synchronization lost its execution fence");
          error.name = "ExecutionFenceLostError";
          throw error;
        }
        if (result.type === "not_found") {
          throw new Error(`Managed Session ${sessionId} was not found during Memory synchronization`);
        }
        if (result.conflicts.length > 0 || result.recoveredWipes.length > 0) {
          logWarn(
            {
              op: "session_do.memory_sync.rebased",
              session_id: sessionId,
              conflicts: result.conflicts,
              recovered_wipes: result.recoveredWipes,
            },
            "canonical Memory won one or more workspace reconciliation conflicts",
          );
        }
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "ExecutionFenceLostError") {
          throw error;
        }
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Managed Memory synchronization failed: ${String(lastError)}`);
  }

  /**
   * Publish an event to live sockets + managed D1 projection without the
   * execution-fence gate. Used by the user.interrupt path: requestInterrupt
   * invalidates the turn fence before we emit idle / synthetic tool results,
   * and GET /v1/sessions/:id/events reads the D1 projection (not DO SQLite).
   */
  private broadcastEventIgnoringExecutionFence(event: SessionEvent) {
    const data = JSON.stringify(event);
    const isQueueLifecycle =
      event.type === "system.user_message_cancelled" ||
      (event.type as string) === "system.user_message_steered";
    const sockets = isSpecEvent(event.type)
      ? this.ctx.getWebSockets()
      : isQueueLifecycle
        ? [...new Set([
            ...this.ctx.getWebSockets("chunks"),
            ...this.ctx.getWebSockets("queue_lifecycle"),
          ])]
        : this.ctx.getWebSockets("chunks");
    for (const ws of sockets) {
      try { ws.send(data); } catch { /* closed */ }
    }
    this.projectManagedRuntimeEvent(event, undefined);
  }

  private broadcastEvent(
    event: SessionEvent,
    explicitFence?: SessionExecutionFence,
  ) {
    const executionFence = explicitFence ?? this.executionFenceForEvent(event);
    if (
      executionFence !== undefined &&
      !this.isExecutionFenceCurrent(executionFence)
    ) {
      return;
    }
    this._logModelRequestSpan(event);
    const data = JSON.stringify(event);
    // Per-socket spec-vs-extension routing. Sockets that opted into chunks
    // (tagged "chunks" in the /ws handler) receive everything; others
    // receive only Anthropic-spec event types. Keeps the spec-default
    // wire contract clean for clients using the official Anthropic SDK
    // against an OMA server.
    const isQueueLifecycle =
      event.type === "system.user_message_cancelled" ||
      (event.type as string) === "system.user_message_steered";
    const sockets = isSpecEvent(event.type)
      ? this.ctx.getWebSockets()
      : isQueueLifecycle
        ? [...new Set([
            ...this.ctx.getWebSockets("chunks"),
            ...this.ctx.getWebSockets("queue_lifecycle"),
          ])]
        : this.ctx.getWebSockets("chunks");
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // Connection already closed
      }
    }
    this.projectManagedRuntimeEvent(event, executionFence);
  }

  private projectManagedRuntimeEvent(
    event: SessionEvent,
    executionFence?: SessionExecutionFence,
  ): void {
    const binding = this.env.MAIN_MCP;
    const workspaceId = this._state?.tenant_id;
    const sessionId = this._state?.session_id;
    if (!binding || !workspaceId || !sessionId) return;
    const eventDocument = JSON.stringify(event);
    this._managedProjectionChain = this._managedProjectionChain
      .then(async () => {
        const result = await binding.managedSessionEventProduced({
          workspaceId,
          sessionId,
          event: eventDocument,
          ...(executionFence !== undefined && { executionFence }),
        });
        if (result.type === "version_conflict") {
          throw new Error("managed session projection revision conflict");
        }
      })
      .catch((err) => {
        console.warn(
          `[session_do] managed runtime event projection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Stamp queued accepted inputs in the canonical D1 log once this DO
   * starts processing them, then re-broadcast the same ids with
   * `processed_at` set (Claude Managed Agents semantics).
   */
  private async consumeAcceptedInputs(inputs: readonly { id: string }[], consumingExecutionId: string, processedAt: string): Promise<Set<string>> {
    const broadcastIds = new Set<string>();
    const binding = this.env.MAIN_MCP;
    const workspaceId = this._state?.tenant_id, sessionId = this._state?.session_id;
    if (!binding?.managedSessionEventsMarkProcessed || !workspaceId || !sessionId) return broadcastIds;
    await this._managedProjectionChain;
    await consumeSessionInputs({ markProcessed: async command => {
      const result = await binding.managedSessionEventsMarkProcessed(command);
      if (result.type !== "marked") throw new Error("Session input consumption failed");
      return result.events;
    } }, { workspaceId, sessionId, inputs, consumingExecutionId, processedAt }, events => {
      for (const event of events) {
        const wireEvent = encodeRuntimeSessionEvent(event as never);
        this.broadcastEvent(wireEvent as SessionEvent);
        if ('id' in wireEvent && typeof wireEvent.id === 'string') broadcastIds.add(wireEvent.id);
      }
    });
    return broadcastIds;
  }

  private markAcceptedEventsProcessed(
    eventIds: string[],
    processedAt: string,
  ): void {
    const binding = this.env.MAIN_MCP;
    const workspaceId = this._state?.tenant_id;
    const sessionId = this._state?.session_id;
    if (!binding?.managedSessionEventsMarkProcessed || !workspaceId || !sessionId) return;
    const ids = [...new Set(eventIds.filter((id) => id.length > 0))];
    if (ids.length === 0) return;
    this._managedProjectionChain = this._managedProjectionChain
      .then(async () => {
        await binding.managedSessionEventsMarkProcessed!({
          workspaceId,
          sessionId,
          eventIds: ids,
          processedAt,
        });
      })
      .catch((err) => {
        console.warn(
          `[session_do] markAcceptedEventsProcessed failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private _stampEventForPending(event: SessionEvent): void {
    const e = event as SessionEvent & { id?: string; processed_at?: string };
    if (!e.id) {
      e.id = `sevt_${generateEventId()}`;
    }
    // Queued inputs (message / tool_confirmation): processed_at stays
    // absent until drain stamps the same events row. Do not use this helper
    // for custom_tool_result / tool_result — those are stamped on receipt
    // (official CMA).
    delete e.processed_at;
  }

  /**
   * Broadcast `system.user_message_pending` over WS so live consumers
   * can render the outbox bubble immediately. Carries the canonical
   * event payload (so older clients that key on `user.message` still
   * see the content) AND the row's internal seq as `pending_seq` (the
   * matching `_promoted` frame uses the same number + event id; the wire
   * `seq` stays null until processed_at is stamped).
   */
  private _broadcastPendingFrame(event: SessionEvent, threadId: string): void {
    const eventId = (event as unknown as { id?: string }).id ?? "";
    // The just-enqueued row: same events row that promotion will stamp.
    const row = this.queueRowForEvent(eventId);
    this.broadcastEvent({
      type: "system.user_message_pending",
      event_id: eventId,
      pending_seq: row?.seq ?? 0,
      enqueued_at: row?.enqueued_at ?? Date.now(),
      session_thread_id: threadId,
      event,
    } as SystemUserMessagePendingEvent);
  }

  /**
   * Put a shared usage report (reportSessionUsage / reportModelSpanUsage) on
   * this Session's log: the `session.usage` snapshot is appended, broadcast
   * and projected onto Session.usage like on Node. A child lane's report is
   * tagged with its thread.
   */
  private publishSessionUsage(
    report: SessionUsageReport,
    history: HistoryStore,
    executionFence: SessionExecutionFence | undefined,
    threadId?: string,
  ): void {
    const encoded = encodeRuntimeHistoryEvent(report as never) as unknown as SessionEvent;
    const event = threadId === undefined ? encoded : { ...encoded, session_thread_id: threadId } as SessionEvent;
    history.append(event);
    this.broadcastEvent(event, executionFence);
  }

  /** The application usage meter over this DO's state (session-usage-store). */
  private readonly usageMeter: SessionUsageMeter = createSessionUsageMeter(sessionDoUsageStore({
    get: () => this.state,
    set: (next) => this.setState(next),
  }));

  /**
   * Persist a SessionEvent to the events table AND broadcast to WS subscribers.
   * Used by tools (e.g. web_fetch's aux summarize step) that need to emit
   * trajectory events from outside the harness loop. Inside the harness loop,
   * `runtime.broadcast` already does both — this is the equivalent for tool
   * code that doesn't receive a runtime context.
   */
  private persistAndBroadcastEvent(
    event: SessionEvent,
    laneId?: string,
    executionFence?: SessionExecutionFence,
  ) {
    const fence = executionFence ?? (laneId ? this._executionFences.get(laneId) : undefined);
    if (fence !== undefined && !this.isExecutionFenceCurrent(fence)) {
      // The harness is stale. SandboxExecutionGuard will stop provider calls;
      // this check closes the local event-log side of the same boundary.
      return;
    }
    try {
      const history = this.openHistory();
      history.append(event);
    } catch (err) {
      console.warn(`[persistAndBroadcastEvent] history.append failed: ${(err as Error).message}`);
    }
    this.broadcastEvent(event, fence);
    this.fanOutToHooks(event);
  }

  /** Fire-and-forget POST every event to each registered hook. Provider-
   *  specific consumers (Linear panel mirror, Slack thread mirror, etc.)
   *  live behind these URLs — SessionDO has no knowledge of them. Hooks
   *  are configured at /init via SessionInitParams.event_hooks.
   *
   *  Per-DO promise chain serializes the POSTs so they reach consumers in
   *  broadcast order. Without this, fast events (final agent.message) can
   *  outrun slower ones (earlier thoughts) and panel UIs render out of
   *  order. Each event waits for the previous fan-out to finish before
   *  kicking off, trading a few hundred ms of accumulated latency for
   *  strict ordering. */
  private hookChain: Promise<unknown> = Promise.resolve();

  private fanOutToHooks(event: SessionEvent): void {
    const hooks = this.state.event_hooks;
    if (!hooks?.length) return;
    const body = JSON.stringify(event);
    this.hookChain = this.hookChain
      .then(() =>
        Promise.all(
          hooks.map((hook) => {
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (hook.auth) headers["x-internal-secret"] = hook.auth;
            return fetch(hook.url, { method: "POST", headers, body }).catch((err) => {
              console.warn(
                `[event-hook ${hook.name}] post failed: ${(err as Error).message}`,
              );
            });
          }),
        ),
      )
      .catch(() => {
        // chain swallows errors so a single bad hook can't break later
        // events from being delivered.
      });
  }

  /**
   * Resolve credentials and the wire-level model string for an agent's
   * `model` value (which is a card.model_id handle, not the LLM API model).
   *
   * The only source is the session tenant's own model card. There is no
   * platform-key fallback: a workspace that has not configured `handle`
   * gets ModelCardNotConfiguredError, which fails the turn with a message
   * pointing at Console → Models.
   */
  private async resolveModelCardCredentials(
    handle: string,
  ): Promise<ResolvedModelCardCredentials> {
    const tenantId = this.state.tenant_id;
    const services = await getCfServicesForTenant(this.env, tenantId);
    const card = await resolveWorkspaceModelCredentials(services.modelCards, tenantId, handle);
    console.log(`[model-card] resolved from D1: id=${card.cardId} model_id=${handle} model=${card.wireModel} baseURL=${card.baseURL ?? "(default)"} provider=${card.provider}`);
    return bindStoredModelCardCredentials(card);
  }

  /**
   * Session budget gate for this turn. Active only when the canonical
   * session has `budget.max_list_cost` AND the model card has pricing;
   * otherwise null (no enforcement, no error).
   */
  /** The current execution's egress meter; subagent contexts share it. */
  private activeBudgetGate: SessionBudgetGate | null = null;

  private async resolveBudgetGate(handle: string): Promise<SessionBudgetGate | null> {
    this.activeBudgetGate = null;
    if (!this.env.MAIN_DB || !this.state.tenant_id || !this.state.session_id) return null;
    try {
      const db = await buildCfTenantDbProvider(this.env).resolve(this.state.tenant_id);
      const context = await new SqlSessionExecutionContextSource(new CfD1SqlClient(db)).find({
        workspaceId: this.state.tenant_id,
        sessionId: this.state.session_id,
      });
      if (!context) return null;
      const tenantId = this.state.tenant_id;
      // Application gate opener; the CF ListCostPicoStore persists the domain
      // property list_cost_pico in DO state.
      const gate = await openSessionBudgetGate({
        session: context.session,
        pricing: async () => {
          const services = await getCfServicesForTenant(this.env, tenantId);
          const card = await services.modelCards.findByModelId({ tenantId, modelId: handle });
          return activeModelCardPricing(card);
        },
        store: {
          load: (): string | null => this.state.list_cost_pico ?? null,
          save: (list_cost_pico: string): void => {
            this.setState({ ...this.state, list_cost_pico });
          },
        },
      });
      this.activeBudgetGate = gate;
      return gate;
    } catch (err) {
      logWarn(
        { op: "session_do.budget_gate", session_id: this.state.session_id, err },
        "budget gate unavailable; turn runs without budget enforcement",
      );
      return null;
    }
  }

  /** The main model handle for `agent`, matching every turn path. */
  private agentModelHandle(agent: AgentConfig): string {
    const handle = typeof agent.model === "string" ? agent.model : agent.model?.id;
    return handle || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  }

  /**
   * Resolve the agent's auxiliary model (when configured).
   *
   * Returns null when the agent has no aux_model set — callers should
   * skip aux features (e.g. web_fetch summarization) in that case.
   */
  private async resolveAuxModel(agent: AgentConfig): Promise<{
    model: LanguageModel;
    modelInfo: { model_id: string };
    providerOptions?: SharedV3ProviderOptions;
  } | null> {
    if (!agent.aux_model) return null;
    const handle = typeof agent.aux_model === "string" ? agent.aux_model : agent.aux_model.id;
    const creds = await this.resolveModelCardCredentials(handle);
    const model = toAiSdkLanguageModel(createPiModelRuntime({
      model: creds.model,
      apiKey: creds.apiKey,
      provider: creds.provider,
      baseURL: creds.baseURL,
      customHeaders: creds.customHeaders,
      piConfig: creds.piConfig,
      providerOptions:
        typeof agent.aux_model !== "string" &&
        agent.aux_model.provider_options?.pi &&
        typeof agent.aux_model.provider_options.pi === "object" &&
        !Array.isArray(agent.aux_model.provider_options.pi)
          ? agent.aux_model.provider_options.pi as Record<string, unknown>
          : undefined,
      speed: typeof agent.aux_model === "string" ? undefined : agent.aux_model.speed,
    }));
    return {
      model,
      modelInfo: { model_id: handle },
      ...(typeof agent.aux_model !== "string" &&
        agent.aux_model.provider_options !== undefined && {
          providerOptions: agent.aux_model.provider_options as SharedV3ProviderOptions,
        }),
    };
  }

  /**
   * Handle tool confirmation: execute the confirmed tool or inject denial,
   * then re-run the harness to continue the conversation.
   */
  private async handleToolConfirmation(
    confirmation: UserToolConfirmationEvent,
    history: HistoryStore,
    parentSignal?: AbortSignal,
    executionFence?: SessionExecutionFence,
  ): Promise<void> {
    // Wrapped sandbox: per-method warmup happens inside any actual call.
    if (this.toolUseAlreadyAnswered(confirmation.tool_use_id, history)) return;
    // Confirmation handlers may not even touch the sandbox depending on
    // tool type, so eager warmup is wasted; lazy is the right default.
    const sandbox = this.bindSandboxToExecution(
      await this.getOrCreateSandbox(),
      parentSignal,
      executionFence,
      (confirmation as unknown as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
    );
    void this.warmUpSandbox().catch(() => { /* surfaces via tool exec */ });

    // Retrieve the pending tool call from session metadata
    const pendingCalls = this.state.pending_tool_calls;
    const pending = pendingCalls.find(p => p.toolCallId === confirmation.tool_use_id);

    if (confirmation.result === "allow" && pending) {
      // Execute the tool
      const agent = await this.getThreadAgentConfig(
        (confirmation as unknown as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
      );

      if (agent) {
        // Fetch environment config for networking restrictions
        const envId = this.state.environment_id;
        let environmentConfig: { networking?: { type: string; allowed_hosts?: string[] } } | undefined;
        if (envId) {
          const envCfg = await this.getEnvConfig(envId);
          if (envCfg) {
            environmentConfig = envCfg.config;
          }
        }

        // Tool definitions must reflect the fully prepared runtime. Resource
        // mount failures must stop the confirmation continuation.
        await this.warmUpSandbox();

        // Build tools with execute functions intact (not stripped for always_ask).
        // Sub-agent tools run on this session's own model-card credentials.
        const auxResolved = await this.resolveAuxModel(agent);
        const confirmationCreds = await this.resolveModelCardCredentials(this.agentModelHandle(agent));
        const allTools = await buildTools(agent, sandbox, {
          ...delegationCredentials(confirmationCreds),
          TAVILY_API_KEY: this.env.TAVILY_API_KEY,
          toMarkdown: cfWorkersAiToMarkdown(this.env.AI),
          environmentConfig,
          mcpBinding: this.env.MAIN_MCP,
          tenantId: this.state.tenant_id,
          sessionId: this.state.session_id,
          browser: this.getBrowserHarness() ?? undefined,
          auxModel: auxResolved?.model,
          auxModelInfo: auxResolved?.modelInfo,
          auxProviderOptions: auxResolved?.providerOptions,
          broadcastEvent: (event) => this.persistAndBroadcastEvent(
            event,
            (confirmation as unknown as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
            executionFence,
          ),
          scheduleWakeup: (a) => this.scheduleWakeup(a),
          cancelWakeup: (id) => this.cancelWakeup(id),
          listWakeups: () => this.listWakeups(),
        }, { enforcePermissions: false });

        // The user approved this call, so build without always_ask stripping
        // to get the executable tool. A call proxied through mcp_invoke runs
        // its target tool with the target's arguments.
        const target = resolveProxiedToolCall(pending.toolName, pending.args);
        const originalTool = allTools[target.toolName];
        if (originalTool?.execute) {
          try {
            const result = await originalTool.execute(target.args, {
              toolCallId: pending.toolCallId,
              messages: [],
              abortSignal: undefined,
            });
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              content: resultStr,
              // v1-additive (docs/trajectory-v1-spec.md "Causality"):
              // matching agent.tool_use's EventBase.id IS pending.toolCallId.
              parent_event_id: pending.toolCallId,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          } catch (e) {
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              // ToolFailureError messages are pre-formatted model-facing
              // text ("Error: " prefix included); use them verbatim.
              content: e instanceof ToolFailureError ? e.message : `Error: ${e instanceof Error ? e.message : String(e)}`,
              parent_event_id: pending.toolCallId,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          }
        }
        await disposeTools(allTools);
      }
    } else {
      // Denied or not found — inject denial result
      const denyMsg = confirmation.deny_message || "Tool execution was denied by the user.";
      const toolResultEvent: SessionEvent = {
        type: "agent.tool_result",
        tool_use_id: confirmation.tool_use_id,
        content: `Denied: ${denyMsg}`,
        // v1-additive: matching agent.tool_use's EventBase.id IS the
        // tool_use_id the confirmation references.
        parent_event_id: confirmation.tool_use_id,
      };
      history.append(toolResultEvent);
      this.broadcastEvent(toolResultEvent);
    }

    // Remove the confirmed/denied call from pending, and only resume the
    // model once every parallel call of the batch has a result.
    await this.resumeWhenToolBatchSettled(confirmation.tool_use_id, history, parentSignal, executionFence);
  }

  /**
   * A model step can emit several tool calls at once (parallel
   * custom_tool_use / always_ask tool_use). Each one is answered by its own
   * user event. Resuming the model after the FIRST answer replays a
   * transcript with unmatched tool_use blocks, which providers reject
   * (400 "tool_result without tool_use" / missing results) and the turn
   * then loops through rescheduled+error. CMA semantics: stay
   * idle(requires_action) listing the still-outstanding ids, and resume
   * only when the whole batch is settled.
   */
  /**
   * The aborted step's partial output can still land after user.interrupt
   * (stream-end fixup persists it), including tool_use blocks. Left open,
   * a client would answer them and the continuation would silently resume
   * the interrupted turn. Close every unpaired call with an interrupted
   * result; late answers are then dropped by toolUseAlreadyAnswered.
   */
  private closeToolUsesAfterInterrupt(history: HistoryStore, fence?: SessionExecutionFence, threadId = "sthr_primary"): number {
    let closedCount = 0;
    const closedIds = new Set<string>();
    try {
      const events = history.getEvents();
      const answered = new Set<string>();
      for (const e of events) {
        if (e.type === "agent.tool_result") {
          const id = (e as unknown as { tool_use_id?: string }).tool_use_id;
          if (id) answered.add(id);
        }
      }
      for (const e of events) {
        if (e.type !== "agent.tool_use" && e.type !== "agent.custom_tool_use") continue;
        if (((e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary") !== threadId) continue;
        const id = (e as unknown as { id?: string }).id;
        if (!id || answered.has(id)) continue;
        closedIds.add(id);
        // Same shape as the existing interruptPending settle path above
        // (agent.tool_result, is_error, interrupted); openma-common
        // decodes it to the existing OpenMA `tool.failed`. No new fields.
        const thread = (e as { session_thread_id?: string }).session_thread_id;
        const closed = {
          type: "agent.tool_result",
          tool_use_id: id,
          content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
          is_error: true,
          ...(thread && thread !== "sthr_primary" ? { session_thread_id: thread } : {}),
        } as unknown as SessionEvent;
        history.append(closed);
        if (fence === undefined) this.broadcastEventIgnoringExecutionFence(closed);
        else this.broadcastEvent(closed, fence);
        closedCount++;
      }
      const before = this.state.pending_tool_calls ?? [];
      const remaining = before.filter((pending) => !closedIds.has(pending.toolCallId));
      if (remaining.length !== before.length) {
        this.setState({ ...this.state, pending_tool_calls: remaining });
      }
    } catch (err) {
      console.warn("[interrupt] closing open tool calls failed:", err);
    }
    return closedCount;
  }

  private toolUseExists(toolUseId: string, history: HistoryStore): boolean {
    try {
      return history.getEvents().some((e) =>
        (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use" || e.type === "agent.mcp_tool_use") &&
        (e as unknown as { id?: string }).id === toolUseId);
    } catch {
      return true;
    }
  }

  /**
   * Official CMA: "A second result for the same call is accepted and has no
   * effect." An answer for a call that is already closed (interrupt, or a
   * duplicate POST) is stored with processed_at stamped and echoed, but is
   * NOT enqueued: no model-history append, no loop wake, no status change.
   */
  /**
   * Official CMA settle-only window: latest status on the lane is idle with
   * stop_reason requires_action and at least one outstanding event_id (or
   * DO state still lists pending_tool_calls). budget_reached is not enforced
   * here yet (emitter/gate gap — see cma-steer-coherent-turn.md).
   */
  private laneSettleOnlyReason(history: HistoryStore, threadId: string): SettleOnlyReason | null {
    const pending = this.state.pending_tool_calls ?? [];
    if (pending.length > 0) return "requires_action";
    try {
      return settleOnlyReason(
        history.getEvents() as Array<{ type?: string; [key: string]: unknown }>,
        threadId,
      );
    } catch {
      return null;
    }
  }

  private acceptNoEffectAnswer(event: SessionEvent, history: HistoryStore): Response {
    const e = event as SessionEvent & { id?: string; processed_at?: string };
    if (!e.id) e.id = `sevt_${generateEventId()}`;
    e.processed_at = this.processedClock.nowIso();
    history.append(e);
    this.broadcastEvent(e);
    return new Response(null, { status: 202 });
  }

  private toolUseAlreadyAnswered(toolUseId: string, history: HistoryStore): boolean {
    try {
      return history.getEvents().some((e) =>
        e.type === "agent.tool_result" &&
        (e as unknown as { tool_use_id?: string }).tool_use_id === toolUseId);
    } catch {
      return false;
    }
  }

  private async resumeWhenToolBatchSettled(
    answeredId: string,
    history: HistoryStore,
    signal?: AbortSignal,
    fence?: SessionExecutionFence,
  ): Promise<void> {
    const before = this.state.pending_tool_calls ?? [];
    let resolved = new Set<string>([answeredId]);
    if (before.length > 1) {
      try {
        for (const e of history.getEvents()) {
          if (e.type === "agent.tool_result") {
            const id = (e as unknown as { tool_use_id?: string }).tool_use_id;
            if (id) resolved.add(id);
          }
        }
      } catch { resolved = new Set([answeredId]); }
    }
    const remaining = before.filter((p) => !resolved.has(p.toolCallId));
    this.setState({ ...this.state, pending_tool_calls: remaining });
    if (remaining.length > 0) {
      const builtin = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"];
      const anyCustom = remaining.some((p) => {
        const name = resolveProxiedToolCall(p.toolName, p.args).toolName;
        return !builtin.includes(name) && !name.startsWith("mcp_") &&
          !name.startsWith("call_agent_") && !name.startsWith("memory_");
      });
      const idleEvent: SessionEvent = {
        type: "session.status_idle",
        stop_reason: {
          type: "requires_action",
          action_type: anyCustom ? "custom_tool_result" : "tool_confirmation",
          event_ids: remaining.map((p) => p.toolCallId),
        },
      } as SessionEvent;
      history.append(idleEvent);
      this.broadcastEvent(idleEvent, fence);
      return;
    }
    // Re-run the harness to continue the conversation
    // Use an empty user message — the history already has the tool result
    const resumeMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: "" }],
    };
    await this.processUserMessage(resumeMsg, 0, true, signal, fence);
  }

  /**
   * Resolve a credential token from vault by credential ID.
   */
  private async resolveCredentialToken(credentialId?: string): Promise<string | null> {
    if (!credentialId) return null;
    const vaultIds = this.state.vault_ids;
    // Prefer snapshot — works in staging where CONFIG_KV is the wrong namespace.
    const snapshotCreds = await this.getVaultCredentials(vaultIds);
    for (const cred of snapshotCreds) {
      if (cred.id === credentialId) {
        return cred.auth?.token || cred.auth?.access_token || null;
      }
    }
    // Fallback: direct KV lookup. Already covered by getVaultCredentials when
    // the snapshot is absent, but we keep this exact-key get as a fast path.
    for (const vaultId of vaultIds) {
      const credData = await this.env.CONFIG_KV.get(this.tk("cred", vaultId, credentialId));
      if (credData) {
        const cred = JSON.parse(credData);
        return cred.auth?.token || cred.auth?.access_token || null;
      }
    }
    return null;
  }

  /**
   * Register a background task for completion tracking.
   * Starts a setInterval poller that checks process status every 2s.
   * When complete, injects a task_notification event and re-triggers harness.
   * Event-driven completion notification — but poll-based since we can't
   * get exit events from container processes.
   */
  /**
   * Watch a background task for completion. Uses Agent schedule system
   * instead of setInterval so it survives DO hibernation.
   *
   * Task metadata is stored in SQLite so it persists across hibernation.
   */
  private async watchBackgroundTask(
    taskId: string,
    pid: string,
    outputFile: string,
    _proc: ProcessHandle | null,
    _sandbox: SandboxExecutor,
  ): Promise<void> {
    // Persist task info to SQLite (survives hibernation)
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS background_tasks (
        task_id TEXT PRIMARY KEY,
        pid TEXT NOT NULL,
        output_file TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO background_tasks (task_id, pid, output_file) VALUES (?, ?, ?)`,
      taskId, pid, outputFile
    );

    // Schedule first poll in 3 seconds (survives hibernation)
    try {
      const sched = await this.schedule(3, "pollBackgroundTasks");
      // Emit debug event so we can verify schedule was set
      const history = this.openHistory();
      history.append({ type: "span.background_task_scheduled", task_id: taskId, schedule_id: sched?.id } as any);
      this.broadcastEvent({ type: "span.background_task_scheduled", task_id: taskId, schedule_id: sched?.id } as any);
    } catch (err) {
      const history = this.openHistory();
      history.append({ type: "session.error", error: `watchBackgroundTask schedule failed: ${err}` });
      this.broadcastEvent({ type: "session.error", error: `watchBackgroundTask schedule failed: ${err}` });
    }
  }

  /**
   * Scheduled callback: poll all background tasks for completion.
   * Called by Agent schedule system — survives DO hibernation.
   */
  async pollBackgroundTasks(): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS background_tasks (
        task_id TEXT PRIMARY KEY, pid TEXT NOT NULL,
        output_file TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
      )`
    );

    const tasks = this.ctx.storage.sql.exec(
      `SELECT task_id, pid, output_file, created_at FROM background_tasks`
    ).toArray();

    if (!tasks.length) return;

    const sandbox = await this.getOrCreateSandbox();
    let anyPending = false;
    const BG_TASK_MAX_LIFETIME_MS = 30 * 60 * 1000;

    for (const task of tasks) {
      const { task_id, pid, output_file, created_at } = task as { task_id: string; pid: string; output_file: string; created_at: string };
      try {
        // Hard lifetime cap — bg tasks can keep the container (and the
        // worker billing meter) alive forever otherwise. SIGKILL the pid,
        // inject a synthetic user.message so the agent sees the kill and
        // doesn't block on a notification that's never coming.
        const ageMs = Date.now() - Date.parse(created_at + "Z");
        const overCap = Number.isFinite(ageMs) && ageMs > BG_TASK_MAX_LIFETIME_MS;
        if (overCap) {
          let killNote = "";
          if (pid && /^\d+$/.test(pid)) {
            try { await sandbox.exec(`kill -9 ${pid} 2>/dev/null; true`, 5000); } catch (e) {
              killNote = ` (kill failed: ${(e as Error).message ?? e})`;
            }
          }
          let output = "";
          try { output = await sandbox.readFile(output_file); } catch {}
          const ageMin = Math.round(ageMs / 60000);
          const notifEvent: SessionEvent = {
            type: "user.message",
            content: [{
              type: "text",
              text: `<task_notification>\nBackground task ${task_id} exceeded the 30-minute lifetime cap and was killed${killNote}.\nRan for: ${ageMin} min\nOutput file (partial): ${output_file}\n\n${output.slice(0, 3000)}\n</task_notification>`,
            }],
          };
          // Route through the single-table queue so drain promotes it the same way
          // a real user.message does — ensures the harness actually runs
          // a turn for the notification.
          this._stampEventForPending(notifEvent);
          if (this.enqueueQueueInputIfNew(notifEvent)) {
            this._broadcastPendingFrame(notifEvent, "sthr_primary");
          }
          this.ctx.storage.sql.exec(`DELETE FROM background_tasks WHERE task_id = ?`, task_id);
          await this.drainEventQueue();
          continue;
        }

        // Check if process is still running
        let taskDone = false;
        if (!pid || pid === "undefined" || !/^\d+$/.test(pid)) {
          // Invalid pid — check if output file exists and has content
          try {
            const content = await sandbox.readFile(output_file);
            taskDone = content != null && content.trim().length > 0;
          } catch {
            taskDone = false;
          }
        } else {
          const check = await sandbox.exec(`kill -0 ${pid} 2>/dev/null && echo running || echo done`, 5000);
          taskDone = check.includes("done");
        }
        if (!taskDone) {
          anyPending = true;
          continue;
        }

        // Task completed — read output and inject notification
        let output = "";
        try { output = await sandbox.readFile(output_file); } catch {}

        const notifEvent: SessionEvent = {
          type: "user.message",
          content: [{
            type: "text",
            text: `<task_notification>\nBackground task ${task_id} completed.\nOutput file: ${output_file}\n\n${output.slice(0, 3000)}\n</task_notification>`,
          }],
        };
        // Route through the single-table queue so drain promotes it the same way
        // a real user.message does — ensures the harness actually runs
        // a turn for the notification.
        this._stampEventForPending(notifEvent);
        if (this.enqueueQueueInputIfNew(notifEvent)) {
          this._broadcastPendingFrame(notifEvent, "sthr_primary");
        }

        // Remove completed task
        this.ctx.storage.sql.exec(`DELETE FROM background_tasks WHERE task_id = ?`, task_id);

        // Re-trigger harness
        await this.drainEventQueue();
      } catch (err) {
        anyPending = true;
        logWarn(
          { op: "session_do.background_task.reap", session_id: this.state.session_id, task_id, err },
          "background task reap failed; will retry next poll",
        );
      }
    }

    // Schedule next poll if there are still pending tasks. Container
    // sleepAfter (20m) is comfortably longer than typical bg-task wait,
    // and each sandbox.exec() in the next poll auto-renews the timer.
    if (anyPending) {
      try {
        await this.schedule(5, "pollBackgroundTasks");
      } catch (err) {
        console.error("[pollBackgroundTasks] reschedule failed:", err);
      }
    }
  }

  /**
   * Run a sub-agent within the same session. Creates an isolated thread
   * with its own message history but shares the same sandbox. Events are
   * tagged with thread_id and written to the parent event log.
   *
   * `parentThreadId` records which thread spawned this one — primary
   * for top-level call_agent_*, or a sub-agent's own threadId when one
   * sub-agent recursively delegates. Stored in the threads SQL row and
   * broadcast on session.thread_created so consumers can build the
   * full tree (Console renders nested when depth > 1).
   */
  private async runSubAgent(
    agentId: string,
    message: string,
    parentHistory: HistoryStore,
    sandbox: SandboxExecutor,
    parentThreadId: string = "sthr_primary",
    parentSignal?: AbortSignal,
  ): Promise<string> {
    // Both inline and predefined children use the immutable Session snapshot.
    const parentConfig = parentThreadId === "sthr_primary"
      ? this.state.agent_snapshot : this.threads.get(parentThreadId)?.agentConfig;
    if (!parentConfig) throw new Error("Pinned parent agent snapshot is unavailable");
    // #545 §0.7: one orchestration for both platforms
    // (@open-managed-agents/session-subagents). This DO supplies the thread
    // row, the Cloudflare wire events and the child harness turn.
    const subagents = new SessionSubagents<AgentConfig>({
      parentThreadId,
      parentAgentName: parentConfig.name,
      abortSignal: parentSignal ?? new AbortController().signal,
      resolveAgent: async (request) => {
        const agent = resolvePinnedSubagent(parentConfig, request.agentId ?? "general");
        return { agentId: request.agentId ?? "general", agentName: agent.name, agent };
      },
      // Optional generic host hook for session-thread starts (unbound → admit).
      // A denial fails the spawn before any thread row or event is written.
      admission: {
        admit: async ({ agent }) => {
          const environment = this.state.environment_id
            ? await this.getEnvConfig(this.state.environment_id)
            : null;
          const decision = await admitViaSessionAdmissionHook(this.env.SESSION_ADMISSION, {
            kind: "thread_start",
            workspaceId: this.state.tenant_id,
            sessionId: this.state.session_id,
            agentId: agent.id,
            environmentId: this.state.environment_id,
            isLocalRuntime: agent.runtime_binding != null || environment?.config?.type === "self_hosted",
          });
          if (decision.type === "denied") throw new SessionAdmissionDeniedError(decision.status, decision.body);
        },
      },
      threads: {
        insert: async (thread) => {
          // Child runtime events inherit the parent's execution fence: the
          // child is a logical lane, not a second execution owner.
          this._executionParentLane.set(thread.id, thread.parentThreadId);
          // In-memory map (hot path config lookup) + persistent threads row
          // (survives DO eviction, lets HTTP CRUD see this thread).
          this.threads.set(thread.id, { agentId: thread.agentId, agentConfig: thread.agent });
          this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            thread.id, thread.agentId, thread.agentName, thread.parentThreadId, Date.now(),
          );
          return thread;
        },
        // Each delegate call owns its children; nothing is restored by id.
        find: async () => null,
      },
      events: {
        emit: async (event) => {
          try {
            for (const wire of cloudflareSubagentWireEvents(event)) {
              parentHistory.append(wire);
              this.broadcastEvent(wire);
            }
          } catch (error) {
            // A lost parent fence deliberately rejects the terminal marker.
            if (event.type !== "thread_idle") throw error;
          } finally {
            if (event.type === "thread_idle") this._executionParentLane.delete(event.threadId);
          }
        },
      },
      turns: { run: (input) => this.runSubAgentTurn(input, parentHistory, sandbox) },
      ids: { threadId: cloudflareSubagentThreadId, messageId: () => `sevt_${generateEventId()}` },
    });
    return subagents.delegate({ agentId, message });
  }

  /** One child harness turn on the shared sandbox (session-subagents turn Port). */
  private async runSubAgentTurn(
    input: SubagentTurnInput<AgentConfig>,
    parentHistory: HistoryStore,
    sandbox: SandboxExecutor,
  ): Promise<SubagentTurnResult> {
    const threadId = input.thread.id;
    const parentThreadId = input.thread.parentThreadId;
    const subAgent = input.thread.agent;
    const subEnvironment = this.state.environment_id
      ? await this.getEnvConfig(this.state.environment_id)
      : null;

    // Create sub-agent's isolated history
    const subHistory = new InMemoryHistory(this.processedClock);
    const userMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: input.message?.text ?? "" }],
    };
    subHistory.append(userMsg);

    // Resolve harness for the sub-agent
    let harness: HarnessInterface;
    let resolvedHarnessName = subAgent.harness || "default";
    try {
      harness = resolveHarness(resolvedHarnessName);
    } catch (err) {
      logWarn(
        { op: "session_do.subagent.harness_resolve", session_id: this.state.session_id, agent_id: subAgent.id, requested: subAgent.harness, err },
        "sub-agent harness unknown; falling back to default",
      );
      resolvedHarnessName = "default";
      harness = resolveHarness(resolvedHarnessName);
    }

    // The child's interrupt slot is the domain turn's controller (already
    // linked to the parent lease). The sandbox instance is shared for
    // filesystem continuity; this guard makes a child-targeted interrupt stop
    // provider calls made by the child without affecting sibling lanes.
    const abortController = input.abortController;
    this._threadAbortControllers.set(threadId, abortController);
    const childSandbox = withSandboxExecutionGuard(sandbox, {
      signal: abortController.signal,
    });

    // Build sub-agent tools and model (platform prepares context for sub-agent too)
    let childSignal: AbortSignal | undefined = abortController.signal;
    const subAuxResolved = await this.resolveAuxModel(subAgent);
    // The child runs on its own model card in this session's workspace; its
    // nested delegation tools inherit those credentials, never an env key.
    const subModelId = typeof subAgent.model === "string" ? subAgent.model : subAgent.model?.id;
    if (!subModelId) throw new Error("Incomplete runtime agent snapshot: missing model");
    const subCreds = await this.resolveModelCardCredentials(subModelId);
    const subTools = await buildTools(subAgent, childSandbox, {
      ...delegationCredentials(subCreds),
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      toMarkdown: cfWorkersAiToMarkdown(this.env.AI),
      environmentConfig: subEnvironment?.config,
      mcpBinding: this.env.MAIN_MCP,
      tenantId: this.state.tenant_id,
      sessionId: this.state.session_id,
      browser: this.getBrowserHarness() ?? undefined,
      auxModel: subAuxResolved?.model,
      auxModelInfo: subAuxResolved?.modelInfo,
      auxProviderOptions: subAuxResolved?.providerOptions,
      broadcastEvent: (event) => this.persistAndBroadcastEvent(
        event,
        parentThreadId,
        this._executionFences.get(parentThreadId),
      ),
      // Subagents do NOT get the schedule tool. onScheduledWakeup is a
      // SessionDO-level callback with no per-thread routing — a wakeup
      // injected by a subagent lands in the parent session's main event
      // stream, where the parent agent (different model + system prompt)
      // sees a user.message it didn't trigger and behaves erratically. If
      // we ever want subagent-scoped cron, the wakeup payload needs to
      // carry a thread_id and onScheduledWakeup needs to dispatch into
      // the right subHistory. Until then, omit the closures entirely so
      // tools.schedule / cancel_schedule / list_schedules don't get
      // registered into subTools at all.
      delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
        // Nested delegate: this sub-agent's threadId becomes the new
        // child's parent. Lineage chain matches what Console renders.
        return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, childSandbox, threadId, childSignal);
      },
    });
    const subPiRuntime = createPiModelRuntime({
      model: subCreds.model,
      apiKey: subCreds.apiKey,
      provider: subCreds.provider,
      baseURL: subCreds.baseURL,
      customHeaders: subCreds.customHeaders,
      piConfig: subCreds.piConfig,
      providerOptions:
        typeof subAgent.model !== "string" &&
        subAgent.model.provider_options?.pi &&
        typeof subAgent.model.provider_options.pi === "object" &&
        !Array.isArray(subAgent.model.provider_options.pi)
          ? subAgent.model.provider_options.pi as Record<string, unknown>
          : undefined,
      thinkingLevel: typeof subAgent.model === "string" ? undefined : subAgent.model.effort,
      speed: typeof subAgent.model === "string" ? undefined : subAgent.model.speed,
    });
    const subModel = toAiSdkLanguageModel(subPiRuntime);

    const skillBinding = this.env.MAIN_MCP;
    const subSkillFiles = await resolveRuntimeSkillFiles(subAgent,
      skillBinding?.resolveManagedSkillVersion
        ? { resolveManagedSkillVersion: input => skillBinding.resolveManagedSkillVersion!({ tenantId: this.state.tenant_id, ...input }) }
        : undefined,
      this.env.CONFIG_KV ? () => getSkillFiles(subAgent.skills ?? [], this.env.CONFIG_KV!, this.env.FILES_BUCKET, this.state.tenant_id) : undefined,
    );
    const subSkillReminders = await resolveSubagentSkillReminders(subAgent, undefined, subSkillFiles);
    await mountSkillFiles(childSandbox, subSkillFiles);
    // Build sub-agent context: own history, shared sandbox, parent event log
    const subCtx: HarnessContext = {
      agent: subAgent,
      userMessage: userMsg,
      tools: subTools,
      model: subModel,
      pi: subPiRuntime,
      // Same session egress meter as the parent turn.
      budget: this.activeBudgetGate,
      systemPrompt: composeSystemPrompt(subAgent.system || "", subSkillReminders),
      platformReminders: subSkillReminders,
      // The child runs inside this Session: per-session harness bookkeeping
      // (e.g. the one-time ai-sdk deprecation session.warning) keys on it.
      session_id: this.state.session_id,
      // Sub-agent inherits the parent's tenant — same daemon, same per-tenant
      // ACP child key resolution. AcpProxyHarness reads this to forward
      // x-harness-tenant when opening a RuntimeRoom WS for the sub-agent.
      tenant_id: this.state.tenant_id,
      // Same resolver the primary HarnessContext uses — the sub-agent shares
      // the parent's tenant + R2 bucket so an `image`/`document` block with
      // a file_id source in a future sub-agent user message would resolve
      // through the same path. Sub-agents currently only synthesize a text
      // user.message in `runSubAgent`, but wiring this keeps the contract
      // symmetric and ready when richer sub-turns land.
      fileFetcher: this.buildFileFetcher(this.state.tenant_id),
      env: {
        ...delegationCredentials(subCreds),
        ANTHROPIC_MODEL: this.env.ANTHROPIC_MODEL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        // Sub-agent LLM calls share the same logging plumbing — span
        // events emitted via parent broadcast carry body_r2_key under
        // the SAME tenant + session keying. event_id stays unique per
        // call because each model_request_start mints a fresh sevt_*.
        ...(this.env.LLM_LOGS_DISABLED === "1"
          ? {}
          : {
              llmLog: {
                tenant_id: this.state.tenant_id,
                session_id: this.state.session_id,
                r2: this.env.FILES_BUCKET ?? null,
              },
            }),
        delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
          // Nested delegate inside the env block; see runtime block
          // above for the same lineage rule.
          return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, childSandbox, threadId, childSignal);
        },
      },
      runtime: {
        history: subHistory,
        sandbox: childSandbox,
        broadcast: (event) => {
          subHistory.append(event);
          const taggedEvent = { ...event, session_thread_id: threadId };
          parentHistory.append(taggedEvent);
          this.broadcastEvent(taggedEvent);
          this.fanOutToHooks(taggedEvent);
          const cacheUsage = reportModelSpanUsage(this.usageMeter, threadId, taggedEvent, this.activeBudgetGate);
          if (cacheUsage !== null) this.publishSessionUsage(cacheUsage, parentHistory, this._executionFences.get(parentThreadId), threadId);
        },
        ...this.buildStreamRuntimeMethods(
          threadId,
          this._executionFences.get(parentThreadId),
        ),
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          this.publishSessionUsage(
            reportSessionUsage(this.usageMeter, threadId, { input_tokens, output_tokens }, this.activeBudgetGate),
            parentHistory, this._executionFences.get(parentThreadId), threadId,
          );
        },
        abortSignal: abortController.signal,
        // Sub-agent runs inside supervisor's harness.run, which is
        // wrapped by adapter.beginTurn → sessions.status='running' for
        // the entire nested-await chain. The supervisor's status
        // marker covers sub-agent execution — no separate keep-alive
        // needed. (Earlier we routed this through a dedicated
        // RuntimeAdapter.keepAliveWhile port, but it was redundant
        // with the supervisor marker; reverted 2026-05-10 after
        // root-cause analysis pointed at alarm body running LLM
        // streams as the actual eviction trigger.)
        keepAliveWhile: <T>(fn: () => Promise<T>) => fn(),
      },
    };

    try {
      await harness.run(subCtx);
      return {
        agentMessages: subHistory.getEvents()
          .filter((e: SessionEvent) => e.type === "agent.message")
          .map((e: SessionEvent) => (e as AgentMessageEvent).content?.map((b) => b.type === "text" ? b.text : "").join("") || ""),
      };
    } finally {
      await disposeTools(subTools);
      // Identity-guarded delete: a nested child on the same threadId would
      // have replaced our slot — don't stomp on its controller.
      if (this._threadAbortControllers.get(threadId) === abortController) {
        this._threadAbortControllers.delete(threadId);
      }
    }
  }

  /**
   * Process a user message: resolve agent, build context, run harness,
   * evaluate outcome, emit status.
   *
   * @param skipAppend — if true, the message is already in history (resume after tool confirmation)
   * @param retryCount — for transient error retries
   */
  private async processUserMessage(
    userMessage: UserMessageEvent,
    retryCount: number = 0,
    skipAppend: boolean = false,
    parentSignal?: AbortSignal,
    executionFence?: SessionExecutionFence,
  ): Promise<{ holdQueuedOnLane?: boolean } | void> {
    // Resolved up front so closures built below (delegateToAgent in
    // env / runtime blocks) can capture it. Defaults to primary —
    // POST /event handler reads the same field for thread-scoped
    // routing, so a user.message tagged sthr_X lands on this turn.
    const turnThreadId =
      (userMessage as unknown as { session_thread_id?: string })
        .session_thread_id ?? "sthr_primary";

    const agentId = this.state.agent_id;
    if (!agentId) return;
    const activeFence = executionFence ?? this._executionFences.get(turnThreadId);
    let holdQueuedOnLane = false;

    const agent = await this.getThreadAgentConfig(turnThreadId);
    if (!agent) {
      const history = this.guardHistoryForExecution(
        this.openHistory(),
        activeFence,
      );
      const errorEvent: SessionEvent = { type: "session.error", error: "Agent not found" };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);
      // Status auto-derives — no setState needed
      return;
    }

    const history = this.guardHistoryForExecution(
      this.openHistory(),
      activeFence,
    );

    // Status-pair invariant: every status_running emit (line ~3889
    // below) MUST be followed by exactly one status_idle emit before
    // this function returns. The success path emits at line ~4067; the
    // error paths historically didn't, leaving Console showing
    // "Running" forever even after adapter.endTurn flipped the D1 row
    // to 'idle' (Console derives the pill from SSE events, not D1
    // polling). Tracked via this flag — finally emits if no earlier
    // path did.
    let idleEmitted = false;
    let managedMemorySynchronized = false;
    // A successful turn knows its precise stop reason before tool disposal,
    // but `status_idle` is the externally visible lifecycle boundary. Hold
    // the event until every turn-scoped tool (including remote MCP sessions)
    // has finished closing so clients cannot observe idle while resources are
    // still live.
    let completedIdleEvent: SessionEvent | undefined;

    // Reuse session-level sandbox (singleton) — files persist across turns.
    // Returned object is a lazy proxy. Warmup starts concurrently with the
    // control-plane reads below, then is awaited before tools/harness are
    // built so declared resources are present on the first model request.
    let sandbox = this.bindSandboxToExecution(
      await this.getOrCreateSandbox(),
      parentSignal,
      activeFence,
      turnThreadId,
    );

    // Kick off warmup so it overlaps with the rest of pre-streamText setup
    // Result is cached on sandboxWarmupPromise and awaited below before any
    // tool or model can observe the runtime. Catch detached here only avoids
    // an unhandled rejection during the overlap window; the later await
    // propagates the same error into the turn lifecycle.
    void this.warmUpSandbox().catch(() => { /* surfaces via tool exec */ });

    // Fetch environment config for networking restrictions
    const envId = this.state.environment_id;
    let environmentConfig: { networking?: { type: string; allowed_hosts?: string[] } } | undefined;
    if (envId) {
      const envCfg = await this.getEnvConfig(envId);
      if (envCfg) {
        environmentConfig = envCfg.config;
      }
    }

    // Fetch memory store attachments from session resources
    const sessionId = this.state.session_id;
    const memoryAttachments: Array<{
      store_id: string;
      access: "read_write" | "read_only";
      instructions?: string;
    }> = [];
    let sessionResourceRows: Awaited<
      ReturnType<Awaited<ReturnType<typeof getCfServicesForTenant>>["sessions"]["listResourcesBySession"]>
    > = [];
    if (sessionId) {
      // listResourcesBySession queries the session_id column directly — no
      // tenant-prefix mismatch, no JSON.parse loop. Replaces the prior
      // CONFIG_KV.list scan that tripped over staging KV namespaces.
      const services = await getCfServicesForTenant(this.env, this.state.tenant_id);
      sessionResourceRows = await services.sessions.listResourcesBySession({ sessionId });
      for (const row of sessionResourceRows) {
        if (row.type === "memory_store" && row.resource.type === "memory_store" && row.resource.memory_store_id) {
          memoryAttachments.push({
            store_id: row.resource.memory_store_id,
            access: row.resource.access === "read_only" ? "read_only" : "read_write",
            // Accept Anthropic-aligned `instructions` going forward.
            instructions:
              typeof (row.resource as { instructions?: unknown }).instructions === "string"
                ? ((row.resource as { instructions: string }).instructions)
                : undefined,
          });
        }
      }
    }
    const memoryStoreIds = memoryAttachments.map((a) => a.store_id);

    // Warmup may overlap the preceding control-plane reads, but it must
    // finish before harness/tool construction. This closes the first-turn
    // race where files, repositories or skills were absent from the model's
    // initial capability snapshot and only appeared on a later sandbox call.
    await this.warmUpSandbox();

    // Resolve harness via registry — SessionDO never imports a concrete harness
    let harness: HarnessInterface;
    let resolvedHarnessName = agent.harness || "default";
    try {
      harness = await this._primaryHarness.resolve(
        `${agent.id}:${agent.version}:${resolvedHarnessName}`,
        resolvedHarnessName,
      );
    } catch (err) {
      logWarn(
        { op: "session_do.harness_resolve", session_id: this.state.session_id, agent_id: agent.id, requested: agent.harness, err },
        "agent harness unknown; falling back to default",
      );
      resolvedHarnessName = "default";
      harness = await this._primaryHarness.resolve(
        `${agent.id}:${agent.version}:${resolvedHarnessName}`,
        resolvedHarnessName,
      );
    }

    // --- Platform prepares WHAT is available ---

    // Create the local abort controller before building tools. Preparation
    // itself can perform sandbox writes (for example MCP startup), so bind
    // those calls to the same parent execution fence as the model loop.
    this._interruptIdleOwned.delete(turnThreadId);
    const abortController = new AbortController();
    let resolveTurnSettled!: () => void;
    this._turnSettled.set(abortController, new Promise<void>((resolve) => { resolveTurnSettled = resolve; }));
    this._threadAbortControllers.set(turnThreadId, abortController);
    const unlinkParentAbort = linkAbort(parentSignal, abortController);
    const effectiveAbortSignal = abortController.signal;
    sandbox = this.bindSandboxToExecution(
      sandbox,
      effectiveAbortSignal,
      activeFence,
      turnThreadId,
    );

    // Resolve model — `agent.model` is a card.model_id handle. The card
    // contains the wire-level LLM string we actually send to the provider.
    // Resolved before tools so delegation tools carry this session's own
    // model-card credentials rather than any platform key.
    const effectiveHandle = this.agentModelHandle(agent);
    const creds = await this.resolveModelCardCredentials(effectiveHandle);

    // Build tools from agent config
    const auxResolved = await this.resolveAuxModel(agent);
    const allTools = await buildTools(agent, sandbox, {
      ...delegationCredentials(creds),
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      toMarkdown: cfWorkersAiToMarkdown(this.env.AI),
      environmentConfig,
      mcpBinding: this.env.MAIN_MCP,
      tenantId: this.state.tenant_id,
      sessionId: this.state.session_id,
      browser: this.getBrowserHarness() ?? undefined,
      auxModel: auxResolved?.model,
      auxModelInfo: auxResolved?.modelInfo,
      auxProviderOptions: auxResolved?.providerOptions,
      broadcastEvent: (event) => this.persistAndBroadcastEvent(event, turnThreadId, activeFence),
      scheduleWakeup: (a) => this.scheduleWakeup(a),
      cancelWakeup: (id) => this.cancelWakeup(id),
      listWakeups: () => this.listWakeups(),
      delegateToAgent: async (agentId: string, message: string) => {
        // turnThreadId is captured from the enclosing processUserMessage
        // scope (declared at the top of the function) — closure evals
        // lazily at harness.run time, so TDZ isn't a concern.
        return this.runSubAgent(agentId, message, history, sandbox, turnThreadId, effectiveAbortSignal);
      },
      watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
        this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
      },
    });

    // Memory store mounts: per the Anthropic Managed Agents Memory contract,
    // each attached store appears as /mnt/memory/<store_name>/ inside the
    // sandbox. The agent reads/writes via the standard file tools (no
    // bespoke memory_* tools). The mount itself is set up further down in
    // the resource-mounter call. We only need MemoryStoreService here to
    // resolve store metadata for the system-prompt reminder block.
    let memoryStoreService: MemoryStoreService | null = null;
    if (memoryAttachments.length && this.env.MAIN_DB) {
      memoryStoreService = (await getCfServicesForTenant(this.env, this.state.tenant_id)).memory;
    }

    const piRuntime = createPiModelRuntime({
      model: creds.model,
      apiKey: creds.apiKey,
      provider: creds.provider,
      baseURL: creds.baseURL,
      customHeaders: creds.customHeaders,
      piConfig: creds.piConfig,
      providerOptions:
        typeof agent.model !== "string" &&
        agent.model.provider_options?.pi &&
        typeof agent.model.provider_options.pi === "object" &&
        !Array.isArray(agent.model.provider_options.pi)
          ? agent.model.provider_options.pi as Record<string, unknown>
          : undefined,
      thinkingLevel: typeof agent.model === "string" ? undefined : agent.model.effort,
      speed: typeof agent.model === "string" ? undefined : agent.model.speed,
    });
    const model = toAiSdkLanguageModel(piRuntime);

    // Build system prompt: agent.system + platform guidance + skill /
    // memory_store / appendable_prompt content (the latter passed in as
    // platformReminders, see collection below). Shared with the self-host
    // Node path via @open-managed-agents/agent/harness/platform-guidance
    // so the two surfaces stay byte-identical (prompt-cache prefix
    // invariant). Pre-2026-05-17: skill/memory content was broadcast as
    // <system-reminder> user.message events by harness.onSessionInit;
    // operators correctly pointed out that static-per-session context
    // belongs in the system prompt where Claude already knows to treat
    // it as such, and so it doesn't clutter the visible conversation
    // feed. composeSystemPrompt now takes the reminders directly; the
    // default-loop's onSessionInit is a no-op for the same reason.
    const rawSystemPrompt = agent.system || "";

    // Collect platformReminders first so composeSystemPrompt can inline
    // them. (Kept on the HarnessContext too for custom harnesses that
    // want to handle them differently — e.g. RAG harness might want to
    // resolve a query before injecting.)
    const platformReminders: Array<{ source: string; text: string }> = [];
    const skillMounts: SkillMountDescriptor[] = [];
    const assemblySkillMount = agentUsesAssemblySkillMount(agent);
    const skillAssemblyConfig = assemblySkillMount ? resolveSkillAssemblyConfig(agent) : undefined;
    const fetchSkillBodies = skillAssemblyConfig
      ? skillMountsShouldFetchBodies(skillAssemblyConfig.mode)
      : false;

    // Platform-built-in appendable prompts the agent author opted into. Use
    // for provider-specific syntax (e.g. Linear's @-mention URL form) that
    // would pollute the base system prompt for agents that don't need it.
    // Routed through platformReminders so they participate in the new
    // harness.onSessionInit cache-stable injection model.
    const appendableIds = agent.appendable_prompts ?? [];
    const resolved = appendableIds.length ? resolveAppendablePrompts(appendableIds) : [];
    if (resolved.length) {
      console.log(
        `[session-do] appendable_prompts ids=[${appendableIds.join(",")}] resolved=${resolved.length}`,
      );
      for (const p of resolved) {
        platformReminders.push({ source: `appendable:${p.id}`, text: p.content });
      }
    }
    if (agent.skills?.length) {
      // Built-in (anthropic) skills from the in-memory registry
      const builtinSkills = resolveSkills(agent.skills);
      for (const s of builtinSkills) {
        if (assemblySkillMount) {
          skillMounts.push({
            skillId: s.id,
            name: s.name,
            description: s.name,
            mountRoot: `/home/user/.skills/${s.name}/`,
            body: s.system_prompt_addition,
            source: "builtin",
          });
        } else if (s.system_prompt_addition) {
          platformReminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
        }
      }

      // Legacy prompt assembly is used only without the managed skill source.
      if (this.env.CONFIG_KV && !this.env.MAIN_MCP?.resolveManagedSkillVersion) {
        try {
          if (assemblySkillMount) {
            const customMounts = await resolveCustomSkillMounts(
              agent.skills,
              this.env.CONFIG_KV,
              this.env.FILES_BUCKET,
              this.state.tenant_id,
              { fetchBodies: fetchSkillBodies },
            );
            skillMounts.push(...customMounts);
          } else {
            const customSkills = await resolveCustomSkills(
              agent.skills,
              this.env.CONFIG_KV,
              this.env.FILES_BUCKET,
              this.state.tenant_id,
            );
            for (const s of customSkills) {
              if (s.system_prompt_addition) {
                platformReminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
              }
            }
          }
        } catch (err) {
          // Best-effort
          logWarn(
            { op: "session_do.custom_skills.resolve", session_id: this.state.session_id, agent_id: agent.id, err },
            "custom skill resolve failed; skipping skill prompt additions",
          );
        }
      }

      // Mount custom skill files into sandbox (progressive disclosure).
      // Unrelated to systemPrompt — keeps the sandbox-side files for the
      // model to read on demand via skill tools.
      {
        try {
          const managedSkillBinding = this.env.MAIN_MCP;
          const skillFilesResults = await resolveRuntimeSkillFiles(agent,
            managedSkillBinding?.resolveManagedSkillVersion
              ? { resolveManagedSkillVersion: input => managedSkillBinding.resolveManagedSkillVersion!({ tenantId: this.state.tenant_id, ...input }) }
              : undefined,
            this.env.CONFIG_KV ? () => getSkillFiles(agent.skills ?? [], this.env.CONFIG_KV!, this.env.FILES_BUCKET, this.state.tenant_id) : undefined,
          );
          if (managedSkillBinding?.resolveManagedSkillVersion) {
            platformReminders.push(...await resolveSubagentSkillReminders({ ...agent, skills: [] }, undefined, skillFilesResults));
          }
          // The canonical location is shared with Node and ACP Managed
          // Runtimes. A compatibility mirror keeps historical prompts valid.
          // Requested skills are required inputs, so a failed write aborts
          // warmup instead of silently starting a weaker agent.
          await mountSkillFiles(sandbox, skillFilesResults);
        } catch (err) {
          logWarn(
            { op: "session_do.skill_files.mount", session_id: this.state.session_id, agent_id: agent.id, err },
            "skill files mount failed",
          );
          throw err;
        }
      }
    }

    // Memory store prompts → platformReminders (was: appended to systemPrompt
    // every turn, KV-list-order dependent → permanent cache miss). Build the
    // prompt strings on the fly from memory store metadata + per-attachment
    // instructions overrides. Format mirrors Anthropic's auto-injected mount
    // descriptors: `/mnt/memory/<name>/ (access)` so the agent knows where to
    // find the store and uses standard file tools to interact.
    const memoryPrompts: string[] = [];
    if (memoryAttachments.length && memoryStoreService) {
      try {
        for (const att of memoryAttachments) {
          const store = await memoryStoreService.getStore({
            tenantId: this.state.tenant_id,
            storeId: att.store_id,
          });
          if (!store) {
            memoryPrompts.push("");
            continue;
          }
          const accessLabel = att.access === "read_only" ? "read-only" : "read-write";
          const lines = [
            `## Memory store: ${store.name}`,
            `Mounted at /mnt/memory/${store.name}/ (${accessLabel})`,
          ];
          if (store.description) lines.push(store.description);
          if (att.instructions) lines.push(att.instructions);
          if (att.access === "read_only") {
            lines.push("(read-only mount — write attempts to this directory will fail)");
          }
          memoryPrompts.push(lines.join("\n"));
        }
      } catch (err) {
        console.warn("memory store metadata fetch failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (let i = 0; i < memoryPrompts.length; i++) {
      if (!memoryPrompts[i]) continue;
      platformReminders.push({
        source: `memory:${memoryStoreIds[i] ?? `idx${i}`}`,
        text: memoryPrompts[i],
      });
    }

    // Build the final system prompt: agent.system + platform guidance +
    // every platformReminder wrapped in a <source name="...">…</source>
    // block. Done HERE (after all reminder collection) so the prompt
    // includes every skill / memory_prompt / appendable_prompt we
    // discovered, and so the byte sequence is stable across the cache
    // prefix (turn N + 1 reuses the same prompt as turn N).
    const systemPrompt = composeSystemPrompt(rawSystemPrompt, platformReminders);

    const acpSessionStartCwd = agent.runtime_binding
      ? resolveRepositoryLocalPath(
          sessionResourceRows.map((row) => ({
            type: row.type,
            resource: row.resource as unknown as Record<string, unknown>,
          })),
        )
      : undefined;

    // --- Harness receives a fully-prepared context ---
    const ctx: HarnessContext = {
      agent,
      budget: await this.resolveBudgetGate(effectiveHandle),
      userMessage,
      session_id: this.state.session_id,
      tenant_id: this.state.tenant_id,
      ...(acpSessionStartCwd ? { acpSessionStartCwd } : {}),
      // RunnerRelayPort over the cross-script RuntimeRoom DO binding, so
      // AcpProxyHarness attaches to the user's runner directly (no HTTP hop
      // through main). Non-acp harnesses don't read it.
      runnerRelay: createRuntimeRoomRelay(this.env.RUNTIME_ROOM),
      tools: allTools,
      model,
      pi: piRuntime,
      systemPrompt,
      rawSystemPrompt,
      platformReminders,
      ...(skillMounts.length > 0 ? { skillMounts } : {}),
      // file_id → bytes resolver for ImageBlock/DocumentBlock content blocks
      // whose `source.type === "file"`. Default-loop's eventsToMessagesAsync
      // dedupes via a per-derive Promise cache, so the same file referenced
      // across multiple turns of one projection only hits R2 once. Null
      // returns are treated as "unavailable" — the derive layer emits a
      // placeholder text part instead of crashing the turn.
      fileFetcher: this.buildFileFetcher(this.state.tenant_id),
      env: {
        ...delegationCredentials(creds),
        ANTHROPIC_MODEL: this.env.ANTHROPIC_MODEL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        CONFIG_KV: this.env.CONFIG_KV,
        memoryStoreIds,
        environmentConfig,
        // LLM full-body logging context. default-loop wraps each model
        // call in middleware that PUTs request + response to R2 keyed
        // by the per-step span event id. The matching
        // span.model_request_end event grows a body_r2_key field
        // pointing to the same key. r2 = null disables capture
        // (test harnesses, env without FILES_BUCKET).
        ...(this.env.LLM_LOGS_DISABLED === "1"
          ? {}
          : {
              llmLog: {
                tenant_id: this.state.tenant_id,
                session_id: this.state.session_id,
                r2: this.env.FILES_BUCKET ?? null,
              },
            }),
        delegateToAgent: async (agentId: string, message: string) => {
          return this.runSubAgent(agentId, message, history, sandbox, turnThreadId, effectiveAbortSignal);
        },
        watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
          this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
        },
      },
      runtime: {
        history,
        sandbox,
        ...(agentAdvertisesSteering(agent)
          ? { takeSteeringInputs: () => this.takeSteeringInputs(turnThreadId) }
          : {}),
        broadcast: (event) => {
          history.append(event);
          this.broadcastEvent(event, activeFence);
          this.fanOutToHooks(event);
          const cacheUsage = reportModelSpanUsage(this.usageMeter, turnThreadId, event, this.activeBudgetGate);
          if (cacheUsage !== null) this.publishSessionUsage(cacheUsage, history, activeFence);
        },
        ...this.buildStreamRuntimeMethods(turnThreadId, activeFence),
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          this.publishSessionUsage(
            reportSessionUsage(this.usageMeter, turnThreadId, { input_tokens, output_tokens }, this.activeBudgetGate),
            history, activeFence,
          );
        },
        pendingConfirmations: [],
        consumePendingConfirmation: (requestId) => {
          if (activeFence !== undefined && !this.isExecutionFenceCurrent(activeFence)) {
            const error = new Error("session execution fence is no longer valid");
            error.name = "ExecutionFenceLostError";
            throw error;
          }
          this.setState({ ...this.state, pending_tool_calls: this.state.pending_tool_calls.filter((pending) => pending.toolCallId !== requestId) });
        },
        abortSignal: effectiveAbortSignal,
        keepAliveWhile: <T>(fn: () => Promise<T>) => fn(),
      },
    };

    try {
      // Run harness.onSessionInit exactly once per session, BEFORE the first
      // running status. Default impl writes <system-reminder> user.message
      // events for skills/memory/appendable_prompts; custom harnesses can
      // substitute or skip. Idempotent across DO restarts via state flag.
      if (!this.state.session_init_done && harness.onSessionInit) {
        try {
          await harness.onSessionInit(ctx, ctx.runtime);
        } catch (err) {
          console.warn(`[onSessionInit] failed: ${(err as Error).message}`);
        }
        this.setState({ ...this.state, session_init_done: true });
      }

      // Interrupt-vs-wake race: a tool answer admitted just before a
      // user.interrupt may still start this turn after the interrupt already
      // closed its calls and emitted idle end_turn. Official CMA: the
      // interrupt ends the turn; only a new user.message resumes. So if the
      // newest user input on this thread is the interrupt, do not sample.
      // https://platform.claude.com/docs/en/managed-agents/events-and-streaming
      {
        let lastUserType: string | undefined;
        for (const e of history.getEvents()) {
          if (((e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary") !== turnThreadId) continue;
          if (e.type === "user.interrupt" || e.type === "user.message" ||
              e.type === "user.tool_confirmation" || e.type === "user.custom_tool_result") lastUserType = e.type;
        }
        if (lastUserType === "user.interrupt") {
          this._interruptIdleOwned.add(turnThreadId);
          abortController.abort();
          return;
        }
      }

      // Durable keep-alive BEFORE the first model request. The outbox drain
      // arms this too, but the legacy local-queue path only has the
      // fire-and-forget hint callback; awaiting here guarantees the alarm
      // exists when harness.run() starts regardless of which path got here.
      await this._armLeaseWake("model_request");

      // Broadcast running status
      const runningEvent: SessionEvent = { type: "session.status_running" };
      history.append(runningEvent);
      this.broadcastEvent(runningEvent, activeFence);

      await harness.run(ctx);

      // A parked call can already be closed by the time the run returns
      // (steer/interrupt closed it with a tool_result, or the client answered
      // during the batch). Announcing it as requires_action would park the
      // session on a call whose late answer is no-effect, leaving queued
      // user.messages unprocessed forever (#398 two_clients FOREVER_NULL).
      if (ctx.runtime.pendingConfirmations?.length) {
        const answered = new Set<string>();
        for (const e of history.getEvents()) {
          if (e.type === "agent.tool_result") {
            const id = (e as unknown as { tool_use_id?: string }).tool_use_id;
            if (id) answered.add(id);
          }
        }
        ctx.runtime.pendingConfirmations = ctx.runtime.pendingConfirmations.filter((id) => !answered.has(id));
      }

      // Store any pending tool calls in session metadata for confirmation flow
      if (ctx.runtime.pendingConfirmations?.length) {
        // Collect pending tool call details from the last harness run events
        const recentEvents = history.getEvents();
        const pendingCalls: PendingToolCall[] = [];
        for (const eventId of ctx.runtime.pendingConfirmations) {
          // Find the matching agent.tool_use or agent.custom_tool_use event
          const toolUseEvent = recentEvents.find((e: SessionEvent) => {
            if (e.type === "agent.tool_use") {
              return (e as AgentToolUseEvent).id === eventId;
            }
            if (e.type === "agent.custom_tool_use") {
              return (e as import("@open-managed-agents/shared").AgentCustomToolUseEvent).id === eventId;
            }
            return false;
          });
          if (toolUseEvent) {
            if (toolUseEvent.type === "agent.tool_use") {
              const tue = toolUseEvent as AgentToolUseEvent;
              pendingCalls.push({ toolCallId: tue.id, toolName: tue.name, args: tue.input });
            } else if (toolUseEvent.type === "agent.custom_tool_use") {
              const cte = toolUseEvent as import("@open-managed-agents/shared").AgentCustomToolUseEvent;
              pendingCalls.push({ toolCallId: cte.id, toolName: cte.name, args: cte.input });
            }
          }
        }
        if (pendingCalls.length) {
          this.setState({ ...this.state, pending_tool_calls: pendingCalls });
        }
      } else if ((this.state.pending_tool_calls?.length ?? 0) > 0) {
        // The run finished without parking on a client action, so nothing is
        // outstanding. A stale list would hold queued user.messages behind
        // continuationsOnly claims forever.
        this.setState({ ...this.state, pending_tool_calls: [] });
      }

      // Outcome self-evaluation loop. Phase 4 / AMA-aligned: delegated
      // to the standalone supervisor module which builds a Verifier
      // (verifierForSpec for the OMA-superset rule-based path,
      // LlmJudgeVerifier for the AMA-default LLM-judge path), runs it
      // against a Trajectory built from the current event log, maps the
      // Score onto the AMA 5-result enum, emits
      // span.outcome_evaluation_{start,ongoing,end}, and persists each
      // terminal verdict to state.outcome_evaluations[]. The loop
      // re-injects the verifier's `reason` as a user.message + re-runs
      // the harness on `needs_revision`.
      const outcome = this.state.outcome;
      if (outcome) {
        const outcomeModelId =
          typeof agent.model === "string" ? agent.model : agent.model?.id;
        const judgeModel = ctx.model;
        try {
          await runOutcomeSupervisor({
            outcome,
            initialIteration: this.state.outcome_iteration ?? 0,
            tenantId: this.state.tenant_id,
            filesBucket: this.env.FILES_BUCKET ?? null,
            abortSignal: effectiveAbortSignal,
            judgeModelId: outcomeModelId,
            getEvents: () => history.getEvents(),
            appendAndBroadcast: (event) => {
              history.append(event);
              this.broadcastEvent(event, activeFence);
            },
            persistState: (delta) => {
              const next = { ...this.state };
              if ("outcome" in delta) next.outcome = delta.outcome ?? null;
              if (typeof delta.outcome_iteration === "number") {
                next.outcome_iteration = delta.outcome_iteration;
              }
              if (delta.outcome_evaluations) {
                next.outcome_evaluations = delta.outcome_evaluations;
              }
              this.setState(next);
            },
            readEvaluations: () => this.state.outcome_evaluations ?? [],
            makeVerifierContext: () => ({
              sessionId: this.state.session_id,
              runExec: async (cmd, opts) => {
                const sb = await this.getOrCreateSandbox();
                const raw = await sb.exec(cmd, opts?.timeoutMs ?? 600_000);
                // sandbox.exec returns "exit=N\n<merged-output>"
                const m = raw.match(/^exit=(-?\d+)\n([\s\S]*)$/);
                return m
                  ? { exit_code: parseInt(m[1], 10), output: m[2] }
                  : { exit_code: -1, output: raw };
              },
            }),
            makeJudgeFn: () => async (prompt, signal) => {
              const result = await generateText({
                model: judgeModel,
                system: prompt.system,
                messages: [{ role: "user", content: prompt.user }],
                maxOutputTokens: 800,
                abortSignal: signal,
              });
              const text =
                result.text ||
                extractTextFromContent(
                  (result as unknown as { content?: unknown }).content,
                );
              const u = (result as unknown as {
                usage?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  cachedInputTokens?: number;
                  cacheReadInputTokens?: number;
                  cacheCreationInputTokens?: number;
                };
              }).usage;
              const usage = u
                ? {
                    input_tokens: u.inputTokens ?? 0,
                    output_tokens: u.outputTokens ?? 0,
                    cache_creation_input_tokens:
                      u.cacheCreationInputTokens ?? u.cachedInputTokens,
                    cache_read_input_tokens: u.cacheReadInputTokens,
                  }
                : undefined;
              return { text, usage };
            },
            runHarnessTurn: async (msg) => {
              await harness.run({ ...ctx, userMessage: msg });
            },
          });
        } catch (err) {
          // Supervisor itself blew up (e.g. a persistState callback
          // threw). Surface as a session warning — the supervisor's own
          // failure path already handled verifier-internal errors and
          // emitted a `failed` end span.
          logWarn(
            { op: "outcome.supervisor", session_id: this.state.session_id, err },
            "outcome supervisor crashed",
          );
        }
      }

      // Execution end before the Memory barrier: egress revoked, then a copy
      // sync publishes the sandbox's Memory edits. A failed publish fails the step.
      if (this.portsSandbox !== null) await this.portsSandbox.endExecution();
      // Memory mutations are part of turn completion, not an asynchronous
      // afterthought. This barrier precedes status_idle and execution settle.
      await this.synchronizeManagedMemoryStores(activeFence);
      managedMemorySynchronized = true;

      // Determine stop reason based on pending tool confirmations or custom tool results
      const pendingConfirmations = ctx.runtime.pendingConfirmations || [];

      // Check if any pending are custom tool uses (no execute function, not always_ask built-in)
      const storedPendingCalls = this.state.pending_tool_calls;
      const hasCustomToolPending = storedPendingCalls.some((p) => {
        // A call proxied through mcp_invoke awaits confirmation of its target.
        const toolName = resolveProxiedToolCall(p.toolName, p.args).toolName;
        return !["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"].includes(toolName) &&
          !toolName.startsWith("mcp_") &&
          !toolName.startsWith("call_agent_") &&
          !toolName.startsWith("memory_");
      });

      let stopReason: import("@open-managed-agents/shared").SessionStatusEvent["stop_reason"];
      if (hasCustomToolPending) {
        stopReason = {
          type: "requires_action" as const,
          action_type: "custom_tool_result" as const,
          event_ids: pendingConfirmations,
        };
      } else if (pendingConfirmations.length > 0) {
        stopReason = {
          type: "requires_action" as const,
          action_type: "tool_confirmation" as const,
          event_ids: pendingConfirmations,
        };
      } else if (ctx.budget?.reached) {
        // Official budget stop (requires_action outranks it, above):
        // thread idle → usage snapshot → session idle (emitted below).
        // Usage source on CF: every model span in this session's event log.
        const [threadIdle, usageEvent] = budgetReachedStopEvents({
          agentName: agent.name,
          sessionThreadId: turnThreadId,
          usage: sessionUsageSnapshot(
            sumModelSpanUsage(history.getEvents()),
            ctx.budget,
          ),
          budget: ctx.budget.maxListCost,
        });
        for (const applicationEvent of [threadIdle, usageEvent]) {
          const event = encodeRuntimeHistoryEvent(applicationEvent as never) as unknown as SessionEvent;
          history.append(event);
          this.broadcastEvent(event, activeFence);
        }
        stopReason = { type: "budget_reached" } as unknown as typeof stopReason;
      } else {
        stopReason = { type: "end_turn" as const };
      }

      const idleEvent: SessionEvent = {
        type: "session.status_idle",
        stop_reason: stopReason,
      };
      completedIdleEvent = idleEvent;
    } catch (err) {
      const errorMessage = this.describeError(err);

      // A lost execution fence is an expected cancellation, not a model or
      // infrastructure failure.  The lease owner may have been replaced by
      // another worker; retrying here would let the stale worker race the new
      // owner and would also try to append a second error/idle pair through
      // the fenced history wrapper.  Treat the sandbox guard's equivalent
      // error the same way as an AbortError.
      // A lost execution fence is an expected cancellation, not a model or
      // infrastructure failure.  The lease owner may have been replaced by
      // another worker; retrying here would let the stale worker race the new
      // owner and would also try to append a second error/idle pair through
      // the fenced history wrapper.  Treat the sandbox guard's equivalent
      // error the same way as an AbortError.
      if (isTurnCancellationError(err)) {
        // Interrupt handler (POST /event user.interrupt branch) already
        // appended its own session.status_idle synchronously before
        // the abort propagated, so the finally block must NOT emit a
        // second one — this flag suppresses the duplicate.
        idleEmitted = true;
        return;
      }

      // Retry-by-default policy. Specific fatal classes short-circuit;
      // everything else (including unclassified errors) re-runs once
      // before surfacing. The previous shape was a TRANSIENT allowlist
      // of substrings ("timeout", "ECONNREFUSED"...); every new transient
      // class (CF "version rollout", container OOM, future infra wording)
      // silently fell off the list and the user saw a hard failure.
      //
      // Boundary wrappers (wrapSandboxWithLazyWarmup, the streamText
      // boundary, ) re-throw native errors as
      // typed OmaErrors via classifyExternalError, so most well-known
      // fatal conditions arrive here as the right class already.
      // For errors that escaped the boundaries (D1, KV, future SDKs),
      // run classifyExternalError once more inline as belt-and-braces.
      const classified = classifyExternalError(err);
      // Session-terminal classes: retry_status terminal + terminate().
      // ModelError is turn-dead only (exhausted + retries_exhausted): same
      // prompt fails again, but the session stays usable for a new prompt.
      // Caught 2026-05-11 sess-y2bfxm1de4e1zqxm: retries burned tokens.
      const isSessionTerminal =
        classified instanceof PaymentRequiredError ||
        classified instanceof ConfigError ||
        classified instanceof AuthError;
      const isModelTurnDead = classified instanceof ModelError;
      const plan = planTurnFailure({
        cancelled: false,
        failureClass: isSessionTerminal ? "session_terminal" : isModelTurnDead ? "turn_dead" : "transient",
        attempt: retryCount + 1,
        maxAttempts: 3,
        // Exponential backoff: 1s, 2s
        delayMs: (attempt) => 1000 * Math.pow(2, attempt - 1),
      });

      // Official CMA ordering: session.error{retrying} then status_rescheduled.
      reportTurnFailure(plan, errorMessage, {
        sessionError: (message, retry_status) => {
          const event = {
            type: "session.error",
            error: { type: "unknown_error", message, retry_status },
          } as SessionEvent;
          history.append(event);
          this.broadcastEvent(event, activeFence);
        },
        rescheduled: (reason) => {
          const event: SessionEvent = { type: "session.status_rescheduled", reason };
          history.append(event);
          this.broadcastEvent(event, activeFence);
        },
      });

      if (plan.type === "retry") {
        // Retry hold (cma-steer-coherent-turn.md): do not flush unstamped
        // mid-turn inputs and do not start a new agent turn from them.
        // Leave them until the next consume boundary after this resume;
        // takeSteeringInputs then ingests them into the continuing turn.
        await new Promise(r => setTimeout(r, plan.delayMs));
        // Recursive call owns the next idle emit (success or its own
        // finally). Suppress this frame's catch-all so we don't get
        // two status_idle events on a successful retry.
        idleEmitted = true;
        return this.processUserMessage(
          userMessage,
          retryCount + 1,
          skipAppend,
          parentSignal,
          activeFence,
        );
      }

      if (plan.type === "exhausted") {
        // Official CMA exhausted: session.error{exhausted} then idle
        // retries_exhausted. No status_rescheduled on the final failure.
        // Owner lock: retain mid-run queued inputs (holdQueuedOnLane), do not
        // flush/delete (deliberate divergence from SDK "flushed").
        holdQueuedOnLane = true;
        completedIdleEvent = {
          type: "session.status_idle",
          stop_reason: { type: "retries_exhausted" },
        };
      } else if (plan.type === "terminal") {
        // Official CMA: retry_status terminal → session transitions to terminated.
        this.terminate(
          classified instanceof PaymentRequiredError ? "payment_required"
            : classified instanceof AuthError ? "auth"
              : classified instanceof ConfigError ? "config"
                : "fatal_error",
        );
        // terminate() emits status_terminated; suppress catch-all idle.
        idleEmitted = true;
      }
    } finally {
      await disposeTools(allTools);
      if (!managedMemorySynchronized) {
        try {
          // Error/cancel rescue pass. Reconciliation is idempotent, so a
          // partially committed prior attempt is safe to retry here.
          await this.synchronizeManagedMemoryStores(activeFence);
          managedMemorySynchronized = true;
        } catch (error) {
          if (!(error instanceof Error && error.name === "ExecutionFenceLostError")) {
            logWarn(
              {
                op: "session_do.memory_sync.rescue",
                session_id: this.state.session_id,
                error: error instanceof Error ? error.message : String(error),
              },
              "writable Managed Memory rescue sync failed",
            );
          }
        }
      }
      // Only delete if it's still ours — a sub-agent run within the same
      // thread may have temporarily replaced it. Same-thread re-entry is
      // mutex'd by _draining so this is theoretical safety only.
      if (this._threadAbortControllers.get(turnThreadId) === abortController) {
        this._threadAbortControllers.delete(turnThreadId);
      }
      this._turnSettled.delete(abortController);
      resolveTurnSettled();
      unlinkParentAbort();
      // Emit status_idle only after turn-scoped resources have settled. On a
      // successful turn this preserves its precise stop_reason; error paths
      // use the generic event because they have no meaningful stop reason.
      // This also pairs with status_running so Console never remains stuck at
      // "Running" after a model/tool failure.
      // A user.interrupt already emitted this turn's status_idle; emitting
      // the catch-all one too produced two idles per interrupt.
      const interruptOwnsIdle = abortController.signal.aborted &&
        this._interruptIdleOwned.delete(turnThreadId);
      if (interruptOwnsIdle) this.closeToolUsesAfterInterrupt(history, activeFence, turnThreadId);
      if (!idleEmitted && !interruptOwnsIdle) {
        try {
          const idleEvent: SessionEvent = completedIdleEvent ?? { type: "session.status_idle", stop_reason: { type: "end_turn" } };
          history.append(idleEvent);
          this.broadcastEvent(idleEvent, activeFence);
        } catch (err) {
          console.warn(`[processUserMessage] catch-all idle emit failed:`, err);
        }
      }
      // Status auto-derives — Workspace backup is fired by
      // OmaSandbox.onActivityExpired when the container's sleepAfter
      // elapses (see oma-sandbox.ts) — exactly one snapshot per quiet
      // period. Explicit /destroy snapshots eagerly via
      // sandbox.snapshotWorkspaceNow(). Per-turn backup is intentionally off.
    }
    return holdQueuedOnLane ? { holdQueuedOnLane: true } : undefined;
  }

  /**
   * Extract a meaningful error description. Handles cases where err.message
   * is empty (e.g. network failures, non-standard API errors).
   */
  private describeError(err: unknown): string {
    if (err instanceof Error) {
      if (err.message) return err.message;
      const parts: string[] = [err.name || "Error"];
      if ("cause" in err && err.cause) parts.push(`cause: ${String(err.cause)}`);
      if ("status" in err) parts.push(`status: ${(err as Record<string, unknown>).status}`);
      if ("statusCode" in err) parts.push(`statusCode: ${(err as Record<string, unknown>).statusCode}`);
      if ("url" in err) parts.push(`url: ${(err as Record<string, unknown>).url}`);
      return parts.join(", ");
    }
    return String(err) || "Unknown error";
  }

  // ═══════════════════════════════════════════════════════════════════════
  // cf-agents replacement primitives (state, schedule, alarm). Schema +
  // algorithms inherited from cf-agents v0.11.2 so existing prod DOs
  // migrate transparently — SQL row layouts and callback-name conventions
  // match what cf-agents wrote. Phase 3 dropped runFiber/keepAlive in
  // favor of the unified RuntimeAdapter (begin/end on the shared
  // `sessions` table); orphan-turn detection in alarm() now reads
  // sessions.turn_id, not cf_agents_runs.
  // ═══════════════════════════════════════════════════════════════════════

  // ── State (cf_agents_state, single row) ────────────────────────────────

  get state(): SessionState {
    if (this._state === undefined) {
      // Defensive — constructor calls _loadStateFromSql before any user code
      // runs, so this should be impossible. If it fires, something called
      // .state before super() ran.
      throw new Error("SessionDO.state read before init");
    }
    return this._state;
  }

  /**
   * Live-derived session status. Single source of truth — replaces the old
   * mutable `state.status` field which had a race window between the
   * `setState({status:"running"})` write and the cf_agents_runs INSERT
   * inside runFiber. With derivation that race is impossible: status is
   * always consistent with whatever cf_agents_runs holds at query time.
   *
   * - `terminated_at` set → "terminated" (destroy is the only persistent
   *   state value that needs to survive restarts)
   * - any cf_agents_runs row → "running"
   * - else → "idle"
   *
   * Back-compat: if a session was written before this refactor, its
   * `state.status` may still be "terminated"; honor that as a fallback
   * gate so old sessions don't accept new events post-destroy.
   */
  deriveStatus(): "idle" | "running" | "terminated" {
    if (this._state?.terminated_at != null || this._state?.status === "terminated") {
      return "terminated";
    }
    // The unified-runtime marker for "is there an in-flight turn" lives
    // on D1's `sessions.turn_id`, which is async. _activeTurnIds is the
    // sync local mirror populated by RuntimeAdapter's onTurnInFlight /
    // onTurnEnded callbacks (turn ids minted in runAgentTurn). On cold
    // start the set is empty until the first alarm-fired
    // _checkOrphanTurns reconciles, but D1 is the source of truth so
    // orphan recovery still triggers from there.
    return this._activeTurnIds.size > 0 || this._executionActiveLanes.size > 0
      ? "running"
      : "idle";
  }

  /**
   * Drive the session to AMA's `terminated` lifecycle terminus.
   * Idempotent — second call no-ops if `terminated_at` already set.
   *
   * AMA semantics (BetaManagedAgentsSessionStatusTerminatedEvent):
   * "Indicates the session has terminated, either due to an error or
   * completion." Once terminated the session is one-way; the route layer
   * must reject POST /events with 409 going forward.
   *
   * Reasons currently emitted:
   *   - "session_deleted" — DELETE /v1/sessions/:id (destroy path)
   *   - "payment_required"— model/provider rejected request (402/403);
   *                         not recoverable without operator intervention
   *
   * Follow-up sources to wire (see AMA RetryStatusTerminal):
   *   - "mcp_auth"  — MCP server permanent-auth-failure path lives in
   *                   tools.ts / main proxy, separate from
   *                   the drainEventQueue catch
   *   - "completed" — explicit "session done" signal (no concept in
   *                   OMA today)
   */
  private terminate(reason: string): void {
    if (this._state?.terminated_at != null) return;
    this.setState({ ...this.state, terminated_at: Date.now() });
    for (const ctrl of this._threadAbortControllers.values()) {
      ctrl.abort();
    }
    this._threadAbortControllers.clear();
    // Usage metering: emit session_alive_seconds covering wall-clock
    // (created_at_ms → now) on terminate. Idempotent via
    // session_alive_billed; fire-and-forget so the terminate path can
    // proceed if the usage_events write hiccups.
    //
    // TODO: 24h cron sweep — long-running session that never terminates
    // never emits. Schedule a SessionDO alarm every 24h to slice the
    // alive-seconds window, write an interim event with the partial
    // seconds, advance the cursor (created_at_ms = now). Out of scope
    // for v1.
    void this._recordSessionAliveOnTerminate();
    const event: SessionEvent = {
      type: "session.status_terminated",
      reason,
    };
    const history = this.openHistory();
    history.append(event);
    this.broadcastEvent(event);

    // Mirror the terminus on D1 so list/get queries reflect it without
    // needing a sandbox-worker round-trip. Fire-and-forget — the DO-local
    // state above is the source of truth for the same-process gate; the
    // D1 write is for cross-process readers (Console list, cost reports,
    // recovery scans). Failure here is logged, not propagated.
    const sessionId = this.state.session_id;
    if (sessionId) {
      this.runtimeAdapter
        .terminate(sessionId, reason)
        .catch((err) => {
          console.warn(
            `[session_do] terminate writeback to D1 failed: ${(err as Error).message ?? err}`,
          );
        });
    }
  }

  /**
   * Hybrid-billing: emit one session_alive_seconds row spanning
   * created_at_ms → now. Idempotent — called from terminate() but skips
   * the write if session_alive_billed is already true (DO restart hits
   * /destroy a second time).
   */
  private async _recordSessionAliveOnTerminate(): Promise<void> {
    try {
      if (this._state?.session_alive_billed) return;
      const tenantId = this.state.tenant_id;
      const sessionId = this.state.session_id;
      const createdAt = this._state?.created_at_ms;
      if (!tenantId || !sessionId || !createdAt) return;
      const elapsedMs = Date.now() - createdAt;
      const seconds = Math.floor(elapsedMs / 1000);
      if (seconds <= 0) {
        // Mark as billed anyway so we don't keep retrying for a
        // sub-second session.
        this.setState({ ...this.state, session_alive_billed: true });
        return;
      }
      // getCfServicesForTenant resolves the per-tenant DB then builds
      // the Services container — the same path used for backup writes.
      const { getCfServicesForTenant } = await import("@open-managed-agents/services");
      const services = await getCfServicesForTenant(this.env, tenantId);
      await services.usage.recordUsage({
        tenantId,
        sessionId,
        agentId: this.state.agent_id || null,
        kind: "session_alive_seconds",
        value: seconds,
      });
      this.setState({ ...this.state, session_alive_billed: true });
      console.log(
        `[session_do] usage emit session_alive_seconds=${seconds} session=${sessionId.slice(0, 12)}`,
      );
    } catch (err) {
      console.error(
        `[session_do] _recordSessionAliveOnTerminate failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  setState(next: SessionState): void {
    this._state = next;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)`,
      STATE_ROW_ID,
      JSON.stringify(next),
    );
  }

  private _loadStateFromSql(): void {
    const rows = this.ctx.storage.sql
      .exec<{ state: string | null }>(
        `SELECT state FROM cf_agents_state WHERE id = ?`,
        STATE_ROW_ID,
      )
      .toArray();
    if (rows.length > 0 && rows[0].state) {
      try {
        this._state = JSON.parse(rows[0].state) as SessionState;
        return;
      } catch (err) {
        console.warn(
          `[session_do] failed to parse persisted state, falling back to INITIAL_SESSION_STATE: ${(err as Error).message}`,
        );
      }
    }
    // First boot, or corrupted — seed with INITIAL_SESSION_STATE and persist.
    this._state = { ...INITIAL_SESSION_STATE };
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)`,
      STATE_ROW_ID,
      JSON.stringify(this._state),
    );
  }

  // ── Schema bootstrap (cf_agents_state / cf_agents_schedules) ──

  private _ensureCfAgentsSchema(): void {
    // Idempotent. Schema lifted verbatim from cf-agents v0.11.2 so existing
    // prod rows survive the base-class swap. We don't bother with the
    // schema-version migration logic from cf-agents (CURRENT_SCHEMA_VERSION
    // tracking) because we're at the latest schema and only do create-IF-NOT-EXISTS.
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL,
        callback TEXT,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        intervalSeconds INTEGER,
        running INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        execution_started_at INTEGER,
        retry_options TEXT
      )
    `);
    // cf_agents_runs is gone. Phase 3 stopped writing it; Phase 4 (this
    // commit) drops the table entirely on every cold-start, idempotent
    // because DROP TABLE IF EXISTS. Old prod DOs that booted the
    // previous code still had it; first cold-start under this code path
    // sweeps it. Any in-flight rows from before the deploy are
    // recovered via _checkOrphanTurns which now reads `sessions.turn_id`
    // (populated by the unified RuntimeAdapter.beginTurn). For sessions
    // that started under the old fiber path AND were mid-turn at deploy
    // time, the turn_id column is null — those sessions just silently
    // flip to "user must resend" which is the same UX as the old
    // 5-recovery cap exhausting.
    sql.exec(`DROP TABLE IF EXISTS cf_agents_runs`);
    // Stale-row cleanup: the alarm-based stall detector was removed in the
    // Gap 10 simplification, but live prod DOs still have its interval
    // schedule rows. Each alarm tick now logs "callback not found" and
    // force-resets the row, then re-fires — pure noise that masks real
    // errors in observability. One-shot delete clears it.
    sql.exec(`DELETE FROM cf_agents_schedules WHERE callback = '_oma_stallCheckHeartbeat'`);

    // Per-session thread directory (AMA `session_thread`-shaped). Lives
    // here in DO SQLite — same atomicity domain as `events`, no need for
    // D1 round-trip on the hot path. Spec note: AMA SDK exposes
    // `BetaManagedAgentsSessionThread` with `id` (sthr_*), `agent_name`,
    // `parent_thread_id` (NULL = primary), and `archived_at`. We mirror
    // those fields plus `agent_id` for our internal config lookup.
    //
    // Primary thread row (`sthr_primary`) is seeded lazily on first
    // turn — see _ensurePrimaryThread() — because at constructor time
    // the agent_id isn't known yet (set on /init).
    sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        parent_thread_id TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id, created_at)`);
  }

  /**
   * Serialize a `threads` row into the AMA wire shape, including
   * stats computed at read-time from the events table. Single source
   * of truth for the /threads list, /threads/:tid get, and the
   * archive echo response — keeps shape drift impossible.
   *
   * stats.elapsed_seconds: now - created_at, frozen at archived_at.
   * stats.time_to_first_run_seconds: per AMA spec, 0 for child
   *   threads (which spawn already running) and computed for primary.
   * stats.active_seconds: SUM(end_ts - start_ts) over paired
   *   span.model_request_start / span.model_request_end events scoped
   *   to this thread. Whole-second resolution (events.ts is in
   *   seconds). In-flight pairs are skipped.
   * usage: read from state.thread_usage[id] (per-thread token counters,
   *   credited from reportUsage + span.model_request_end cache fields).
   *   Returns null for legacy sessions that pre-date the per-thread
   *   bucket — the AMA SDK accepts null and treats it as "no usage
   *   recorded yet."
   */
  private _serializeThreadRow(row: Record<string, unknown>): Record<string, unknown> {
    const id = row.id as string;
    const createdAt = row.created_at as number;
    const archivedAt = row.archived_at as number | null | undefined;
    const isPrimary = id === "sthr_primary";

    const endTs = archivedAt ?? Date.now();
    const elapsedSeconds = Math.max(0, Math.round((endTs - createdAt) / 1000));

    let timeToFirstRunSeconds: number | null = 0;
    if (isPrimary) {
      // First user.message in the primary thread — processed_at is the
      // ingestion time. Falls back to ts when processed_at is null
      // (e.g. queued but never drained — rare but possible if the user
      // archives before any turn runs).
      let firstAt: number | null = null;
      for (const r of this.ctx.storage.sql.exec(
        `SELECT processed_at, ts FROM events
           WHERE session_thread_id = ? AND type = 'user.message'
           ORDER BY seq ASC LIMIT 1`,
        id,
      )) {
        firstAt = (r.processed_at as number | null) ?? (r.ts as number);
      }
      timeToFirstRunSeconds = firstAt != null
        ? Math.max(0, Math.round((firstAt - createdAt) / 1000))
        : null;
    }

    // active_seconds: SUM(end_ts - start_ts) over paired
    // span.model_request_start / span.model_request_end events for this
    // thread. Pairs join on the start event's `id` ↔ end event's
    // `model_request_start_id` (set by default-loop's onStepFinish/onError/
    // onAbort). The SQL `ts` column is in seconds, so we get whole-second
    // resolution which is fine for a "time spent in the model" stat.
    //
    // Sub-agent spans get session_thread_id stamped at write time by the
    // tagged runtime.broadcast closure in runSubAgent; primary spans
    // default to 'sthr_primary' via the cf-do INSERT default. Unpaired
    // starts (turn still in flight) and unpaired ends (recovery edge
    // cases) are skipped.
    let activeSeconds = 0;
    {
      const starts = new Map<string, number>();
      // One pass: bucket starts by id, on end events accumulate the diff.
      for (const r of this.ctx.storage.sql.exec(
        `SELECT type, data, ts FROM events
           WHERE session_thread_id = ?
             AND (type = 'span.model_request_start' OR type = 'span.model_request_end')
           ORDER BY seq ASC`,
        id,
      )) {
        const ts = r.ts as number;
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(r.data as string) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (r.type === "span.model_request_start") {
          const sid = payload?.id as string | undefined;
          if (sid) starts.set(sid, ts);
        } else {
          const sid = payload?.model_request_start_id as string | undefined;
          if (!sid) continue;
          const startTs = starts.get(sid);
          if (startTs == null) continue;
          starts.delete(sid);
          activeSeconds += Math.max(0, ts - startTs);
        }
      }
    }

    const updatedTs = archivedAt ?? createdAt;
    const threadUsage = this.state.thread_usage?.[id];
    const usage = threadUsage
      ? {
          input_tokens: threadUsage.input_tokens,
          output_tokens: threadUsage.output_tokens,
          cache_read_input_tokens: threadUsage.cache_read_input_tokens,
          // AMA spec exposes cache_creation as a sub-shape with per-lifetime
          // breakdown — we only have a single bucket so far, so emit it as
          // the unbucketed total under `cache_creation_input_tokens` for
          // back-compat with simpler readers; the AMA SDK accepts the extra
          // field. (Add the nested cache_creation shape when we get TTL data
          // from the provider.)
          cache_creation_input_tokens: threadUsage.cache_creation_input_tokens,
        }
      : null;
    return {
      id,
      type: "session_thread",
      session_id: this.state.session_id,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      parent_thread_id: row.parent_thread_id,
      status: archivedAt != null ? "archived" : "active",
      created_at: new Date(createdAt).toISOString(),
      archived_at: archivedAt != null ? new Date(archivedAt).toISOString() : null,
      updated_at: new Date(updatedTs).toISOString(),
      stats: {
        elapsed_seconds: elapsedSeconds,
        active_seconds: activeSeconds,
        time_to_first_run_seconds: timeToFirstRunSeconds,
      },
      usage,
    };
  }

  /**
   * Idempotent primary-thread seed. Called on first turn (lazy because
   * agent_id isn't known until /init). Subsequent calls no-op via
   * INSERT OR IGNORE.
   */
  private _ensurePrimaryThread(): void {
    const agentId = this.state.agent_id;
    if (!agentId) return; // pre-init; nothing to seed against
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO threads (id, agent_id, agent_name, parent_thread_id, created_at)
       VALUES ('sthr_primary', ?, ?, NULL, ?)`,
      agentId,
      this.state.agent_snapshot?.name ?? null,
      Date.now(),
    );
  }

  // ── Schedule API (mirrors cf-agents) ──────────────────────────────────

  /**
   * Schedule a method to run later. `when` accepts:
   *   - Date          → run at that absolute time
   *   - number        → run after this many seconds
   *   - cron string   → recurring (e.g. "0 9 * * *")
   * `callback` is the name of a method on `this` to invoke. Payload is
   * JSON-stringified into the row and JSON-parsed back into the first arg.
   * Returns a Schedule with at least `.id` and `.callback`.
   */
  async schedule<T = unknown>(
    when: Date | number | string,
    callback: keyof this | string,
    payload?: T,
  ): Promise<{ id: string; callback: string; type: SessionScheduleType; time: number; payload: T; cron?: string; delayInSeconds?: number }> {
    const callbackName = String(callback);
    if (typeof (this as unknown as Record<string, unknown>)[callbackName] !== "function") {
      throw new Error(`this.${callbackName} is not a function`);
    }
    const payloadJson = JSON.stringify(payload);
    const id = nanoid(9);

    let type: SessionScheduleType;
    let timestamp: number;
    let cron: string | undefined;
    let delayInSeconds: number | undefined;
    if (when instanceof Date) {
      type = "scheduled";
      timestamp = Math.floor(when.getTime() / 1000);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, ?, 'scheduled', ?)`,
        id, callbackName, payloadJson, timestamp,
      );
    } else if (typeof when === "number") {
      type = "delayed";
      delayInSeconds = when;
      timestamp = Math.floor(Date.now() / 1000) + when;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, delayInSeconds, time) VALUES (?, ?, ?, 'delayed', ?, ?)`,
        id, callbackName, payloadJson, when, timestamp,
      );
    } else if (typeof when === "string") {
      type = "cron";
      cron = when;
      timestamp = nextCronFireSeconds(when);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, cron, time) VALUES (?, ?, ?, 'cron', ?, ?)`,
        id, callbackName, payloadJson, when, timestamp,
      );
    } else {
      throw new Error(`Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) for ${callbackName}`);
    }

    await this._multiplexAlarm({ reason: "schedule" });
    return { id, callback: callbackName, type, time: timestamp, payload: payload as T, cron, delayInSeconds };
  }

  async scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: keyof this | string,
    payload?: T,
  ): Promise<{ id: string; callback: string; type: "interval"; intervalSeconds: number; time: number }> {
    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }
    const callbackName = String(callback);
    if (typeof (this as unknown as Record<string, unknown>)[callbackName] !== "function") {
      throw new Error(`this.${callbackName} is not a function`);
    }
    const payloadJson = JSON.stringify(payload);
    const existing = this.ctx.storage.sql
      .exec<{ id: string; intervalSeconds: number; time: number }>(
        `SELECT id, intervalSeconds, time FROM cf_agents_schedules WHERE type = 'interval' AND callback = ? AND intervalSeconds = ? AND payload IS ? LIMIT 1`,
        callbackName, intervalSeconds, payloadJson,
      )
      .toArray();
    if (existing.length > 0) {
      const row = existing[0];
      return { id: row.id, callback: callbackName, type: "interval", intervalSeconds: row.intervalSeconds, time: row.time };
    }
    const id = nanoid(9);
    const timestamp = Math.floor(Date.now() / 1000) + intervalSeconds;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, intervalSeconds, time, running) VALUES (?, ?, ?, 'interval', ?, ?, 0)`,
      id, callbackName, payloadJson, intervalSeconds, timestamp,
    );
    await this._multiplexAlarm({ reason: "schedule_interval" });
    return { id, callback: callbackName, type: "interval", intervalSeconds, time: timestamp };
  }

  getSchedule<T = unknown>(id: string): { id: string; callback: string; payload: T; type: string; time: number; cron?: string } | undefined {
    const row = this.ctx.storage.sql
      .exec<{ id: string; callback: string; payload: string; type: string; time: number; cron: string | null }>(
        `SELECT id, callback, payload, type, time, cron FROM cf_agents_schedules WHERE id = ? LIMIT 1`,
        id,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      id: row.id,
      callback: row.callback,
      payload: this._safeParse(row.payload) as T,
      type: row.type,
      time: row.time,
      cron: row.cron ?? undefined,
    };
  }

  getSchedules(criteria: { type?: string; timeRange?: { start?: Date; end?: Date } } = {}): Array<{
    id: string;
    callback: string;
    payload: unknown;
    type: string;
    time: number;
    cron?: string;
  }> {
    let query = "SELECT id, callback, payload, type, time, cron FROM cf_agents_schedules WHERE 1=1";
    const params: Array<string | number> = [];
    if (criteria.type) { query += " AND type = ?"; params.push(criteria.type); }
    if (criteria.timeRange) {
      const start = criteria.timeRange.start ?? new Date(0);
      const end = criteria.timeRange.end ?? new Date(8.64e15);
      query += " AND time >= ? AND time <= ?";
      params.push(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
    }
    return this.ctx.storage.sql
      .exec<{ id: string; callback: string; payload: string; type: string; time: number; cron: string | null }>(query, ...params)
      .toArray()
      .map((row) => ({
        id: row.id,
        callback: row.callback,
        payload: this._safeParse(row.payload),
        type: row.type,
        time: row.time,
        cron: row.cron ?? undefined,
      }));
  }

  async cancelSchedule(id: string): Promise<boolean> {
    const before = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM cf_agents_schedules WHERE id = ? LIMIT 1`, id)
      .toArray();
    if (before.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, id);
    await this._multiplexAlarm({ reason: "schedule_cancelled" });
    return true;
  }

  private _safeParse(s: string | null | undefined): unknown {
    if (!s) return undefined;
    try { return JSON.parse(s); } catch { return undefined; }
  }

  /**
   * Soonest ready schedule (or hung interval recovery) in epoch ms, or null.
   * Pure cf-agents scheduler bookkeeping; merged into the shared policy's
   * nextWakeAt below.
   */
  private _nextScheduleWakeMs(nowMs: number): number | null {
    try {
      const hungCutoffSec = Math.floor(nowMs / 1000) - HUNG_SCHEDULE_TIMEOUT_SECONDS;
      const readyRows = this.ctx.storage.sql
        .exec<{ time: number }>(
          `SELECT time FROM cf_agents_schedules WHERE type != 'interval' OR running = 0 OR coalesce(execution_started_at, 0) <= ? ORDER BY time ASC LIMIT 1`,
          hungCutoffSec,
        )
        .toArray();
      const recoveringRows = this.ctx.storage.sql
        .exec<{ execution_started_at: number | null }>(
          `SELECT execution_started_at FROM cf_agents_schedules WHERE type = 'interval' AND running = 1 AND coalesce(execution_started_at, 0) > ? ORDER BY execution_started_at ASC LIMIT 1`,
          hungCutoffSec,
        )
        .toArray();
      let nextMs: number | null = null;
      if (readyRows.length > 0) nextMs = Math.max(readyRows[0].time * 1000, nowMs + 1);
      if (recoveringRows.length > 0 && recoveringRows[0].execution_started_at !== null) {
        const recoveryMs = (recoveringRows[0].execution_started_at + HUNG_SCHEDULE_TIMEOUT_SECONDS) * 1000;
        nextMs = nextMs === null ? recoveryMs : Math.min(nextMs, recoveryMs);
      }
      return nextMs;
    } catch {
      return null;
    }
  }

  /** Unprocessed inbound rows (events.processed_at IS NULL), one per lane. */
  private _localQueuedInputs(): QueuedInputRecord[] {
    const out: QueuedInputRecord[] = [];
    try {
      for (const laneId of this.queue.threadsWithQueueInputs()) {
        const exhaustedAt = this.state.exhausted_at_by_lane?.[laneId];
        let settleOnly: SettleOnlyReason | null | undefined;
        for (const row of this.queue.listQueue(laneId)) {
          const heldAfterExhausted =
            exhaustedAt !== undefined && row.enqueued_at <= exhaustedAt;
          const isContinuation =
            row.type === "user.tool_confirmation" ||
            row.type === "user.custom_tool_result";
          let blocked = false;
          let blockedReason: "requires_action" | "budget_reached" | undefined;
          if (!heldAfterExhausted && !isContinuation) {
            if (settleOnly === undefined) {
              settleOnly = this._laneSettleOnlyReasonSafe(laneId);
            }
            if (settleOnly !== null) {
              blocked = true;
              blockedReason = settleOnly;
            }
          }
          out.push({
            id: row.event_id,
            laneId,
            ...(heldAfterExhausted ? { heldAfterExhausted: true } : {}),
            ...(blocked && blockedReason !== undefined
              ? { blocked: true, blockedReason }
              : {}),
          });
        }
      }
    } catch {
      // Schema cold start / queue unavailable — the policy simply sees no
      // local work this pass.
    }
    return out;
  }

  /** Never let queue classification break the alarm; a failed read is just
   *  "not parked" and the no-progress backoff still protects the loop. */
  private _laneSettleOnlyReasonSafe(threadId: string): SettleOnlyReason | null {
    try {
      return this.laneSettleOnlyReason(this.openHistory(), threadId);
    } catch {
      return null;
    }
  }

  /** Identity of the drainable queue state. A drain/claim is progress when
   *  this changes (row processed, execution claimed/settled, turn started). */
  private _queueProgressToken(
    executions: readonly ExecutionLeaseRecord[],
    inputs: readonly QueuedInputRecord[],
  ): string {
    const executionToken = executions
      .map((execution) => [
        execution.executionId,
        execution.laneId ?? "",
        execution.state,
        execution.attemptCount,
        execution.ownerId ?? "",
        execution.leaseExpiresAtMs ?? "",
      ].join(":"))
      .sort()
      .join("|");
    const inputToken = inputs
      .map((input) => input.id ?? "")
      .sort()
      .join("|");
    const activeToken = [
      ...[...this._activeTurnIds].sort().map((id) => `turn:${id}`),
      ...[...this._executionActiveLanes].sort().map((lane) => `lane:${lane}`),
      ...[...this._draining].sort().map((lane) => `drain:${lane}`),
    ].join("|");
    return `${executionToken}#${inputToken}#${activeToken}`;
  }

  private _resetQueueDrainBackoff(): void {
    this._queueDrainFailures = 0;
    this._queueDrainRetryAtMs = null;
  }

  /** One line per no-progress drain pass; the multiplexer then holds the
   *  single alarm slot at the backoff horizon instead of re-arming ~1s later. */
  private _recordQueueDrainNoProgress(
    context: { queued: number; blocked: number; running: number },
  ): void {
    const nowMs = this.processedClock.nowMs();
    this._queueDrainFailures += 1;
    const backoffMs = Math.min(
      QUEUE_DRAIN_BACKOFF_BASE_MS * 2 ** (this._queueDrainFailures - 1),
      QUEUE_DRAIN_BACKOFF_MAX_MS,
    );
    this._queueDrainRetryAtMs = nowMs + backoffMs;
    sdoLog("alarm.backoff", {
      session_id: this._state?.session_id,
      reason: "queue_no_progress",
      attempt: this._queueDrainFailures,
      backoff_ms: backoffMs,
      retry_at_ms: this._queueDrainRetryAtMs,
      queued: context.queued,
      blocked: context.blocked,
      running_executions: context.running,
    });
  }

  /**
   * In-memory turns that are live in THIS incarnation but may not have a
   * durable execution row yet (claim/beginTurn race), plus a dangling
   * event-log `status_running` left by a dead incarnation. The policy keeps
   * the alarm armed for these until the finalizer emits a terminal status.
   */
  private _activeTurnRecords(): ActiveTurnRecord[] {
    const turns: ActiveTurnRecord[] = [];
    for (const id of this._activeTurnIds) turns.push({ id });
    for (const lane of this._executionActiveLanes) turns.push({ id: `lane:${lane}` });
    for (const lane of this._draining) turns.push({ id: `drain:${lane}` });
    if (this._latestSessionStatusEvent()?.type === "session.status_running") {
      turns.push({ id: "event_log_turn" });
    }
    return turns;
  }

  private _leaseRecordFor(execution: SessionExecution): ExecutionLeaseRecord {
    return {
      executionId: execution.id,
      laneId: execution.laneId,
      state: execution.state,
      attemptCount: execution.attemptCount,
      maxAttempts: execution.maxAttempts,
      admittedAtMs: Date.parse(execution.admittedAt),
      leaseExpiresAtMs: execution.attempt === null
        ? null
        : Date.parse(execution.attempt.leaseExpiresAt),
      deadlineAtMs: Date.parse(execution.deadlineAt),
      ownerId: execution.attempt?.ownerId ?? null,
      heldAfterExhausted: execution.heldAfterExhaustedAt !== null,
    };
  }

  private async _executionLeaseRecords(): Promise<ExecutionLeaseRecord[]> {
    const store = await this.getExecutionStore();
    if (store === null) return [];
    const active = await store.listActive({
      workspaceId: this.state.tenant_id,
      sessionId: this.state.session_id,
    });
    return active.map((execution) => this._leaseRecordFor(execution));
  }

  /**
   * Persisted turn output after the admitted input. Lifecycle rows
   * (`session.status_*`) and spans prove the turn started but are not durable
   * work, so they are deliberately NOT in this set: an owner that died before
   * persisting anything is safe to re-dispatch once.
   */
  private static readonly DURABLE_TURN_OUTPUT_TYPES: ReadonlySet<string> = new Set([
    "agent.message",
    "agent.thinking",
    "agent.tool_use",
    "agent.tool_result",
    "agent.custom_tool_use",
    "agent.mcp_tool_use",
    "agent.mcp_tool_result",
    "session.error",
    "session.outcome_evaluated",
  ]);

  /**
   * Read the canonical event stream for an interrupted execution. The stream
   * is the only recovery authority (Flue): reuse persisted outputs/results,
   * interrupt an unpaired tool call, and requeue only an input with no
   * persisted work at all.
   */
  private _canonicalTurnEvidence(record: ExecutionLeaseRecord): CanonicalTurnEvidence {
    const laneId = record.laneId ?? "sthr_primary";
    const admittedAtMs = Number.isSafeInteger(record.admittedAtMs)
      ? record.admittedAtMs as number
      : 0;
    const base: CanonicalTurnEvidence = {
      inputAtMs: admittedAtMs,
      eventsAfterInput: [],
      unpairedToolUseCount: 0,
      completedOutputCount: 0,
      providerDispatches: record.attemptCount,
    };
    try {
      const sql = this.ctx.storage.sql;
      // Prefer the input row's seq over wall-clock stamps: events are stored
      // at second resolution, and strict timestamp comparison can miss an
      // output persisted in the same second as admission.
      let inputSeq: number | null = null;
      for (const row of sql.exec(
        `SELECT seq FROM events
          WHERE json_extract(data, '$.id') = ?
          ORDER BY seq ASC LIMIT 1`,
        record.executionId,
      )) {
        inputSeq = row.seq as number;
      }
      const rows = inputSeq !== null
        ? sql.exec(
          `SELECT type, data FROM events
            WHERE seq > ?
              AND coalesce(session_thread_id, 'sthr_primary') = ?
              AND processed_at IS NOT NULL
            ORDER BY seq ASC`,
          inputSeq, laneId,
        )
        : sql.exec(
          `SELECT type, data FROM events
            WHERE ts * 1000 >= ?
              AND coalesce(session_thread_id, 'sthr_primary') = ?
              AND processed_at IS NOT NULL
            ORDER BY seq ASC`,
          admittedAtMs, laneId,
        );

      const toolUses = new Map<string, boolean>();
      const outputs: Array<{ type: string }> = [];
      let completedOutputCount = 0;
      for (const row of rows) {
        const type = row.type as string;
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(row.data as string) as Record<string, unknown>;
        } catch { /* malformed row: ignore for recovery evidence */ }
        if (type === "agent.tool_use" || type === "agent.mcp_tool_use") {
          const id = data.id;
          if (typeof id === "string" && id.length > 0) toolUses.set(id, false);
        } else if (type === "agent.tool_result") {
          const id = data.tool_use_id;
          if (typeof id === "string" && toolUses.has(id)) toolUses.set(id, true);
        } else if (type === "agent.mcp_tool_result") {
          const id = data.mcp_tool_use_id;
          if (typeof id === "string" && toolUses.has(id)) toolUses.set(id, true);
        }
        if (!SessionDO.DURABLE_TURN_OUTPUT_TYPES.has(type)) continue;
        outputs.push({ type });
        if (
          type === "agent.message" ||
          type === "agent.tool_result" ||
          type === "agent.mcp_tool_result"
        ) {
          completedOutputCount += 1;
        }
      }
      return {
        ...base,
        eventsAfterInput: outputs,
        unpairedToolUseCount: [...toolUses.values()].filter((resolved) => !resolved).length,
        completedOutputCount,
      };
    } catch {
      // Schema cold start / malformed storage: treat as unapplied so the
      // normal attempt budget still applies rather than dropping the row.
      return base;
    }
  }

  /**
   * Requeue-vs-interrupt for one expired lease. The lease policy answers
   * "may this be retried"; the canonical stream answers "should it be".
   * Applied-but-unfinished work and unpaired tool calls are finalized as
   * interrupted and never rerun; only a provably unapplied input is requeued,
   * and only for the single provider re-dispatch allowance.
   */
  private _decideSweepForRecord(
    record: ExecutionLeaseRecord,
    nowMs: number,
  ): CoordinationAction | null {
    const base = decideExpiredExecution(record, nowMs);
    if (base === null || base.type !== "requeue") return base;
    const evidence = this._canonicalTurnEvidence(record);
    const decision = decideRecoveryFromCanonicalStream(evidence, {
      maxProviderRedispatches: 1,
    });
    if (decision.type === "requeue") return base;
    const reason = decision.type === "reuse" ? "input_applied" : decision.reason;
    sdoLog("recovery.stream", {
      session_id: this._state?.session_id,
      lane_id: record.laneId ?? "sthr_primary",
      execution_id: record.executionId,
      decision: decision.type === "reuse" ? "reuse_outputs" : "interrupt",
      reason,
      applied_events: evidence.eventsAfterInput.length,
      completed_outputs: evidence.completedOutputCount,
      unpaired_tool_uses: evidence.unpairedToolUseCount,
      provider_dispatches: evidence.providerDispatches,
    });
    return {
      type: "finalize-interrupted",
      executionId: base.executionId,
      ...(base.laneId === undefined ? {} : { laneId: base.laneId }),
      reason,
      attemptCount: base.attemptCount,
      maxAttempts: base.maxAttempts,
    };
  }

  /**
   * Shared-policy sweep for this session. Node applies the same decisions in
   * claim/renew; CF applies them from the alarm wake. Both feed the same
   * lease record through the same stream-aware decision.
   */
  private async _sweepExpiredLeases(nowMs: number): Promise<void> {
    const store = await this.getExecutionStore();
    if (store === null) return;
    await store.sweepExpired(nowMs, {
      decideForRecord: (record) => this._decideSweepForRecord(record, nowMs),
      onDecision: (action: CoordinationAction) => {
        if (action.type === "requeue") {
          sdoLog("lease.expire", {
            session_id: this.state.session_id,
            lane_id: action.laneId ?? "sthr_primary",
            execution_id: action.executionId,
            decision: "requeue",
            attempt_count: action.attemptCount,
            max_attempts: action.maxAttempts,
          });
        } else if (action.type === "finalize-interrupted") {
          sdoLog("lease.sweep", {
            session_id: this.state.session_id,
            lane_id: action.laneId ?? "sthr_primary",
            execution_id: action.executionId,
            decision: "finalize_interrupted",
            reason: action.reason,
            attempt_count: action.attemptCount,
            max_attempts: action.maxAttempts,
          });
        }
      },
    });
  }

  /**
   * Renew leases that are inside the policy renewal horizon. Only a fence
   * owned by this incarnation is renewed; a dead owner's lease is left for
   * the sweep to requeue/finalize.
   */
  private async _applyPolicyLeaseRenewals(nowMs: number): Promise<void> {
    const store = await this.getExecutionStore();
    if (store === null) return;
    const active = await store.listActive({
      workspaceId: this.state.tenant_id,
      sessionId: this.state.session_id,
    });
    if (active.length === 0) return;
    const policy = evaluateCoordinationPolicy({
      nowMs,
      executions: active.map((execution) => this._leaseRecordFor(execution)),
      heartbeatIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      queuedWakeDelayMs: QUEUE_WAKE_DELAY_MS,
    });
    for (const action of policy.actions) {
      if (action.type !== "renew") continue;
      const laneId = action.laneId ?? "sthr_primary";
      const fence = this._executionFences.get(laneId);
      if (fence === undefined || fence.executionId !== action.executionId) {
        sdoLog("lease.renew_skipped", {
          session_id: this.state.session_id,
          lane_id: laneId,
          execution_id: action.executionId,
          reason: "no_local_fence",
        });
        continue;
      }
      const execution = active.find((candidate) => candidate.id === action.executionId);
      if (execution === undefined) continue;
      const renewal = decideLeaseRenewal(
        this._leaseRecordFor(execution),
        nowMs,
        { leaseTtlMs: EXECUTION_LEASE_TTL_MS },
      );
      if (renewal === null) continue;
      try {
        const renewed = await store.renew({
          fence,
          renewedAt: new Date(nowMs).toISOString(),
          leaseTtlMs: EXECUTION_LEASE_TTL_MS,
        });
        if (renewed.type === "renewed") {
          this._executionFences.set(laneId, renewed.fence);
          sdoLog("lease.renew", {
            session_id: this.state.session_id,
            lane_id: laneId,
            execution_id: action.executionId,
            generation: renewed.fence.generation,
            lease_expires_at: renewed.fence.expiresAt,
          });
        } else {
          sdoLog("lease.renew_lost", {
            session_id: this.state.session_id,
            lane_id: laneId,
            execution_id: action.executionId,
          });
        }
      } catch (err) {
        sdoLog("lease.renew_failed", {
          session_id: this.state.session_id,
          lane_id: laneId,
          execution_id: action.executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Re-drive durable execution work after a dropped service-binding wakeup or
   * a DO restart. Lanes come from the shared policy (drain/claim/requeue
   * actions), not an ad-hoc SQL scan; claim/lease/fence decisions remain
   * inside SessionExecutionStorePort.
   */
  private async recoverExecutionQueue(): Promise<void> {
    // alarm() can reach this before any fetch()/init has warmed the in-memory
    // schema. Without this, drainEventQueue later dereferences a null queue
    // repo and the cold-started lane is never re-driven.
    this.ensureSchema();
    const nowMs = this.processedClock.nowMs();
    let executions: ExecutionLeaseRecord[] = [];
    try {
      executions = await this._executionLeaseRecords();
    } catch (err) {
      console.warn(`[alarm] execution lease read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const queuedInputs = this._localQueuedInputs();
    if (executions.length === 0 && queuedInputs.length === 0) {
      this._resetQueueDrainBackoff();
      return;
    }
    const policy = evaluateCoordinationPolicy({
      nowMs,
      executions,
      queuedInputs,
      heartbeatIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      queuedWakeDelayMs: QUEUE_WAKE_DELAY_MS,
    });
    const lanes = new Set<string>();
    for (const action of policy.actions) {
      if (action.type === "drain") lanes.add(action.laneId);
      else if (action.type === "claim" || action.type === "requeue") {
        lanes.add(action.laneId ?? "sthr_primary");
      }
    }
    if (lanes.size === 0) {
      // Only blocked/held rows remain. They must not keep the aggressive
      // wake; the multiplexer arms a 5-minute safety net.
      this._resetQueueDrainBackoff();
      return;
    }
    const laneIds = [...lanes];
    const before = this._queueProgressToken(executions, queuedInputs);
    sdoLog("recover.execution_queue", {
      session_id: this.state.session_id,
      lanes: laneIds.length,
      lane_ids: laneIds,
      blocked: policy.blockedQueuedRows,
    });
    await Promise.all(laneIds.map((lane) => this.drainEventQueue(lane)));

    let afterExecutions: ExecutionLeaseRecord[];
    try {
      afterExecutions = await this._executionLeaseRecords();
    } catch {
      // Unknown post-drain state: do not manufacture a backoff from a read
      // failure. The next alarm/recovery read will decide.
      this._resetQueueDrainBackoff();
      return;
    }
    const afterInputs = this._localQueuedInputs();
    const after = this._queueProgressToken(afterExecutions, afterInputs);
    if (after !== before) {
      // A row drained, an execution was claimed/settled, or a turn started.
      this._resetQueueDrainBackoff();
      return;
    }
    this._recordQueueDrainNoProgress({
      queued: queuedInputs.length + executions.filter((e) => e.state === "queued").length,
      blocked: policy.blockedQueuedRows,
      running: executions.filter((e) => e.state === "running").length,
    });
  }

  /**
   * Alarm entry point. Fired by CF runtime when setAlarm() time is reached.
   * Dispatches all due schedules in time order, then runs housekeeping
   * (orphan-fiber recovery), then re-arms the next alarm.
   */
  async alarm(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const due = this.ctx.storage.sql
      .exec<{
        id: string;
        callback: string;
        payload: string;
        type: string;
        cron: string | null;
        intervalSeconds: number | null;
        running: number;
        execution_started_at: number | null;
      }>(`SELECT id, callback, payload, type, cron, intervalSeconds, running, execution_started_at FROM cf_agents_schedules WHERE time <= ?`, nowSec)
      .toArray();

    sdoLog("alarm.fired", {
      session_id: this._state?.session_id,
      fired_at_ms: nowSec * 1000,
      due_schedules: due.length,
      reason: due.length > 0 ? "schedule" : "lease_or_queue",
    });
    for (const row of due) {
      // Skip interval rows whose previous execution is still running unless
      // it's been hung past the timeout (then forcibly reset).
      if (row.type === "interval" && row.running === 1) {
        const startedAt = row.execution_started_at ?? 0;
        const elapsed = nowSec - startedAt;
        if (elapsed < HUNG_SCHEDULE_TIMEOUT_SECONDS) {
          continue;
        }
        console.warn(`[schedule] forcing reset of hung interval schedule ${row.id} (started ${elapsed}s ago)`);
      }
      if (row.type === "interval") {
        this.ctx.storage.sql.exec(
          `UPDATE cf_agents_schedules SET running = 1, execution_started_at = ? WHERE id = ?`,
          nowSec, row.id,
        );
      }

      const callback = (this as unknown as Record<string, unknown>)[row.callback];
      if (typeof callback !== "function") {
        console.error(`[schedule] callback ${row.callback} not found on SessionDO; skipping ${row.id}`);
        continue;
      }
      let parsedPayload: unknown;
      try { parsedPayload = JSON.parse(row.payload); }
      catch (err) {
        console.error(`[schedule] payload parse failed for ${row.id} (${row.callback}):`, err);
        // Delete the unparseable row so the alarm doesn't loop on it forever.
        this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, row.id);
        continue;
      }
      try {
        await (callback as (p: unknown, r: unknown) => Promise<unknown>).call(this, parsedPayload, row);
      } catch (err) {
        console.error(`[schedule] callback "${row.callback}" (${row.id}) threw:`, err);
        // Don't crash the alarm — log and continue. cf-agents has retry options
        // but we don't use them in any current callsite.
      }

      // Reschedule cron / interval, delete one-shots
      if (row.type === "cron" && row.cron) {
        try {
          const nextSec = nextCronFireSeconds(row.cron);
          this.ctx.storage.sql.exec(`UPDATE cf_agents_schedules SET time = ? WHERE id = ?`, nextSec, row.id);
        } catch (err) {
          console.error(`[schedule] cron parse failed during reschedule for ${row.id}:`, err);
          this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, row.id);
        }
      } else if (row.type === "interval") {
        const interval = row.intervalSeconds ?? 0;
        const nextSec = Math.floor(Date.now() / 1000) + interval;
        this.ctx.storage.sql.exec(
          `UPDATE cf_agents_schedules SET running = 0, execution_started_at = NULL, time = ? WHERE id = ?`,
          nextSec, row.id,
        );
      } else {
        this.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, row.id);
      }
    }

    // The persisted alarm is the FALLBACK recovery path. Cold start (first
    // request / ensureSchema) calls this exact same hook, so the lease sweep,
    // renewal, stale-turn finalization, and queue re-drive are identical no
    // matter what woke the DO.
    await this._runRecovery("alarm");

    // Container keepalive: while there's at least one background_tasks row,
    // ping the sandbox container to reset its sleepAfter timer. Means
    // long-running `python script.py &` jobs that the agent is waiting on
    // don't get killed by the 5-minute idle TTL. Cheap (~5 ms RPC).
    try {
      const rows = this.ctx.storage.sql
        .exec("SELECT 1 FROM background_tasks LIMIT 1")
        .toArray();
      if (rows.length > 0) {
        const sb = await this.getOrCreateSandbox();
        if (typeof (sb as { renewActivityTimeout?: () => Promise<void> }).renewActivityTimeout === "function") {
          await (sb as { renewActivityTimeout: () => Promise<void> }).renewActivityTimeout();
        }
      }
    } catch {
      // background_tasks table missing or container down — alarm continues
    }

    await this._multiplexAlarm({ reason: "alarm" });
  }

  // ── Stale-turn finalization ──────────────────────────────────────────
  // Orphan detection now comes from the shared lease policy (expired
  // execution -> finalize-interrupted) plus the event-log fallback inside
  // _finalizeStaleTurns. The old onFiberRecovered replay path was removed
  // because replaying an LLM stream from inside alarm() burned the wall-time
  // budget and raced the original turn.

  /**
   * Lightweight stale-turn cleanup — replacement for the old
   * onFiberRecovered → recoverAgentTurn chain that re-ran the LLM
   * stream from inside alarm() and routinely burned the 180s
   * Workers wall-time budget (observed 2026-05-10 sess-slqg7xf4: 6
   * consecutive 180s alarm fires + 110s alarm gap = DO evicted).
   *
   * Aligns with cloudflare/agents SDK guidance: "LLM calls are NOT
   * replayed — if streaming mid-response when evicted, that stream is
   * lost permanently." Recovery == surface the interruption + clean
   * up state, not auto-replay.
   *
   * What this does:
   *   1. For every unpaired tool_use (no matching tool_result by id),
   *      append an aborted tool_result so Console pairing collapses
   *      the bubble + history is consistent for any future re-prompt.
   *   2. For every stuck `sessions.status='running'` row whose turn_id
   *      isn't in `_activeTurnIds` (i.e. dead from a prior incarnation),
   *      append `session.status_rescheduled` + `session.status_idle`
   *      then call adapter.endTurn to flip the row.
   *
   * All SQL writes; no LLM call, no harness re-run. Cheap enough to
   * call from alarm() AND first-fetch.
   */
  private async _finalizeStaleTurns(): Promise<void> {
    // Single-flight: fetch() starts the cold-start pass without awaiting
    // while alarm() can run the same pass concurrently. Both would read
    // the same unpaired set and append two aborted results for one
    // tool_use (provider 400: "each tool_use must have a single result").
    if (this._finalizePromise) return this._finalizePromise;
    const pass = this._finalizeStaleTurnsInner().finally(() => {
      if (this._finalizePromise === pass) this._finalizePromise = null;
    });
    this._finalizePromise = pass;
    return pass;
  }

  private async _finalizeStaleTurnsInner(): Promise<void> {
    if (!this._state) return;
    // Ensure events table exists (alarm() runs without going through
    // fetchInner's ensureSchema). Cheap idempotent CREATE IF NOT EXISTS.
    try { this.ensureSchema(); } catch { /* schema already up-to-date */ }
    const sql = this.ctx.storage.sql;

    // Let the cold-start recovery scan (started by ensureSchema) finish
    // before pairing. Otherwise it races this finalizer: it can inject a
    // non-is_error placeholder for the same tool_use we are about to
    // abort, or append a second result after our scan saw it unpaired.
    // Awaiting the shared promise makes the pairing decision see a
    // stable event log and yields exactly one aborted result.
    if (this._recoveryPromise) {
      try {
        await this._recoveryPromise;
      } catch (err) {
        console.warn(`[finalize-stale] cold-start recovery failed:`, err);
      }
    }

    // 1. Unpaired tool_use detection. Three flavors per the wire spec
    //    in default-loop.ts:emitToolCallEvent:
    //      • agent.tool_use         → result keyed by tool_use_id
    //      • agent.custom_tool_use  → result keyed by tool_use_id
    //      • agent.mcp_tool_use     → result keyed by mcp_tool_use_id
    //    The pairing key for use→result is always the use's own `id`.
    //    Wrapped in try blocks so a missing events table (very early
    //    cold-start) doesn't short-circuit the sessions row cleanup
    //    below — that's the contract callers depend on.
    const usedIds = new Map<string, { type: string; thread?: string | null }>();
    try {
      const useCursor = sql.exec(
        `SELECT type, data, session_thread_id FROM events
          WHERE type IN ('agent.tool_use','agent.custom_tool_use','agent.mcp_tool_use')`,
      );
      for (const row of useCursor) {
        try {
          const d = JSON.parse(row.data as string) as { id?: string };
          if (d.id) usedIds.set(d.id, {
            type: row.type as string,
            thread: row.session_thread_id as string | null,
          });
        } catch { /* skip malformed */ }
      }
    } catch { /* events table missing — skip flush, do row cleanup below */ }
    if (usedIds.size > 0) {
      try {
        const resCursor = sql.exec(
          `SELECT data FROM events
            WHERE type IN ('agent.tool_result','agent.mcp_tool_result')`,
        );
        for (const row of resCursor) {
          try {
            const d = JSON.parse(row.data as string) as {
              tool_use_id?: string;
              mcp_tool_use_id?: string;
            };
            const id = d.tool_use_id ?? d.mcp_tool_use_id;
            if (id) usedIds.delete(id);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    // Calls parked on the client (custom_tool_use awaiting
    // user.custom_tool_result, always_ask awaiting user.tool_confirmation)
    // are unpaired BY DESIGN and survive DO restarts via persisted state.
    // Flushing them injected a synthetic "interrupted" result next to the
    // real one the client posts later → duplicate tool_result → provider
    // 400 "each tool_use must have a single result" + reschedule loop.
    for (const pending of this.state.pending_tool_calls ?? []) {
      usedIds.delete(pending.toolCallId);
    }
    let flushed = 0;
    for (const [id, meta] of usedIds) {
      const isMcp = meta.type === "agent.mcp_tool_use";
      const event = isMcp
        ? {
            type: "agent.mcp_tool_result" as const,
            mcp_tool_use_id: id,
            content: UNKNOWN_TOOL_RESULT_TEXT,
            is_error: true,
          }
        : {
            type: "agent.tool_result" as const,
            tool_use_id: id,
            content: UNKNOWN_TOOL_RESULT_TEXT,
            is_error: true,
          };
      const tagged = (meta.thread
        ? { ...event, session_thread_id: meta.thread }
        : event) as unknown as SessionEvent;
      try {
        await this.runtimeAdapter.eventLog.append(tagged);
        this.broadcastEvent(tagged);
        flushed++;
      } catch (err) {
        console.warn(`[finalize-stale] failed to flush tool_use ${id}:`, err);
      }
    }

    // 2. Force-end stale sessions rows. Skip turns currently held in
    //    _activeTurnIds (live work in this incarnation). Order matters:
    //    endTurn FIRST (the contract), events only on success. The
    //    earlier shape (rescheduled → endTurn → idle) emitted a
    //    rescheduled event even when endTurn threw, leaving Console
    //    showing "rescheduled" with no resolution and the row still
    //    'running'. Atomic-from-Console's-perspective: events appear
    //    iff the row actually flipped.
    const orphans = await this.runtimeAdapter.listOrphanTurns(this.state.session_id);
    let ended = 0;
    if (orphans.length > 0 || usedIds.size > 0) {
      sdoLog("finalize.scan", {
        session_id: this.state.session_id,
        orphan_turns: orphans.length,
        unpaired_tool_uses: usedIds.size,
        pending_tool_calls: this.state.pending_tool_calls?.length ?? 0,
      });
    }
    // Race window: cold-start flush is fire-and-forget from fetch();
    // the same fetch() may concurrently route a POST /event into
    // drainEventQueue → adapter.beginTurn (writes D1 row) →
    // hintTurnInFlight callback (populates _activeTurnIds). If we read
    // listOrphanTurns BETWEEN the D1 write landing and the in-memory
    // set add, the brand-new turn looks like an orphan and we'd
    // incorrectly emit rescheduled+idle for it (caught 2026-05-11
    // bench scenario 08, sess-hn5kmowudx42awm0).
    //
    // The grace period only applies to turns that began in THIS
    // incarnation (`turn_started_at >= _instanceStartedAt`). A turn
    // whose marker predates this instance is from a dead incarnation by
    // definition, even when its timestamp is only a few seconds old —
    // exactly the mid-turn isolate-reset case. Pre-fix, the age-only
    // check skipped such a turn; a fire-and-forget fetch() pass then
    // never ran again and the session stayed status_running forever.
    const FRESH_TURN_GRACE_MS = 30_000;
    const now = Date.now();
    let heldForFreshGrace = 0;
    for (const o of orphans) {
      if (this._activeTurnIds.has(o.turn_id)) {
        sdoLog("finalize.candidate", {
          session_id: this.state.session_id,
          turn_id: o.turn_id,
          decision: "skip",
          reason: "active_turn",
        });
        continue;
      }
      const startedThisIncarnation = o.turn_started_at >= this._instanceStartedAt;
      if (startedThisIncarnation && now - o.turn_started_at < FRESH_TURN_GRACE_MS) {
        heldForFreshGrace++;
        sdoLog("finalize.candidate", {
          session_id: this.state.session_id,
          turn_id: o.turn_id,
          decision: "skip",
          reason: "fresh_grace",
          age_ms: now - o.turn_started_at,
        });
        continue;
      }
      try {
        await this.runtimeAdapter.endTurn(this.state.session_id, o.turn_id, "idle");
      } catch (err) {
        console.warn(`[finalize-stale] endTurn failed for ${o.turn_id}:`, err);
        sdoLog("finalize.candidate", {
          session_id: this.state.session_id,
          turn_id: o.turn_id,
          decision: "skip",
          reason: "end_turn_failed",
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // skip event emission — row is still in old state
      }
      ended++;
      sdoLog("finalize.candidate", {
        session_id: this.state.session_id,
        turn_id: o.turn_id,
        decision: "end",
        reason: "orphan_turn",
        age_ms: now - o.turn_started_at,
      });
      const reschedEvent = {
        type: "session.status_rescheduled",
        reason: "DO eviction or restart — stream lost; re-send to continue.",
      } as unknown as SessionEvent;
      const idleEvent = { type: "session.status_idle", stop_reason: { type: "end_turn" } } as unknown as SessionEvent;
      // Events are best-effort post-cleanup; row is the source of truth.
      try { await this.runtimeAdapter.eventLog.append(reschedEvent); } catch {}
      try { this.broadcastEvent(reschedEvent); } catch {}
      try { await this.runtimeAdapter.eventLog.append(idleEvent); } catch {}
      try { this.broadcastEvent(idleEvent); } catch {}
    }
    if (heldForFreshGrace > 0) {
      // A fetch()-driven cold-start pass is fire-and-forget; make sure a
      // later pass exists to re-check the in-incarnation grace window. The
      // multiplexer merges this with any heartbeat/schedule wake instead of
      // clobbering it.
      try {
        await this._multiplexAlarm({
          reason: "turn_grace_retry",
          atMs: now + FRESH_TURN_GRACE_MS,
        });
      } catch { /* storage alarm unavailable — alarm() path will rearm */ }
    }

    // 3. Markerless dangling-turn fallback. The pre-fix outbox path emitted
    //    session.status_running without writing sessions.turn_id, so a
    //    cold alarm saw listOrphanTurns() === [] and ended nothing. The
    //    event log is the only remaining evidence for those sessions (the
    //    exact live incident: status_running + span.model_request_start,
    //    all outbox rows completed). Close that shape too so a cold alarm
    //    flips the status back to idle.
    //
    //    Guarded by "no live work in this incarnation" plus a 5s age and
    //    an instance-start check: a turn that is merely starting in the
    //    current isolate must never be mistaken for this isolate's
    //    predecessor. D1-marked turns were already handled above.
    let markerlessEnded = 0;
    if (
      // Only when no D1-marked turn was seen at all: a markerless row is
      // one the old outbox path never stamped. If a D1 orphan existed but
      // endTurn transiently failed, leave it to the next alarm instead of
      // emitting a terminal idle for a row that still says running.
      orphans.length === 0 &&
      this._activeTurnIds.size === 0 &&
      this._executionActiveLanes.size === 0 &&
      this._draining.size === 0
    ) {
      const latest = this._latestSessionStatusEvent();
      const startedAtMs = latest === null ? 0 : latest.ts * 1000;
      if (
        latest?.type === "session.status_running" &&
        startedAtMs < this._instanceStartedAt &&
        now - startedAtMs >= 5_000
      ) {
        // Best-effort row cleanup for the markerless shape. Scoped to
        // turn_id IS NULL so it can never clobber a fresh beginTurn.
        let rowChanged = false;
        try {
          const update = await this.runtimeAdapter.sql
            .prepare(
              `UPDATE sessions
                  SET status='idle', turn_id=NULL, turn_started_at=NULL, updated_at=?
                WHERE id=? AND status='running' AND turn_id IS NULL`,
            )
            .bind(now, this.state.session_id)
            .run();
          rowChanged = (update.meta?.changes ?? 0) > 0;
        } catch (err) {
          console.warn(`[finalize-stale] markerless row cleanup failed:`, err);
        }
        if (!rowChanged) {
          // Nothing to end (a concurrent beginTurn won the race, or the
          // row was already settled). Do not emit a terminal idle for a
          // turn that is still live.
          sdoLog("finalize.candidate", {
            session_id: this.state.session_id,
            decision: "skip",
            reason: "markerless_row_not_running",
            status_ts: startedAtMs,
          });
        } else {
          const reschedEvent = {
            type: "session.status_rescheduled",
            reason: "DO eviction or restart — stream lost; re-send to continue.",
          } as unknown as SessionEvent;
          const idleEvent = { type: "session.status_idle", stop_reason: { type: "end_turn" } } as unknown as SessionEvent;
          try { await this.runtimeAdapter.eventLog.append(reschedEvent); } catch {}
          try { this.broadcastEvent(reschedEvent); } catch {}
          try { await this.runtimeAdapter.eventLog.append(idleEvent); } catch {}
          try { this.broadcastEvent(idleEvent); } catch {}
          markerlessEnded = 1;
          sdoLog("finalize.candidate", {
            session_id: this.state.session_id,
            decision: "end",
            reason: "markerless_dangling_turn",
            status_ts: startedAtMs,
          });
        }
      }
    }
    if (flushed > 0 || ended > 0 || markerlessEnded > 0) {
      console.log(`[finalize-stale] flushed ${flushed} tool_uses, ended ${ended + markerlessEnded} stale turns`);
      sdoLog("finalize.done", {
        session_id: this.state.session_id,
        flushed_tool_uses: flushed,
        ended_turns: ended + markerlessEnded,
        markerless_turns: markerlessEnded,
      });
    }

    // After flipping any stale rows to idle, kick the queue. Without this
    // queued inputs that arrived while the previous incarnation was
    // wedged sit dormant: drainEventQueue only fires on new external
    // /event POSTs, alarms only keep-alive while status='running', and
    // _finalizeStaleTurns just updates the row — nobody triggers a drain.
    // Net effect: bot goes silent in the channel until the user @-mentions
    // again to nudge the dispatcher.
    //
    // Bounded: recoverEventQueue is the same call wired to the 5s
    // schedule hook — it threadsWithQueueInputs() first and exits
    // immediately when nothing's queued. Safe to call even when we ended
    // zero stale turns (cold-start of a healthy session is a no-op).
    if (this._queue) {
      try {
        await this.recoverEventQueue();
      } catch (err) {
        console.warn(`[finalize-stale] post-recovery drain failed:`, err);
      }
    }
  }
}

// ── Schedule type (cf-agents-compatible) ───────────────────────────────
type SessionScheduleType = "scheduled" | "delayed" | "cron" | "interval";

/** OMA steering advertisement for built-in harnesses, the CF counterpart of
 *  an ACP agent's `_session/steering` capability. When enabled, mid-run
 *  user.message is absorbed via takeSteeringInputs at the next LLM/tool-call
 *  boundary (CMA coherent turn / after-call), not deferred to after-turn drain. */
export function agentAdvertisesSteering(agent: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  return agent?.metadata?.["oma.session.steering"] === "enabled";
}

/** Stdout of a CF sandbox command (`exit=N\n<stdout>`); throws on failure. */
async function sandboxStdout(sandbox: SandboxExecutor, command: string, timeoutMs: number): Promise<string> {
  const out = await sandbox.exec(command, timeoutMs);
  const match = out.match(/^exit=(\d+)\n([\s\S]*)$/);
  if (!match || match[1] !== "0") throw new Error(out.slice(0, 300));
  return match[2]!;
}

/** Binary-safe file read: SandboxExecutor.readFile is UTF-8 only, so the
 * sandbox base64-encodes and this side decodes. */
async function readSandboxFileBytes(sandbox: SandboxExecutor, path: string, timeoutMs: number): Promise<Uint8Array> {
  const encoded = (await sandboxStdout(sandbox, `base64 -w0 -- '${path.replace(/'/g, "'\\''")}' 2>&1`, timeoutMs)).trim();
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
