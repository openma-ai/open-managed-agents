// Feishu WebSocket long-connection runner — the production event-ingest path
// for Feishu, and the driver of the `credentials_filled / awaiting_install →
// live` status flip.
//
// The Feishu provider's header (packages/feishu/src/provider.ts:10-12)
// designates THIS file as the canonical ingest path: the bot dials OUT to
// Feishu over a long-lived WebSocket, so — unlike the legacy HTTP webhook in
// apps/integrations — no public URL is needed. One outbound WS connection per
// Feishu App (Feishu's 1-live-connection model); single-replica is the
// phase-1 prerequisite.
//
// Wire protocol (ticket POST, protobuf frames, fragment reassembly,
// ping/pong, jittered reconnect) is handled by the official
// @larksuiteoapi/node-sdk's `WSClient`. We inject the SDK via a
// `FeishuWsConnectionFactory` so the runner's core (enumerate → connect →
// dedup → dispatch → flip) is fully unit-testable with a fake connection and
// no real socket.
//
// Ingest path mirrors the HTTP webhook's `handleWebhook` post-parse flow
// (packages/feishu/src/provider.ts): parseWsFrame → recordIfNew (dedup,
// mandatory because Feishu re-delivers on its 3s deadline and on reconnect)
// → attachPublication → provider.dispatchEvent → attachError on throw.
//
// Lifecycle mirrors apps/main-node/src/lib/s3-memory-poller.ts:
// `stopped` flag + `inFlight` promise + inner `.catch()` so one bad
// dispatch/reconnect never crashes main-node.

import { getLogger } from "@open-managed-agents/observability";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  HttpClient,
  NewInstallation,
  Publication,
  WebhookEventStore,
  WorkspaceId,
} from "@open-managed-agents/integrations-core";
import {
  type FeishuInstallationRepo,
  type FeishuPublicationRepo,
  FEISHU_PROVIDER_ID,
  type RawFeishuEventCallback,
  FeishuApiClient,
  FeishuProvider,
  parseWsFrame,
} from "@open-managed-agents/feishu";

import type { EventStreamHub } from "./event-stream-hub";
import { createFeishuEgressWriter } from "./feishu-egress-writer";

const log = getLogger("feishu-ws-runner");

/** Statuses whose publications the runner should keep a connection to. */
const TARGET_STATUSES = "('credentials_filled','awaiting_install','live')";

/**
 * A single outbound WS connection to one Feishu App. `start()` resolves once
 * the long-connection handshake completes (== the credential-validating
 * "test-ping") and rejects on handshake failure. The SDK maintains the
 * socket + auto-reconnect after `start()` resolves.
 */
