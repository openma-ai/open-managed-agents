/**
 * Minimal client for the public OpenMA HTTP API. The Matter service talks to
 * OpenMA only through this surface (sessions, session events, the event
 * stream), never through in-process ports, so it can run as its own process
 * next to any OpenMA deployment.
 */

/** The OpenMA Managed Agents API beta this client speaks. */
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

export interface OmaClientOptions {
  /** OpenMA API origin, for example `https://openma.example.com`. */
  readonly baseUrl: string;
  /** Workspace API key, sent as `x-api-key`. */
  /** A workspace API key. Without it, `headers` must authenticate. */
  readonly apiKey?: string;
  /** Sent on every request, for example the trusted-proxy headers that let
   * the Matter service act in one workspace (`matterTrustHeaders`). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

export interface OmaSession {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
  readonly archived_at?: string | null;
}

/** A stored session event as served by `GET /v1/sessions/:id/events`. */
/** A session event as the Managed Agents API returns it. Events carry an
 * `id` but no sequence number. */
export interface OmaEvent {
  readonly type: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}

export class OmaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "OmaHttpError";
  }
}

export interface CreateSessionInput {
  readonly agentId: string;
  readonly title: string;
  readonly environmentId: string;
  readonly vaultIds?: readonly string[];
}

export interface CreateBearerCredentialInput {
  readonly vaultId: string;
  readonly displayName: string;
  /** OpenMA attaches the bearer to MCP requests for this server URL. */
  readonly mcpServerUrl: string;
  readonly token: string;
}

/** A remote MCP server on an Agent (`mcp_servers`). */
export interface OmaMcpServer {
  readonly name: string;
  readonly type: string;
  readonly url?: string;
  readonly [key: string]: unknown;
}

/** An Agent tool as the API returns it; only `mcp_toolset` is read here. */
export interface OmaAgentTool {
  readonly type: string;
  readonly mcp_server_name?: string;
  readonly [key: string]: unknown;
}

export interface OmaAgent {
  readonly id: string;
  readonly version: number;
  readonly mcp_servers?: readonly OmaMcpServer[];
  readonly tools?: readonly OmaAgentTool[];
}

