/**
 * Slack as a Matter adapter. A connection (a Slack Bond) is one installation
 * of a Slack app in a workspace (or an Enterprise org): its bot token posts
 * the replies, and the Loops users configured on it (`slack-agent`) act on
 * its events. Events arrive two ways, whichever the Bond has credentials for:
 *
 *   - the Events API: Slack posts to `POST /webhooks/slack/<id>` (the app's
 *     Event Subscriptions and Interactivity Request URL), checked against the
 *     Bond's own signing secret and answered 200 only once the event is in
 *     the durable inbox, so Slack retries anything that was not;
 *   - Socket Mode: with an app-level token the connection holds a WebSocket
 *     to Slack and acknowledges each envelope only once it is in the inbox.
 *
 * The Bond's authority is its installation (`teamId`); an event for any
 * other authority is refused, so one Bond never answers for another.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LongConnectionSource, ReceivedEnvelope } from "@openma/matter-host-local/runtime";
import { socketModeSource, type SocketModeClientPort } from "@openma/matter-host-local";
import { IntegrationError } from "@openma/matter/integration";
import { decodeSlackHttpRequest, downloadSlackFile, makeSlackIntegration } from "@openma/matter-slack/bond";
import { SocketModeClient } from "@slack/socket-mode";
import { Effect } from "effect";
import {
  connectionRevision,
  enabledLoopsByBond,
  type MatterAdapter,
  type MatterConnection,
} from "./adapter.js";
import type { FeishuConnectPrincipal } from "./feishu-connect.js";
import type { MatterHost } from "./host.js";
import { installLoops, normalizeLoopConfig } from "./loops.js";
import { combineSources } from "./schedule.js";
import type { LoopRecord, MatterDatabase, SlackConnectionRecord } from "./persistence.js";

export type SlackConnection = SlackConnectionRecord & MatterConnection;

export const SLACK_ADAPTER_KIND = "slack";

export const SLACK_API = "https://slack.com/api";

const asConnection = (record: SlackConnectionRecord, loops: readonly LoopRecord[]): SlackConnection => ({
  ...record,
  key: record.id,
  label: `Slack ${record.teamName} (${record.teamId})`,
  loops,
  revision: connectionRevision(record.connectedAt, loops),
});

/** Accepts HTTP events for the connections that are running. */
type Submit = (envelope: Omit<ReceivedEnvelope, "ack">) => Promise<boolean>;

export interface SlackAdapter extends MatterAdapter<SlackConnection> {
  /** Persist one Events API delivery; false when the connection is not
   * running or the inbox did not take it. */
  readonly submit: (key: string, envelope: Omit<ReceivedEnvelope, "ack">) => Promise<boolean>;
}

export interface SlackAdapterOptions {
  readonly db: MatterDatabase;
  readonly fetch?: typeof fetch;
  /** Builds the Socket Mode client for an app-level token; tests pass a fake. */
  readonly createSocketClient?: (appToken: string) => SocketModeClientPort;
}

const defaultSocketClient = (appToken: string, report: (error: unknown) => void): SocketModeClientPort => {
  const client = new SocketModeClient({ appToken });
  // An EventEmitter without an `error` listener throws; report it instead.
  client.on("error", report);
  return client;
};