export interface FeishuWsConnection {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Per-frame hook the connection calls for each `im.message.receive_v1`. */
export interface FeishuWsEventHandlers {
  /** `data` is the SDK's flattened event payload (untrusted). */
  onMessage(data: unknown): void;
}

/**
 * Builds a FeishuWsConnection for one App. The default implementation
 * dynamically imports @larksuiteoapi/node-sdk; tests inject a fake.
 */
export interface FeishuWsConnectionFactory {
  create(input: {
    appId: string;
    appSecret: string;
    handlers: FeishuWsEventHandlers;
  }): FeishuWsConnection;
}

export interface FeishuWsRunnerOptions {
  sql: SqlClient;
  pubs: FeishuPublicationRepo;
  installations: FeishuInstallationRepo;
  webhookEvents: WebhookEventStore;
  provider: FeishuProvider;
  /**
   * In-process event fan-out. The runner attaches a one-shot egress writer
   * per inbound message so the agent's `agent.message` reply is mirrored
   * back into Feishu without the agent having to call send tools itself.
   */
  hub: EventStreamHub;
  /** HTTP adapter backing FeishuApiClient (auto-egress send path). */
  http: HttpClient;
  nowMs?: () => number;
  /** Rescan interval; default 30s. */
  rescanMs?: number;
  /** Reconnect backoff curve; default {min:1s, max:30s}. */
  backoff?: { min: number; max: number };
  /** Default: larkConnectionFactory (dynamic SDK import). */
  connectionFactory?: FeishuWsConnectionFactory;
}

type ConnState = "starting" | "live" | "failed";

interface ConnEntry {
  appId: string;
  pubId: string;
  conn: FeishuWsConnection;
  state: ConnState;
  /** Reconnect attempts (drives exponential backoff). */
  attempts: number;
  lastAttemptMs: number;
}

interface RunnerCtx {
  connectionFactory: FeishuWsConnectionFactory;
  connections: Map<string, ConnEntry>;
  /** appIds with an in-flight ensureConnection (entry is set only after an await). */
  pending: Set<string>;
  /** appIds with an in-flight flip — serializes flips per app so two
   *  concurrent reconcile/handshake paths can't double-insert installations. */
  flipping: Set<string>;
  /** Per-App egress clients (FeishuApiClient mints/caches its own token). */
  apiClients: Map<string, FeishuApiClient>;
  now: () => number;
  backoff: { min: number; max: number };
  isStopped: () => boolean;
}

export async function startFeishuWsRunner(
  opts: FeishuWsRunnerOptions,
): Promise<{ stop: () => Promise<void> }> {
  const now = opts.nowMs ?? Date.now;
  const rescanMs = opts.rescanMs ?? 30_000;
  const backoff = opts.backoff ?? { min: 1_000, max: 30_000 };
  const connectionFactory = opts.connectionFactory ?? (await larkConnectionFactory());

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const ctx: RunnerCtx = {
    connectionFactory,
    connections: new Map(),
    pending: new Set(),
    flipping: new Set(),
    apiClients: new Map(),
    now,
    backoff,
    isStopped: () => stopped,
  };

  const tick = async () => {
    if (stopped) return;
    inFlight = reconcile(opts, ctx).catch((err) => {
      log.warn({ err, op: "feishu_ws_runner.tick_failed" }, "reconcile failed");
    });
    await inFlight;
    inFlight = null;
    if (!stopped) timer = setTimeout(tick, rescanMs);
  };

  log.info(
    { op: "feishu_ws_runner.started", rescan_ms: rescanMs },
    "feishu ws runner started",
  );
  // Kick off the first cycle on next tick so the rest of boot can finish.
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
      await Promise.all(
        [...ctx.connections.values()].map((e) => e.conn.stop().catch(() => {})),
      );
      ctx.connections.clear();
    },
  };
}

/**
 * One rescan cycle: enumerate target publications, ensure each has a live
 * (or in-flight) connection, retry failed ones once their backoff elapses,
 * and drop connections whose publication left the target set.
 */
async function reconcile(opts: FeishuWsRunnerOptions, ctx: RunnerCtx): Promise<void> {
  const rows = await opts.sql
    .prepare(
      `SELECT id, app_id, status FROM feishu_publications WHERE status IN ${TARGET_STATUSES}`,
    )
    .all<{ id: string; app_id: string | null; status: string }>();

  const seen = new Set<string>();
  for (const row of rows.results ?? []) {
    if (!row.app_id) continue;
    seen.add(row.app_id);
    const existing = ctx.connections.get(row.app_id);
    if (existing && (existing.state === "starting" || existing.state === "live")) {
      // Connection already up — but a pending row for this app may have
      // appeared after the handshake that would have flipped it (wizard
      // completed mid-connection). Flip it now so no restart is needed.
      if (row.status === "credentials_filled" || row.status === "awaiting_install") {
        requestFlip(opts, ctx, row.app_id);
      }
      continue;
    }
    if (ctx.pending.has(row.app_id)) continue; // in-flight setup
    if (existing && existing.state === "failed") {
      const wait = backoffFor(ctx.backoff, existing.attempts);
      if (ctx.now() - existing.lastAttemptMs < wait) continue; // not yet
    }
    // No entry, or a failed entry whose backoff elapsed → (re)start.
    // Detached: a slow getAppSecret/start must not block the tick.
    void ensureConnection(opts, ctx, row.app_id, row.id);
  }

  // Drop connections for publications no longer in the target set
  // (unpublished / revoked). Best-effort stop; the SDK socket closes on
  // process exit regardless.
  for (const [appId, entry] of ctx.connections) {
    if (!seen.has(appId)) {
      void entry.conn.stop().catch(() => {});
      ctx.connections.delete(appId);
    }
  }
}

