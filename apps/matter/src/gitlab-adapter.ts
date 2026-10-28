/**
 * GitLab as a Matter adapter. A connection (a GitLab Bond) is one GitLab
 * instance and the bot user whose token posts the replies; GitLab sends
 * project webhooks to `POST /webhooks/gitlab/<id>`, checked against the
 * connection's own secret, and the Loops users configured on it
 * (`gitlab-mention`, `gitlab-mr-review`) act on them. A webhook is answered 202 only once it is in the durable inbox, so
 * GitLab retries anything that was not.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { ReceivedEnvelope } from "@openma/matter-host-local/runtime";
import {
  decodeGitLabHttpRequest,
  makeGitLabIntegration,
} from "@openma/matter-gitlab/bond";
import { Effect } from "effect";
import {
  connectionRevision,
  enabledLoopsByBond,
  type MatterAdapter,
  type MatterConnection,
} from "./adapter.js";
import { installLoops, normalizeLoopConfig } from "./loops.js";
import type { FeishuConnectPrincipal } from "./feishu-connect.js";
import type { MatterHost } from "./host.js";
import type { GitLabConnectionRecord, LoopRecord, MatterDatabase } from "./persistence.js";

export type GitLabConnection = GitLabConnectionRecord & MatterConnection;

export const GITLAB_ADAPTER_KIND = "gitlab";

const asConnection = (record: GitLabConnectionRecord, loops: readonly LoopRecord[]): GitLabConnection => ({
  ...record,
  key: record.id,
  label: `GitLab ${record.username}@${new URL(record.baseUrl).host}`,
  loops,
  revision: connectionRevision(record.connectedAt, loops),
});

/** Accepts webhooks for the connections that are running. */
type Submit = (envelope: Omit<ReceivedEnvelope, "ack">) => Promise<boolean>;

export interface GitLabAdapter extends MatterAdapter<GitLabConnection> {
  /** Persist one webhook delivery; false when the connection is not running
   * or the inbox did not take it. */
  readonly submit: (key: string, envelope: Omit<ReceivedEnvelope, "ack">) => Promise<boolean>;
}

export const createGitLabAdapter = (options: {
  readonly db: MatterDatabase;
  readonly fetch?: typeof fetch;
}): GitLabAdapter => {
  const submitters = new Map<string, Submit>();
  return {
    kind: GITLAB_ADAPTER_KIND,
    list: async () => {
      const loops = enabledLoopsByBond(await options.db.loops.list(), GITLAB_ADAPTER_KIND);
      return (await options.db.gitlab.list()).map((r) => asConnection(r, loops.get(r.id) ?? []));
    },
    get: async (key) => {
      const record = await options.db.gitlab.get(key);
      if (record === undefined) return undefined;
      const loops = (await options.db.loops.listForBond(GITLAB_ADAPTER_KIND, key)).filter((l) => l.enabled);
      return asConnection(record, loops);
    },
    submit: async (key, envelope) => (await submitters.get(key)?.(envelope)) ?? false,
    wire: (connection) => {
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
      return {
        integrations: {
          gitlab: makeGitLabIntegration({
            credentials: { baseUrl: connection.baseUrl, token: connection.token },
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        },
        install: (application, loops) => installLoops(application, loops, "gitlab"),
        source: {
          start: async (onEnvelope) => {
            deliver = onEnvelope;
          },
          stop: async () => {
            deliver = undefined;
          },
        },
      };
    },
  };
};

const PATH = /^\/webhooks\/gitlab\/([A-Za-z0-9_-]+)$/;

/**
 * `POST /webhooks/gitlab/<id>`, called by GitLab directly (not through the
 * Console proxy). The connection's webhook secret authenticates it.
 */
export const createGitLabWebhookHandler = (
  adapter: GitLabAdapter,
  /** Start a connection this replica does not run yet (another replica
   * saved it since the last reconcile); true when it now runs. */
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
    const decoded = await Effect.runPromise(
      Effect.either(
        decodeGitLabHttpRequest(request, {
          webhookToken: connection.webhookSecret,
          authority: key,
        }),
      ),
    );
    if (decoded._tag === "Left") {
      return Response.json({ error: decoded.left.message }, { status: decoded.left.status });
    }
    const input = decoded.right;
    const envelope = {
      integrationId: "gitlab",
      idempotencyKey: `gitlab:${key}:${input.deliveryId}`,
      eventType: input.eventName,
      body: input,
    };
    let persisted = await adapter.submit(key, envelope);
    if (!persisted && ensure !== undefined && (await ensure(key).catch(() => false))) {
      persisted = await adapter.submit(key, envelope);
    }
    return persisted
      ? new Response(null, { status: 202 })
      : Response.json({ error: "not accepting webhooks right now" }, { status: 503 });
  };

/** What `POST /connect/gitlab` returns, once: the secret is not shown again. */
export interface GitLabConnectResult {
  readonly id: string;
  readonly username: string;
  readonly projectIds: readonly number[];
  /** Absolute when `MATTER_PUBLIC_URL` is set, otherwise the path. */
  readonly webhookUrl: string;
  readonly webhookSecret: string;
}

export class GitLabConnectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502,
  ) {
    super(message);
    this.name = "GitLabConnectError";
  }
}