export const createSlackAdapter = (options: SlackAdapterOptions): SlackAdapter => {
  const submitters = new Map<string, Submit>();
  return {
    kind: SLACK_ADAPTER_KIND,
    list: async () => {
      const loops = enabledLoopsByBond(await options.db.loops.list(), SLACK_ADAPTER_KIND);
      return (await options.db.slack.list()).map((r) => asConnection(r, loops.get(r.id) ?? []));
    },
    get: async (key) => {
      const record = await options.db.slack.get(key);
      if (record === undefined) return undefined;
      const loops = (await options.db.loops.listForBond(SLACK_ADAPTER_KIND, key)).filter((l) => l.enabled);
      return asConnection(record, loops);
    },
    submit: async (key, envelope) => (await submitters.get(key)?.(envelope)) ?? false,
    wire: (connection, report) => {
      const credentials = { botToken: connection.botToken, botUserId: connection.botUserId };
      // Only this installation's events: another authority is not ours to answer.
      const credentialsFor = (authority: string) =>
        authority === connection.teamId
          ? Effect.succeed(credentials)
          : Effect.fail(
              new IntegrationError({
                message: `Slack Bond ${connection.id} does not serve authority ${authority}`,
                retryable: false,
              }),
            );
      const providerFetch = options.fetch === undefined ? {} : { fetch: options.fetch };
      let deliver: ((envelope: ReceivedEnvelope) => Promise<void>) | undefined;
      submitters.set(connection.key, async (envelope) => {
        if (deliver === undefined) return false;
        // The runtime acknowledges only after the inbox has the envelope.
        let persisted = false;
        await deliver({
          ...envelope,
          ack: async () => {
            persisted = true;
          },
        });
        return persisted;
      });
      const http: LongConnectionSource = {
        start: async (onEnvelope) => {
          deliver = onEnvelope;
        },
        stop: async () => {
          deliver = undefined;
        },
      };
      const socket =
        connection.appToken === undefined
          ? undefined
          : socketModeSource(
              options.createSocketClient?.(connection.appToken) ?? defaultSocketClient(connection.appToken, report),
            );
      return {
        integrations: {
          slack: makeSlackIntegration({ credentials: credentialsFor, ...providerFetch }).integration,
        },
        install: (application, loops) => installLoops(application, loops, "slack"),
        image: async (event, image) => {
          const source = (event.source ?? {}) as { authority?: unknown };
          return Effect.runPromise(
            downloadSlackFile({
              credentials,
              ...(typeof source.authority === "string" ? { teamId: source.authority } : {}),
              fileId: image.id,
              ...providerFetch,
            }),
          );
        },
        source: socket === undefined ? http : combineSources(http, socket),
      };
    },
  };
};

const PATH = /^\/webhooks\/slack\/([A-Za-z0-9_-]+)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What makes one Slack delivery the same on a retry. */
const deliveryId = (input: unknown): string => {
  if (isRecord(input)) {
    if (typeof input.event_id === "string" && input.event_id !== "") return input.event_id;
    if (typeof input.trigger_id === "string" && input.trigger_id !== "") return `trigger:${input.trigger_id}`;
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
};

/**
 * `POST /webhooks/slack/<id>`, called by Slack directly (not through the
 * Console proxy): Event Subscriptions and Interactivity. The connection's
 * signing secret authenticates it; URL verification is answered once the
 * signature checks.
 */
export const createSlackWebhookHandler = (
  adapter: SlackAdapter,
  /** Start a connection this replica does not run yet; true when it now runs. */
  ensure?: (key: string) => Promise<boolean>,
) =>
  async (request: Request): Promise<Response | undefined> => {
    const match = PATH.exec(new URL(request.url).pathname.replace(/\/+$/, ""));
    if (match?.[1] === undefined) return undefined;
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const key = match[1];
    const connection = await adapter.get(key);
    if (connection === undefined) return Response.json({ error: "not found" }, { status: 404 });
    if (connection.signingSecret === undefined) {
      return Response.json({ error: "this Slack Bond takes events over Socket Mode only" }, { status: 404 });
    }
    const decoded = await Effect.runPromise(
      Effect.either(decodeSlackHttpRequest(request, { signingSecret: connection.signingSecret })),
    );
    if (decoded._tag === "Left") {
      return Response.json({ error: decoded.left.message }, { status: decoded.left.status });
    }
    if (decoded.right.kind === "challenge") {
      return Response.json({ challenge: decoded.right.challenge });
    }
    const input = decoded.right.input;
    const envelope = {
      integrationId: "slack",
      idempotencyKey: `slack:${key}:${deliveryId(input)}`,
      eventType: isRecord(input) && typeof input.type === "string" ? input.type : "unknown",
      body: input,
    };
    let persisted = await adapter.submit(key, envelope);
    if (!persisted && ensure !== undefined && (await ensure(key).catch(() => false))) {
      persisted = await adapter.submit(key, envelope);
    }
    return persisted
      ? new Response(null, { status: 200 })
      : Response.json({ error: "not accepting events right now" }, { status: 503 });
  };

export class SlackConnectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = "SlackConnectError";
  }
}