function backoffFor(
  b: { min: number; max: number },
  attempts: number,
): number {
  return Math.min(b.max, b.min * 2 ** Math.min(attempts, 5));
}

/** At-most-one in-flight flip per app; failures logged, never fatal. */
function requestFlip(
  opts: FeishuWsRunnerOptions,
  ctx: RunnerCtx,
  appId: string,
): void {
  if (ctx.flipping.has(appId)) return;
  ctx.flipping.add(appId);
  void flipToLiveIfPending(opts, appId)
    .catch((err) => {
      log.warn({ err, op: "feishu_ws_runner.flip_failed", app_id: appId }, "flip failed");
    })
    .finally(() => {
      ctx.flipping.delete(appId);
    });
}

async function ensureConnection(
  opts: FeishuWsRunnerOptions,
  ctx: RunnerCtx,
  appId: string,
  pubId: string,
): Promise<void> {
  const prior = ctx.connections.get(appId);
  if (prior) void prior.conn.stop().catch(() => {});
  // Claim synchronously so a concurrent tick can't double-start the same app.
  ctx.pending.add(appId);
  try {
    const appSecret = await opts.pubs.getAppSecret(pubId);
    if (appSecret == null) {
      log.warn(
        { op: "feishu_ws_runner.no_secret", app_id: appId, pub_id: pubId },
        "no decryptable app_secret; skipping connection",
      );
      ctx.connections.delete(appId);
      return;
    }
    if (ctx.isStopped()) return;

  const conn = ctx.connectionFactory.create({
    appId,
    appSecret,
    handlers: {
      onMessage: (data) => {
        void handleMessage(opts, ctx, appId, data);
      },
    },
  });
  const entry: ConnEntry = {
    appId,
    pubId,
    conn,
    state: "starting",
    attempts: (prior?.attempts ?? 0) + 1,
    lastAttemptMs: ctx.now(),
  };
  ctx.connections.set(appId, entry);

  // Detached handshake: success → flip to live; failure → mark failed so the
  // next tick retries (the tick loop doubles as the reconnect scheduler).
  conn.start().then(
    async () => {
      if (ctx.isStopped()) return;
      entry.state = "live";
      log.info(
        { op: "feishu_ws_runner.connected", app_id: appId },
        "ws handshake ok",
      );
      requestFlip(opts, ctx, appId);
    },
    (err: unknown) => {
      if (ctx.isStopped()) return;
      entry.state = "failed";
      log.warn(
        { err: err instanceof Error ? err.message : String(err), op: "feishu_ws_runner.connect_failed", app_id: appId },
        "ws handshake failed; will retry after backoff",
      );
    },
  );
  } finally {
    // Release the setup claim; the entry (state "starting") now guards retries.
    ctx.pending.delete(appId);
  }
}

/**
 * On a successful handshake, drive `credentials_filled / awaiting_install →
 * live` by ensuring an installation row exists (no OAuth callback for Feishu
 * — the runner is the first component that can confirm a working App) and
 * binding it. Idempotent: no-op if already live.
 */
