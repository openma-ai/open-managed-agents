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
import { loopTemplate, normalizeLoopConfig } from "./loops.js";
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
        install: (application, loops) => {
          for (const loop of loops) {
            const template = loopTemplate(loop.template);
            if (template?.provider !== "gitlab") throw new Error(`Loop ${loop.id}: ${loop.template} does not run on GitLab`);
            application.loop(template.loop, loop.config as Parameters<typeof application.loop>[1]);
          }
        },
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

const parseBaseUrl = (value: unknown): string | undefined => {
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

/**
 * Link a GitLab instance (a Bond): check the bot token against
 * `/api/v4/user` and save it. Loops configured on it later choose the
 * projects and the Agent; a request that names an Agent (the one-step flow)
 * also gets a `gitlab-mention` Loop for it.
 */
export const connectGitLab =
  (
    host: MatterHost,
    options: {
      readonly db: MatterDatabase;
      readonly publicUrl?: string;
      readonly fetch?: typeof fetch;
    },
  ) =>
  async (
    principal: FeishuConnectPrincipal,
    body: unknown,
  ): Promise<GitLabConnectResult> => {
    const input =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
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
    const token = input.token.trim();
    const doFetch = options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api/v4/user`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch {
      throw new GitLabConnectError("GitLab could not be reached", 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitLabConnectError("GitLab rejected the token", 400);
    }
    const user = (await response.json().catch(() => null)) as { username?: unknown } | null;
    if (!response.ok || typeof user?.username !== "string" || user.username === "") {
      throw new GitLabConnectError("GitLab did not return the token's user", 502);
    }
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
    const id = `gitlab-${randomBytes(8).toString("hex")}`;
    const record = await options.db.gitlab.save({
      id,
      baseUrl,
      token,
      username: user.username,
      webhookSecret: randomBytes(24).toString("base64url"),
      projectIds,
      tenantId: principal.tenantId,
      ...(principal.userId === undefined ? {} : { userId: principal.userId }),
      agentId: "",
    });
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
          username: user.username,
        }),
        enabled: true,
      });
    }
    await host.restart(GITLAB_ADAPTER_KIND, id);
    const path = `/webhooks/gitlab/${id}`;
    return {
      id,
      username: record.username,
      projectIds: record.projectIds,
      webhookUrl: options.publicUrl === undefined ? path : `${options.publicUrl}${path}`,
      webhookSecret: record.webhookSecret,
    };
  };

/**
 * `GET /connect/gitlab` lists the tenant's connections (no secrets);
 * `POST /connect/gitlab` connects one. Behind the Console proxy.
 */
export const createGitLabConnectHandler = (options: {
  readonly connect: ReturnType<typeof connectGitLab>;
  readonly db: MatterDatabase;
  readonly authorize: (request: Request) => Promise<FeishuConnectPrincipal | null>;
}) =>
  async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path !== "/connect/gitlab") return undefined;
    const principal = await options.authorize(request);
    if (principal === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.method === "GET") {
      return Response.json(
        {
          data: (await options.db.gitlab.list())
            .filter((c) => c.tenantId === principal.tenantId)
            .map((c) => ({
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
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const body: unknown = await request.json().catch(() => ({}));
    try {
      return Response.json(await options.connect(principal, body), {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      if (error instanceof GitLabConnectError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  };