export const SLACK_APP_TAKEN = "This Slack app installation is linked to another OpenMA workspace";

/** What connecting or updating a Slack Bond returns; never a secret. */
export interface SlackConnectResult {
  readonly id: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly botUserId: string;
  /** The Events API and Interactivity Request URL; absolute when
   * `MATTER_PUBLIC_URL` is set, otherwise the path. */
  readonly requestUrl: string;
  readonly events: boolean;
  readonly socketMode: boolean;
}

interface SlackLinkOptions {
  readonly db: MatterDatabase;
  readonly publicUrl?: string;
  readonly fetch?: typeof fetch;
}

const requestUrlOf = (options: Pick<SlackLinkOptions, "publicUrl">, id: string): string => {
  const path = `/webhooks/slack/${id}`;
  return options.publicUrl === undefined ? path : `${options.publicUrl}${path}`;
};

const resultOf = (options: SlackLinkOptions, record: SlackConnectionRecord): SlackConnectResult => ({
  id: record.id,
  teamId: record.teamId,
  teamName: record.teamName,
  botUserId: record.botUserId,
  requestUrl: requestUrlOf(options, record.id),
  events: record.signingSecret !== undefined,
  socketMode: record.appToken !== undefined,
});

const asObject = (body: unknown): Record<string, unknown> =>
  isRecord(body) ? body : {};

const trimmed = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

interface SlackSecrets {
  readonly botToken?: string;
  readonly signingSecret?: string;
  readonly appToken?: string;
}

const parseSecrets = (input: Record<string, unknown>): SlackSecrets => {
  const botToken = trimmed(input.botToken);
  const signingSecret = trimmed(input.signingSecret);
  const appToken = trimmed(input.appToken);
  if (botToken !== undefined && !botToken.startsWith("xoxb-")) {
    throw new SlackConnectError("botToken must be the app's Bot User OAuth Token (xoxb-…)", 400);
  }
  if (appToken !== undefined && !appToken.startsWith("xapp-")) {
    throw new SlackConnectError("appToken must be an app-level token (xapp-…) with connections:write", 400);
  }
  if (signingSecret !== undefined && !/^[0-9a-f]{16,128}$/i.test(signingSecret)) {
    throw new SlackConnectError("signingSecret must be the app's Signing Secret (hex)", 400);
  }
  return {
    ...(botToken === undefined ? {} : { botToken }),
    ...(signingSecret === undefined ? {} : { signingSecret }),
    ...(appToken === undefined ? {} : { appToken }),
  };
};

/** The installation behind a bot token (`auth.test`), and its app (`bots.info`). */
const inspectBotToken = async (
  doFetch: typeof fetch,
  botToken: string,
): Promise<Pick<SlackConnectionRecord, "teamId" | "teamName" | "botUserId" | "botId" | "appId">> => {
  const call = async (method: string, params: Record<string, string> = {}) => {
    let response: Response;
    try {
      response = await doFetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
        redirect: "manual",
      });
    } catch {
      throw new SlackConnectError("Slack could not be reached", 502);
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || body === null) throw new SlackConnectError(`Slack ${method} did not answer`, 502);
    return body;
  };
  const auth = await call("auth.test");
  if (auth.ok !== true) {
    // Slack's error codes (invalid_auth, account_inactive, …) name no secret.
    throw new SlackConnectError(`Slack rejected the bot token (${String(auth.error ?? "unknown")})`, 400);
  }
  const orgWide = auth.is_enterprise_install === true && typeof auth.enterprise_id === "string";
  const teamId = orgWide ? (auth.enterprise_id as string) : auth.team_id;
  if (typeof teamId !== "string" || teamId === "" || typeof auth.user_id !== "string" || auth.user_id === "") {
    throw new SlackConnectError("Slack did not return the token's workspace and bot user", 502);
  }
  const botId = typeof auth.bot_id === "string" && auth.bot_id !== "" ? auth.bot_id : undefined;
  let appId: string | undefined;
  if (botId !== undefined) {
    // Best effort, for display: the app id is not needed to run.
    const info = await call("bots.info", { bot: botId }).catch(() => undefined);
    const bot = isRecord(info?.bot) ? info.bot : undefined;
    if (typeof bot?.app_id === "string" && bot.app_id !== "") appId = bot.app_id;
  }
  return {
    teamId,
    teamName: typeof auth.team === "string" && auth.team !== "" ? auth.team : teamId,
    botUserId: auth.user_id,
    ...(botId === undefined ? {} : { botId }),
    ...(appId === undefined ? {} : { appId }),
  };
};