async function flipToLiveIfPending(
  opts: FeishuWsRunnerOptions,
  appId: string,
): Promise<void> {
  const pub = await opts.pubs.findByAppId(appId);
  if (!pub) {
    log.warn({ op: "feishu_ws_runner.flip_no_pub", app_id: appId }, "publication vanished before flip");
    return;
  }
  if (pub.status !== "credentials_filled" && pub.status !== "awaiting_install") {
    return; // already live (or revoked/unpublished) — leave as-is
  }
  let installationId =
    pub.installationId && pub.installationId.length > 0 ? pub.installationId : null;
  if (!installationId) {
    const existing = await opts.installations.findByAppId(appId);
    installationId = existing?.id ?? null;
  }
  if (!installationId) {
    const created = await opts.installations.insert(newFeishuInstallation(pub, appId));
    installationId = created.id;
  }
  await opts.pubs.bindInstallation({ publicationId: pub.id, installationId });
  log.info(
    { op: "feishu_ws_runner.flipped_live", app_id: appId, publication_id: pub.id, installation_id: installationId },
    "publication flipped to live",
  );
}

function newFeishuInstallation(pub: Publication, appId: string): NewInstallation {
  // Feishu Apps have no Slack/GitHub-style workspace; the App id IS the
  // natural workspace key. tenant_access_token is minted on demand from the
  // App secret (FeishuApiClient), so no OAuth access/refresh token is
  // persisted here — the installation row mainly carries the cached token +
  // installation_id binding.
  return {
    tenantId: pub.tenantId,
    userId: pub.userId,
    providerId: FEISHU_PROVIDER_ID,
    workspaceId: appId as unknown as WorkspaceId,
    workspaceName: appId,
    installKind: "dedicated",
    appId,
    botUserId: "",
    accessToken: "",
    refreshToken: null,
    scopes: [],
  } as unknown as NewInstallation;
}

/**
 * Handle one inbound frame: reconstruct the nested v2.0 envelope from the
 * SDK's flattened `data`, parse it, dedup, dispatch. Mirrors the HTTP
 * webhook's deferredWork so both ingest paths are identical downstream.
 */
async function handleMessage(
  opts: FeishuWsRunnerOptions,
  ctx: RunnerCtx,
  appId: string,
  data: unknown,
): Promise<void> {
  if (ctx.isStopped()) return;
  const event = parseWsFrame(reconstructEnvelope(data));
  if (!event) {
    log.debug({ op: "feishu_ws_runner.unparseable", app_id: appId }, "unparseable ws frame; dropping");
    return;
  }
  // Resolve the publication fresh — status / installation_id may have changed
  // since the connection was opened.
  const pub = await opts.pubs.findByAppId(appId);
  if (!pub) {
    log.warn({ op: "feishu_ws_runner.unknown_app", app_id: appId }, "no publication for app_id");
    return;
  }
  // Dedup: Feishu re-delivers on its 3s processing deadline AND on reconnect.
  const isNew = await opts.webhookEvents.recordIfNew(
    event.deliveryId,
    pub.tenantId,
    pub.installationId,
    event.kind,
    ctx.now(),
  );
  if (!isNew) return;
  await opts.webhookEvents.attachPublication(event.deliveryId, pub.id);
  let routed: { sessionId: string } | null = null;
  try {
    routed = await opts.provider.dispatchEvent(event, pub);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await opts.webhookEvents.attachError(event.deliveryId, msg);
    log.warn(
      { err: msg, op: "feishu_ws_runner.dispatch_failed", delivery_id: event.deliveryId },
      "dispatch failed",
    );
  }
  if (routed && event.chatId) {
    attachFeishuEgress(opts, ctx, appId, pub.id, routed.sessionId, event.deliveryId);
  }
}

/**
 * Mirror the agent's reply back into Feishu. Resolves (and caches) the App's
 * FeishuApiClient, then subscribes a one-shot egress writer to the session's
 * `agent.message` events. Best-effort and fully detached: a missing secret,
 * a 401, or a send failure logs and moves on — inbound delivery already
 * succeeded, so egress must never throw back into the message handler.
 */