const parseProjectIds = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ids = value.map((v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v));
  return ids.every((id) => Number.isSafeInteger(id) && (id as number) > 0)
    ? [...new Set(ids as number[])]
    : undefined;
};

export const parseBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
};

interface GitLabLinkOptions {
  readonly db: MatterDatabase;
  readonly publicUrl?: string;
  readonly fetch?: typeof fetch;
  /** Instances the deployment offers (`MATTER_GITLAB_URLS`). When set, new
   * Bonds may only use these or an instance the tenant linked before. */
  readonly presets?: readonly string[];
}

/** Refuse an instance the deployment does not offer, when it offers some. */
const checkAllowed = async (options: GitLabLinkOptions, tenantId: string, baseUrl: string): Promise<void> => {
  if (options.presets === undefined || options.presets.length === 0 || options.presets.includes(baseUrl)) return;
  const linked = (await options.db.gitlab.list()).some((c) => c.tenantId === tenantId && c.baseUrl === baseUrl);
  if (!linked) {
    throw new GitLabConnectError("This GitLab instance is not offered here; choose one of the listed instances", 400);
  }
};

const webhookUrlOf = (options: GitLabLinkOptions, id: string): string => {
  const path = `/webhooks/gitlab/${id}`;
  return options.publicUrl === undefined ? path : `${options.publicUrl}${path}`;
};

const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

/** A GitLab call that names no secret when the instance cannot be reached.
 * Redirects are not followed (they could lead anywhere, with the token). */