/**
 * `POST /connect/slack`: link a Slack app installation (a Bond). The bot
 * token is checked with `auth.test`; a signing secret (Events API), an
 * app-level token (Socket Mode), or both say how events arrive. Linking the
 * same installation again in the same workspace updates its Bond (same id,
 * same Loops); another workspace's installation is refused. A request that
 * names an Agent (the one-step flow) also gets a `slack-agent` Loop.
 */
export const connectSlack =
  (host: MatterHost, options: SlackLinkOptions) =>
  async (principal: FeishuConnectPrincipal, body: unknown): Promise<SlackConnectResult & { created: boolean }> => {
    const input = asObject(body);
    const secrets = parseSecrets(input);
    if (secrets.botToken === undefined) throw new SlackConnectError("botToken is required", 400);
    if (secrets.signingSecret === undefined && secrets.appToken === undefined) {
      throw new SlackConnectError("Give signingSecret (Events API), appToken (Socket Mode), or both", 400);
    }
    const agentId = trimmed(input.agentId);
    const facts = await inspectBotToken(options.fetch ?? fetch, secrets.botToken);
    const same = (await options.db.slack.list()).filter(
      (c) => c.teamId === facts.teamId && c.botUserId === facts.botUserId,
    );
    if (same.some((c) => c.tenantId !== principal.tenantId)) throw new SlackConnectError(SLACK_APP_TAKEN, 409);
    if (agentId !== undefined) {
      try {
        await host.prepareAgent(principal.tenantId, agentId);
      } catch (error) {
        if (error instanceof Error && /not found/.test(error.message)) throw new SlackConnectError(error.message, 404);
        throw error;
      }
    }
    const existing = same[0];
    const id = existing?.id ?? `slack-${randomBytes(8).toString("hex")}`;
    const record = await options.db.slack.save({
      id,
      ...facts,
      botToken: secrets.botToken,
      // Connecting again keeps an ingress it does not mention.
      ...((secrets.signingSecret ?? existing?.signingSecret) === undefined
        ? {}
        : { signingSecret: (secrets.signingSecret ?? existing?.signingSecret)! }),
      ...((secrets.appToken ?? existing?.appToken) === undefined
        ? {}
        : { appToken: (secrets.appToken ?? existing?.appToken)! }),
      tenantId: principal.tenantId,
      ...(principal.userId === undefined ? {} : { userId: principal.userId }),
    });
    if (agentId !== undefined) {
      await options.db.loops.save({
        id: `loop-${randomUUID()}`,
        tenantId: principal.tenantId,
        bondKind: SLACK_ADAPTER_KIND,
        bondKey: id,
        template: "slack-agent",
        config: normalizeLoopConfig("slack-agent", { agentId }),
        enabled: true,
      });
    }
    await host.restart(SLACK_ADAPTER_KIND, id);
    return { ...resultOf(options, record), created: existing === undefined };
  };

/**
 * `PUT /connect/slack/<id>`: rotate a Bond's credentials. Each of
 * `botToken`, `signingSecret` and `appToken` given replaces the saved one;
 * `signingSecret: null` or `appToken: null` turns that ingress off (one must
 * stay). A new bot token must belong to the same installation and bot user.
 */