function attachFeishuEgress(
  opts: FeishuWsRunnerOptions,
  ctx: RunnerCtx,
  appId: string,
  pubId: string,
  sessionId: string,
  replyToMessageId: string,
): void {
  void (async () => {
    const client = await getEgressClient(opts, ctx, appId, pubId);
    if (!client) return;
    // hub.attach returns the unsubscribe; hand it to the writer's onDone so the
    // writer removes itself from the hub once it has sent (or timed out).
    const unsubscribe = opts.hub.attach(
      sessionId,
      createFeishuEgressWriter({
        client,
        messageId: replyToMessageId,
        onDone: () => unsubscribe(),
      }),
    );
  })();
}

/** Resolve (and cache) one FeishuApiClient per App; null if no decryptable secret. */
async function getEgressClient(
  opts: FeishuWsRunnerOptions,
  ctx: RunnerCtx,
  appId: string,
  pubId: string,
): Promise<FeishuApiClient | null> {
  const cached = ctx.apiClients.get(appId);
  if (cached) return cached;
  const appSecret = await opts.pubs.getAppSecret(pubId);
  if (!appSecret) {
    log.warn(
      { op: "feishu_egress.no_secret", app_id: appId, pub_id: pubId },
      "no decryptable app_secret; skipping egress",
    );
    return null;
  }
  const client = new FeishuApiClient({ appId, appSecret }, opts.http);
  ctx.apiClients.set(appId, client);
  return client;
}

/**
 * Reconstruct the nested `{schema, header, event}` envelope the parser
 * expects from the SDK's flattened handler payload. The SDK spreads `…header`
 * and `…event` to the top level, but the nested `message`/`sender`/`chat`
 * objects survive intact (see spikes/feishu-echo/src/lark.ts). `data` is
 * untrusted SDK output — treated as a record and narrowed by parseWsFrame.
 */
function reconstructEnvelope(data: unknown): RawFeishuEventCallback {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted SDK payload, narrowed immediately by parseWsFrame
  const d = (data ?? {}) as Record<string, any>;
  return {
    schema: typeof d.schema === "string" ? d.schema : "2.0",
    header: {
      event_type: d.event_type ?? d.type ?? "im.message.receive_v1",
      event_id: d.event_id,
      app_id: d.app_id,
      tenant_key: d.tenant_key,
      create_time: d.create_time,
      token: d.token,
    },
    event: { sender: d.sender, message: d.message, chat: d.chat },
  } as RawFeishuEventCallback;
}

/**
 * Default connection factory — encapsulates @larksuiteoapi/node-sdk's
 * WSClient + EventDispatcher. Dynamically imported (like the S3 poller's
 * @aws-sdk/client-s3 import) so the SDK stays out of the hot module-load
 * path and unit tests can inject a fake without it.
 */
export async function larkConnectionFactory(): Promise<FeishuWsConnectionFactory> {
  // Minimal structural view of the SDK surface we use — decouples us from
  // version-to-version type drift in @larksuiteoapi/node-sdk.
  interface LarkModule {
    WSClient: new (opts: {
      appId: string;
      appSecret: string;
      loggerLevel?: number;
    }) => { start(args: { eventDispatcher: unknown }): Promise<void>; close?: () => void };
    EventDispatcher: new (opts: Record<string, unknown>) => {
      register(map: Record<string, (data: unknown) => unknown>): unknown;
    };
    LoggerLevel: { warn: number };
  }
  const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkModule;

  return {
    create({ appId, appSecret, handlers }) {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data) => {
          handlers.onMessage(data);
          return Promise.resolve();
        },
      });
      let wsClient: { start(args: { eventDispatcher: unknown }): Promise<void>; close?: () => void } | null = null;
      return {
        async start() {
          wsClient = new lark.WSClient({
            appId,
            appSecret,
            loggerLevel: lark.LoggerLevel.warn,
          });
          // start() resolves once the long-connection handshake completes.
          await wsClient.start({ eventDispatcher });
        },
        async stop() {
          // The SDK has no reliable graceful close in 1.73.x; best-effort.
          try {
            wsClient?.close?.();
          } catch {
            /* best-effort — the socket closes on process exit anyway */
          }
          wsClient = null;
        },
      };
    },
  };
}