const reach = async (doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> => {
  let response: Response;
  try {
    response = await doFetch(url, { ...init, redirect: "manual" });
  } catch {
    throw new GitLabConnectError("GitLab could not be reached", 502);
  }
  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    throw new GitLabConnectError("GitLab answered with a redirect; give the instance's own root URL", 400);
  }
  return response;
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json" });

/** The username of the token's user (`/api/v4/user`). */
const tokenUser = async (doFetch: typeof fetch, baseUrl: string, token: string): Promise<string> => {
  const response = await reach(doFetch, `${baseUrl}/api/v4/user`, { headers: bearer(token) });
  if (response.status === 401 || response.status === 403) {
    throw new GitLabConnectError("GitLab rejected the token", 400);
  }
  const user = (await response.json().catch(() => null)) as { username?: unknown } | null;
  if (!response.ok || typeof user?.username !== "string" || user.username === "") {
    throw new GitLabConnectError("GitLab did not return the token's user", 502);
  }
  return user.username;
};

type TokenFacts = Pick<GitLabConnectionRecord, "tokenScopes" | "tokenExpiresAt">;

/** The token's scopes and expiry, for display only: empty when GitLab does
 * not say (an older instance, a token type without the endpoint). */
const tokenFacts = async (doFetch: typeof fetch, baseUrl: string, token: string): Promise<TokenFacts> => {
  try {
    const response = await doFetch(`${baseUrl}/api/v4/personal_access_tokens/self`, {
      headers: bearer(token),
      redirect: "manual",
    });
    if (!response.ok) return {};
    const self = (await response.json()) as { scopes?: unknown; expires_at?: unknown };
    const scopes = Array.isArray(self.scopes) && self.scopes.every((s) => typeof s === "string") ? self.scopes : undefined;
    return {
      ...(scopes === undefined ? {} : { tokenScopes: scopes as string[] }),
      ...(typeof self.expires_at === "string" && self.expires_at !== "" ? { tokenExpiresAt: self.expires_at } : {}),
    };
  } catch {
    return {};
  }
};

/** What a project bot may do. There is no write preset: nothing pushes yet. */
export const GITLAB_BOT_PRESETS = {
  /** Clone and read: enough for Loops that only read the repository. */
  read: { scopes: ["read_repository", "read_api"], accessLevel: 20 },
  /** Also post notes, as the merge request review and mention Loops do. */
  comment: { scopes: ["api"], accessLevel: 20 },
} as const satisfies Record<string, { scopes: readonly string[]; accessLevel: number }>;

export type GitLabBotPreset = keyof typeof GITLAB_BOT_PRESETS;

/** What minting a project access token needs; `userToken` is used for
 * these calls only and never kept. */
interface BotRequest {
  readonly project: number | string;
  readonly preset: GitLabBotPreset;
  readonly expiresAt: string;
  readonly userToken: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

const parseBotRequest = (input: Record<string, unknown>): BotRequest => {
  const project =
    typeof input.project === "number" || (typeof input.project === "string" && /^\d+$/.test(input.project.trim()))
      ? Number(input.project)
      : typeof input.project === "string"
        ? input.project.trim().replace(/^\/+|\/+$/g, "")
        : undefined;
  if (
    project === undefined ||
    (typeof project === "number" ? !Number.isSafeInteger(project) || project <= 0 : !/^[^/\s]+(\/[^/\s]+)+$/.test(project))
  ) {
    throw new GitLabConnectError("project must be a project id or its path, like group/name", 400);
  }
  const preset = input.preset === undefined ? "read" : input.preset;
  if (typeof preset !== "string" || !Object.keys(GITLAB_BOT_PRESETS).includes(preset)) {
    throw new GitLabConnectError("preset must be read or comment", 400);
  }
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === ""
      ? new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)
      : input.expiresAt;
  if (
    typeof expiresAt !== "string" ||
    !DATE.test(expiresAt) ||
    Number.isNaN(Date.parse(`${expiresAt}T00:00:00Z`)) ||
    new Date(`${expiresAt}T00:00:00Z`).toISOString().slice(0, 10) !== expiresAt ||
    expiresAt <= today()
  ) {
    throw new GitLabConnectError("expiresAt must be a future date as YYYY-MM-DD", 400);
  }
  if (typeof input.userToken !== "string" || input.userToken.trim() === "") {
    throw new GitLabConnectError("userToken is required", 400);
  }
  return { project, preset: preset as GitLabBotPreset, expiresAt, userToken: input.userToken.trim() };
};

/** Best effort: revoke a token Matter minted but could not link, so it does
 * not linger in GitLab. A project bot token may revoke itself. */
const revokeMinted = async (doFetch: typeof fetch, baseUrl: string, token: string): Promise<void> => {
  try {
    await doFetch(`${baseUrl}/api/v4/personal_access_tokens/self`, {
      method: "DELETE",
      headers: bearer(token),
      redirect: "manual",
    });
  } catch {
    // Left for the user to revoke; the original error is what matters.
  }
};

/**
 * Create a project access token with the user's own token: its bot user is
 * a member of that one project only. Returns the bot's token.
 */
const mintProjectBotToken = async (doFetch: typeof fetch, baseUrl: string, request: BotRequest): Promise<string> => {
  const refused = () =>
    new GitLabConnectError("GitLab rejected your token or you are not a Maintainer of the project", 400);
  const notFound = () => new GitLabConnectError(`GitLab project ${request.project} was not found`, 404);
  const headers = bearer(request.userToken);
  const found = await reach(doFetch, `${baseUrl}/api/v4/projects/${encodeURIComponent(String(request.project))}`, {
    headers,
  });
  if (found.status === 401 || found.status === 403) throw refused();
  if (found.status === 404) throw notFound();
  const project = (await found.json().catch(() => null)) as { id?: unknown } | null;
  if (!found.ok || typeof project?.id !== "number" || !Number.isSafeInteger(project.id)) {
    throw new GitLabConnectError("GitLab did not return the project", 502);
  }
  const preset = GITLAB_BOT_PRESETS[request.preset];
  const created = await reach(doFetch, `${baseUrl}/api/v4/projects/${project.id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      name: `openma-matter-${request.preset}`,
      scopes: preset.scopes,
      access_level: preset.accessLevel,
      expires_at: request.expiresAt,
    }),
  });
  if (created.status === 401 || created.status === 403) throw refused();
  if (created.status === 404) throw notFound();
  // GitLab's own message is not passed on: the instance's answers are not
  // ours to show.
  if (created.status === 400) {
    throw new GitLabConnectError(
      "GitLab refused to create the project access token (check the expiry date and your role)",
      400,
    );
  }
  const minted = (await created.json().catch(() => null)) as { token?: unknown } | null;
  if (!created.ok || typeof minted?.token !== "string" || minted.token === "") {
    throw new GitLabConnectError("GitLab did not create the project access token", 502);
  }
  return minted.token;
};

/**
 * Save a new GitLab Bond for a checked bot token. With an Agent (the
 * one-step flow) it also gets a `gitlab-mention` Loop for it.
 */
const linkGitLab =
  (host: MatterHost, options: GitLabLinkOptions) =>
  async (
    principal: FeishuConnectPrincipal,
    input: {
      readonly baseUrl: string;
      readonly token: string;
      readonly projectIds: readonly number[];
      readonly agentId?: string;
      /** Matter minted the token: revoke it if it cannot be saved. */
      readonly minted?: boolean;
    },
  ): Promise<GitLabConnectResult> => {
    const { baseUrl, token, projectIds, agentId } = input;
    const doFetch = options.fetch ?? fetch;
    const id = `gitlab-${randomBytes(8).toString("hex")}`;
    let username: string;
    let record: GitLabConnectionRecord;
    try {
      username = await tokenUser(doFetch, baseUrl, token);
      if (agentId !== undefined) {
        try {
          await host.prepareAgent(principal.tenantId, agentId);
        } catch (error) {
          if (error instanceof Error && /not found/.test(error.message)) {
            throw new GitLabConnectError(error.message, 404);
          }
          throw error;
        }
      }
      record = await options.db.gitlab.save({
        id,
        baseUrl,
        token,
        username,
        webhookSecret: randomBytes(24).toString("base64url"),
        projectIds,
        tenantId: principal.tenantId,
        ...(principal.userId === undefined ? {} : { userId: principal.userId }),
        agentId: "",
        ...(await tokenFacts(doFetch, baseUrl, token)),
      });
    } catch (error) {
      if (input.minted === true) await revokeMinted(doFetch, baseUrl, token);
      throw error;
    }
    if (agentId !== undefined) {
      await options.db.loops.save({
        id: `loop-${randomUUID()}`,
        tenantId: principal.tenantId,
        bondKind: GITLAB_ADAPTER_KIND,
        bondKey: id,
        template: "gitlab-mention",
        config: normalizeLoopConfig("gitlab-mention", {
          agentId,
          projects: projectIds.map((p) => `project:${p}`),
          username,
        }),
        enabled: true,
      });
    }
    await host.restart(GITLAB_ADAPTER_KIND, id);
    return {
      id,
      username: record.username,
      projectIds: record.projectIds,
      webhookUrl: webhookUrlOf(options, id),
      webhookSecret: record.webhookSecret,
    };
  };

/**
 * Link a GitLab instance (a Bond): check the bot token against
 * `/api/v4/user` and save it. Loops configured on it later choose the
 * projects and the Agent; a request that names an Agent (the one-step flow)
 * also gets a `gitlab-mention` Loop for it.
 */
export const connectGitLab = (host: MatterHost, options: GitLabLinkOptions) => {
  const link = linkGitLab(host, options);
  return async (principal: FeishuConnectPrincipal, body: unknown): Promise<GitLabConnectResult> => {
    const input = asObject(body);
    const baseUrl = parseBaseUrl(input.baseUrl);
    if (baseUrl === undefined) {
      throw new GitLabConnectError("baseUrl must be the instance's http(s) root URL", 400);
    }
    if (typeof input.token !== "string" || input.token.trim() === "") {
      throw new GitLabConnectError("token is required", 400);
    }
    const agentId = typeof input.agentId === "string" && input.agentId !== "" ? input.agentId : undefined;
    const projectIds = input.projectIds === undefined && agentId === undefined ? [] : parseProjectIds(input.projectIds);
    if (projectIds === undefined) {
      throw new GitLabConnectError("projectIds must be a non-empty list of project ids", 400);
    }
    await checkAllowed(options, principal.tenantId, baseUrl);
    return link(principal, {
      baseUrl,
      token: input.token.trim(),
      projectIds,
      ...(agentId === undefined ? {} : { agentId }),
    });
  };
};

/**
 * `POST /connect/gitlab/bot`: create a project bot with the user's own
 * token (Maintainer of the project, `api` scope) and link it as
 * `POST /connect/gitlab` does. The user's token is not kept.
 */
export const createGitLabBot = (host: MatterHost, options: GitLabLinkOptions) => {
  const link = linkGitLab(host, options);
  return async (principal: FeishuConnectPrincipal, body: unknown): Promise<GitLabConnectResult> => {
    const input = asObject(body);
    const baseUrl = parseBaseUrl(input.baseUrl);
    if (baseUrl === undefined) {
      throw new GitLabConnectError("baseUrl must be the instance's http(s) root URL", 400);
    }
    const request = parseBotRequest(input);
    await checkAllowed(options, principal.tenantId, baseUrl);
    const token = await mintProjectBotToken(options.fetch ?? fetch, baseUrl, request);
    return link(principal, { baseUrl, token, projectIds: [], minted: true });
  };
};

/** What replacing a Bond's token returns; the webhook secret stays as it was
 * and is not shown again. */
export interface GitLabReplaceTokenResult {
  readonly id: string;
  readonly username: string;
  readonly webhookUrl: string;
  readonly tokenScopes?: readonly string[];
  readonly tokenExpiresAt?: string;
}

/**
 * `PUT /connect/gitlab/<id>/token`: give a Bond a new bot token, pasted
 * (`token`) or minted for a project (`userToken`, as `POST
 * /connect/gitlab/bot`). The Bond keeps its id, webhook and Loops; the
 * connection starts again with the new token.
 */
export const replaceGitLabToken =
  (host: MatterHost, options: GitLabLinkOptions) =>
  async (principal: FeishuConnectPrincipal, id: string, body: unknown): Promise<GitLabReplaceTokenResult> => {
    const record = await options.db.gitlab.get(id);
    if (record === undefined || record.tenantId !== principal.tenantId) {
      throw new GitLabConnectError("GitLab Bond not found", 404);
    }
    const input = asObject(body);
    const pasted = typeof input.token === "string" && input.token.trim() !== "" ? input.token.trim() : undefined;
    if ((pasted === undefined) === (input.userToken === undefined)) {
      throw new GitLabConnectError("Give either token or userToken", 400);
    }
    const doFetch = options.fetch ?? fetch;
    const token = pasted ?? (await mintProjectBotToken(doFetch, record.baseUrl, parseBotRequest(input)));
    let username: string;
    let facts: Awaited<ReturnType<typeof tokenFacts>>;
    try {
      username = await tokenUser(doFetch, record.baseUrl, token);
      facts = await tokenFacts(doFetch, record.baseUrl, token);
      // Only the Bond as it still is: one deleted meanwhile is not recreated.
      // Updating moves the Bond's revision, so every replica starts it again.
      const updated = await options.db.gitlab.updateToken(id, principal.tenantId, { token, username, ...facts });
      if (updated === undefined) throw new GitLabConnectError("GitLab Bond not found", 404);
    } catch (error) {
      if (pasted === undefined) await revokeMinted(doFetch, record.baseUrl, token);
      throw error;
    }
    if (username !== record.username) {
      // Mention Loops answer the bot's username; follow the new bot user.
      for (const loop of await options.db.loops.listForBond(GITLAB_ADAPTER_KIND, id)) {
        if (loop.template !== "gitlab-mention" || loop.config.username !== record.username) continue;
        const { createdAt: _c, updatedAt: _u, ...rest } = loop;
        await options.db.loops.save({ ...rest, config: { ...loop.config, username } });
      }
    }
    await host.restart(GITLAB_ADAPTER_KIND, id);
    return { id, username, webhookUrl: webhookUrlOf(options, id), ...facts };
  };

/**
 * `GET /connect/gitlab` lists the tenant's connections (no secrets);
 * `POST /connect/gitlab` connects one; `POST /connect/gitlab/bot` creates a
 * project bot and connects it; `PUT /connect/gitlab/<id>/token` replaces a
 * connection's token. Behind the Console proxy.
 */
export const createGitLabConnectHandler = (options: {
  readonly connect: ReturnType<typeof connectGitLab>;
  readonly createBot: ReturnType<typeof createGitLabBot>;
  readonly replaceToken: ReturnType<typeof replaceGitLabToken>;
  readonly db: MatterDatabase;
  readonly authorize: (request: Request) => Promise<FeishuConnectPrincipal | null>;
  /** Instances the deployment offers every workspace (`MATTER_GITLAB_URLS`). */
  readonly presets?: readonly string[];
}) =>
  async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const replace = /^\/connect\/gitlab\/([A-Za-z0-9_-]+)\/token$/.exec(path);
    if (path !== "/connect/gitlab" && path !== "/connect/gitlab/bot" && replace === null) return undefined;
    const principal = await options.authorize(request);
    if (principal === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (path === "/connect/gitlab" && request.method === "GET") {
      const mine = (await options.db.gitlab.list()).filter((c) => c.tenantId === principal.tenantId);
      return Response.json(
        {
          // The deployment's instances first, then the ones this workspace
          // linked before, so the form can offer them instead of a blank URL.
          instances: [...new Set([...(options.presets ?? []), ...mine.map((c) => c.baseUrl)])],
          data: mine.map((c) => ({
              id: c.id,
              baseUrl: c.baseUrl,
              username: c.username,
              webhookPath: `/webhooks/gitlab/${c.id}`,
              connectedAt: c.connectedAt,
            })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method !== (replace === null ? "POST" : "PUT")) {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const body: unknown = await request.json().catch(() => ({}));
    try {
      const [result, status] =
        replace !== null
          ? [await options.replaceToken(principal, replace[1]!, body), 200]
          : [await (path === "/connect/gitlab/bot" ? options.createBot : options.connect)(principal, body), 201];
      return Response.json(result, { status, headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof GitLabConnectError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  };