export const updateSlack =
  (host: MatterHost, options: SlackLinkOptions) =>
  async (principal: FeishuConnectPrincipal, id: string, body: unknown): Promise<SlackConnectResult> => {
    const record = await options.db.slack.get(id);
    if (record === undefined || record.tenantId !== principal.tenantId) {
      throw new SlackConnectError("Slack Bond not found", 404);
    }
    const input = asObject(body);
    const secrets = parseSecrets(input);
    let facts: Awaited<ReturnType<typeof inspectBotToken>> | undefined;
    if (secrets.botToken !== undefined) {
      facts = await inspectBotToken(options.fetch ?? fetch, secrets.botToken);
      if (facts.teamId !== record.teamId || facts.botUserId !== record.botUserId) {
        throw new SlackConnectError("The new bot token belongs to another installation; link it as a new Bond", 400);
      }
    }
    const signingSecret = input.signingSecret === null ? undefined : (secrets.signingSecret ?? record.signingSecret);
    const appToken = input.appToken === null ? undefined : (secrets.appToken ?? record.appToken);
    if (signingSecret === undefined && appToken === undefined) {
      throw new SlackConnectError("Keep signingSecret (Events API), appToken (Socket Mode), or both", 400);
    }
    const { connectedAt: _c, signingSecret: _s, appToken: _a, ...rest } = record;
    // Saving moves the Bond's revision, so every replica starts it again.
    const saved = await options.db.slack.save({
      ...rest,
      ...(facts ?? {}),
      botToken: secrets.botToken ?? record.botToken,
      ...(signingSecret === undefined ? {} : { signingSecret }),
      ...(appToken === undefined ? {} : { appToken }),
    });
    await host.restart(SLACK_ADAPTER_KIND, id);
    return resultOf(options, saved);
  };

/**
 * `GET /connect/slack` lists the tenant's Slack Bonds (no secrets);
 * `POST /connect/slack` links one; `PUT /connect/slack/<id>` rotates its
 * credentials. Behind the Console proxy.
 */
export const createSlackConnectHandler = (options: {
  readonly connect: ReturnType<typeof connectSlack>;
  readonly update: ReturnType<typeof updateSlack>;
  readonly db: MatterDatabase;
  readonly publicUrl?: string;
  readonly authorize: (request: Request) => Promise<FeishuConnectPrincipal | null>;
}) =>
  async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const one = /^\/connect\/slack\/([A-Za-z0-9_-]+)$/.exec(path);
    if (path !== "/connect/slack" && one === null) return undefined;
    const principal = await options.authorize(request);
    if (principal === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    const noStore = { "cache-control": "no-store" };
    if (one === null && request.method === "GET") {
      const mine = (await options.db.slack.list()).filter((c) => c.tenantId === principal.tenantId);
      return Response.json(
        { data: mine.map((c) => ({ ...resultOf(options as SlackLinkOptions, c), connectedAt: c.connectedAt })) },
        { headers: noStore },
      );
    }
    if (request.method !== (one === null ? "POST" : "PUT")) {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const body: unknown = await request.json().catch(() => ({}));
    try {
      if (one !== null) {
        return Response.json(await options.update(principal, one[1]!, body), { headers: noStore });
      }
      const { created, ...result } = await options.connect(principal, body);
      return Response.json(result, { status: created ? 201 : 200, headers: noStore });
    } catch (error) {
      if (error instanceof SlackConnectError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  };

/** The channels the bot is in, as Bond resources (`users.conversations`). */
export const listSlackChannels = async (
  record: Pick<SlackConnectionRecord, "botToken" | "teamId">,
  query: string | null,
  doFetch: typeof fetch = fetch,
): Promise<{ id: string; kind: string; title: string }[]> => {
  const out: { id: string; kind: string; title: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const response = await doFetch(`${SLACK_API}/users.conversations?${params}`, {
      headers: { authorization: `Bearer ${record.botToken}` },
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.ok !== true) throw new Error(`Slack users.conversations failed: ${String(body?.error ?? response.status)}`);
    for (const channel of Array.isArray(body.channels) ? body.channels : []) {
      if (!isRecord(channel) || typeof channel.id !== "string") continue;
      const name = typeof channel.name === "string" ? channel.name : channel.id;
      if (query !== null && query !== "" && !name.toLowerCase().includes(query.toLowerCase())) continue;
      out.push({ id: channel.id, kind: "channel", title: `#${name}` });
    }
    const meta = isRecord(body.response_metadata) ? body.response_metadata : {};
    cursor = typeof meta.next_cursor === "string" && meta.next_cursor !== "" ? meta.next_cursor : undefined;
    if (cursor === undefined) break;
  }
  return out;
};