export interface OmaClient {
  getAgent(agentId: string): Promise<OmaAgent | null>;
  /** Replace the Agent's MCP servers and tools (each server needs an
   * `mcp_toolset`); fails with 409 on a stale version. */
  updateAgentMcp(
    agentId: string,
    version: number,
    update: {
      readonly mcp_servers: readonly OmaMcpServer[];
      readonly tools: readonly OmaAgentTool[];
    },
  ): Promise<OmaAgent>;
  createVault(name: string): Promise<{ readonly id: string }>;
  createBearerCredential(
    input: CreateBearerCredentialInput,
  ): Promise<{ readonly id: string }>;
  createSession(input: CreateSessionInput): Promise<OmaSession>;
  getSession(sessionId: string): Promise<OmaSession | null>;
  /** One environment, or null when the workspace has none with this id. */
  getEnvironment(environmentId: string): Promise<{ readonly id: string; readonly archived_at?: string | null } | null>;
  /** One vault, or null when the workspace has none with this id. */
  getVault(vaultId: string): Promise<{ readonly id: string; readonly archived_at?: string | null } | null>;
  /** The workspace's environments, newest first. */
  listEnvironments(): Promise<readonly { readonly id: string; readonly name?: string; readonly archived_at?: string | null }[]>;
  /** Sessions of one Agent whose title matches `query` (server-side search). */
  findSessions(agentId: string, query: string): Promise<readonly OmaSession[]>;
  archiveSession(sessionId: string): Promise<void>;
  /** Append events; resolves with the events as stored (with their ids). */
  sendEvents(
    sessionId: string,
    events: readonly Record<string, unknown>[],
  ): Promise<readonly OmaEvent[]>;
  /** One page of the session's event log, oldest first. */
  listEvents(
    sessionId: string,
    options?: { readonly page?: string; readonly limit?: number },
  ): Promise<{ readonly data: readonly OmaEvent[]; readonly nextPage?: string }>;
  /**
   * Stream events appended after the stream opened; nothing is replayed.
   * Resolves once the stream is open, so a caller can open it before sending
   * the event it waits for.
   */
  streamEvents(
    sessionId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AsyncIterable<OmaEvent>>;
}

export const createOmaClient = (options: OmaClientOptions): OmaClient => {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  const request = async (
    path: string,
    init: RequestInit & { readonly allow404?: boolean } = {},
  ): Promise<Response | null> => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    if (options.apiKey !== undefined) headers.set("x-api-key", options.apiKey);
    // Managed Agents routes (agents, environments, …) require the beta flag;
    // the rest ignore it.
    headers.set("anthropic-beta", MANAGED_AGENTS_BETA);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await doFetch(`${base}${path}`, { ...init, headers });
    if (response.status === 404 && init.allow404 === true) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OmaHttpError(
        response.status,
        body,
        `OpenMA ${init.method ?? "GET"} ${path} failed with ${response.status}`,
      );
    }
    return response;
  };

  const json = async <T>(response: Response | null): Promise<T | null> =>
    response === null ? null : ((await response.json()) as T);

  return {
    listEnvironments: async () =>
      ((await json<{ data?: { id: string; name?: string; archived_at?: string | null }[] }>(
        await request("/v1/environments?limit=100"),
      ))?.data ?? []),
    getEnvironment: async (environmentId) =>
      json<{ id: string; archived_at?: string | null }>(
        await request(`/v1/environments/${encodeURIComponent(environmentId)}`, { allow404: true }),
      ),
    getVault: async (vaultId) =>
      json<{ id: string; archived_at?: string | null }>(
        await request(`/v1/vaults/${encodeURIComponent(vaultId)}`, { allow404: true }),
      ),
    getAgent: async (agentId) =>
      json<OmaAgent>(
        await request(`/v1/agents/${encodeURIComponent(agentId)}`, {
          allow404: true,
        }),
      ),
    updateAgentMcp: async (agentId, version, update) =>
      (await json<OmaAgent>(
        await request(`/v1/agents/${encodeURIComponent(agentId)}`, {
          method: "POST",
          body: JSON.stringify({ version, ...update }),
        }),
      )) as OmaAgent,
    createVault: async (name) =>
      (await json<{ id: string }>(
        await request("/v1/vaults", {
          method: "POST",
          body: JSON.stringify({ display_name: name }),
        }),
      )) as { id: string },
    createBearerCredential: async (input) =>
      (await json<{ id: string }>(
        await request(
          `/v1/vaults/${encodeURIComponent(input.vaultId)}/credentials`,
          {
            method: "POST",
            body: JSON.stringify({
              display_name: input.displayName,
              auth: {
                type: "static_bearer",
                mcp_server_url: input.mcpServerUrl,
                token: input.token,
              },
            }),
          },
        ),
      )) as { id: string },
    createSession: async (input) => {
      const session = await json<OmaSession>(
        await request("/v1/sessions", {
          method: "POST",
          body: JSON.stringify({
            agent: input.agentId,
            title: input.title,
            environment_id: input.environmentId,
            ...(input.vaultIds === undefined || input.vaultIds.length === 0
              ? {}
              : { vault_ids: input.vaultIds }),
          }),
        }),
      );
      return session as OmaSession;
    },
    getSession: async (sessionId) =>
      json<OmaSession>(
        await request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
          allow404: true,
        }),
      ),
    findSessions: async (agentId, query) => {
      const params = new URLSearchParams({
        agent_id: agentId,
        q: query,
        limit: "20",
      });
      const page = await json<{ data?: OmaSession[] }>(
        await request(`/v1/sessions?${params.toString()}`),
      );
      return page?.data ?? [];
    },
    archiveSession: async (sessionId) => {
      await request(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, {
        method: "POST",
        allow404: true,
      });
    },
    sendEvents: async (sessionId, events) => {
      const sent = await json<{ data?: OmaEvent[] }>(
        await request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "POST",
          body: JSON.stringify({ events }),
        }),
      );
      return sent?.data ?? [];
    },
    listEvents: async (sessionId, { page, limit } = {}) => {
      const params = new URLSearchParams({ order: "asc", limit: String(limit ?? 100) });
      if (page !== undefined) params.set("page", page);
      const result = await json<{ data?: OmaEvent[]; next_page?: string | null }>(
        await request(
          `/v1/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`,
        ),
      );
      return {
        data: result?.data ?? [],
        ...(typeof result?.next_page === "string" && result.next_page !== ""
          ? { nextPage: result.next_page }
          : {}),
      };
    },
    streamEvents: async (sessionId, { signal } = {}) => {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
      };
      const response = await request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`,
        { headers, ...(signal === undefined ? {} : { signal }) },
      );
      if (response?.body == null) {
        throw new Error("OpenMA event stream has no body");
      }
      return parseSse(response.body);
    },
  };
};

/** Parse `data:` frames of a text/event-stream body into JSON events.
 * Comments, `event:`, `id:` and `retry:` lines are ignored; every event
 * carries its own `id` and `type` in the JSON payload. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OmaEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) {
            const event = parseFrame(data.join("\n"));
            data = [];
            if (event !== undefined) yield event;
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const parseFrame = (text: string): OmaEvent | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { type?: unknown }).type === "string"
      ? (value as OmaEvent)
      : undefined;
  } catch {
    return undefined;
  }
};
