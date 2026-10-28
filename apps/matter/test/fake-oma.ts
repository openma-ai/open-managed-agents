/**
 * In-memory stand-in for the public OpenMA API, matching its wire behavior:
 * events have ids but no sequence numbers; the SSE stream carries only
 * events appended after it opened (no replay, Last-Event-ID is ignored) and
 * does not echo user events; the event list pages oldest first.
 */

export interface FakeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Session {
  id: string;
  title: string;
  agent: string;
  environment_id?: string;
  vault_ids: string[];
  resources?: unknown[];
  status: string;
  archived_at: string | null;
  events: StoredEvent[];
  subscribers: Set<(event: StoredEvent) => void>;
}

type StoredEvent = FakeEvent & { readonly id: string };

export type Responder = (
  sessionId: string,
  event: FakeEvent,
) => readonly FakeEvent[] | undefined;

export class FakeOma {
  readonly sessions = new Map<string, Session>();
  readonly vaults = new Map<string, { name: string; credentials: unknown[] }>();
  readonly memoryStores = new Map<string, { name: string; archived_at?: string | null }>();
  readonly agents = new Map<
    string,
    {
      id: string;
      version: number;
      mcp_servers: Record<string, unknown>[];
      tools?: Record<string, unknown>[];
    }
  >();
  readonly requests: { method: string; path: string; body?: unknown; tenant?: string }[] = [];
  /** Accept the control plane's trusted-proxy headers with this secret. */
  trustSecret: string | undefined;
  environments: { id: string; archived_at?: string | null }[] = [{ id: "env_listed" }];
  apiKey = "test-key";
  responder: Responder = () => undefined;
  /** Echo user events on the stream too (the API does not promise either). */
  echoUserEvents = false;
  /** Runs when the event list is read, before it answers. */
  onList: (sessionId: string) => void = () => undefined;
  private next = 0;

  createSession(title: string, agent = "agent-1"): string {
    const id = `sesn_${++this.next}`;
    this.sessions.set(id, {
      id,
      title,
      agent,
      vault_ids: [],
      status: "idle",
      archived_at: null,
      events: [],
      subscribers: new Set(),
    });
    return id;
  }

  append(sessionId: string, event: FakeEvent): StoredEvent {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no session ${sessionId}`);
    const stored: StoredEvent = {
      ...event,
      id: typeof event.id === "string" ? event.id : `sevt_${++this.next}`,
    };
    session.events.push(stored);
    if (this.echoUserEvents || !stored.type.startsWith("user.")) {
      for (const subscriber of session.subscribers) subscriber(stored);
    }
    return stored;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const tenant = headers.get("x-oma-tenant-id") ?? undefined;
    const trusted =
      this.trustSecret !== undefined && headers.get("x-matter-proxy-secret") === this.trustSecret && tenant !== undefined;
    this.requests.push({ method, path: url.pathname + url.search, body, ...(trusted ? { tenant } : {}) });
    if (!trusted && headers.get("x-api-key") !== this.apiKey) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "v1" && parts[1] === "environments" && parts.length === 2 && method === "GET") {
      return Response.json({ data: this.environments });
    }
    if (parts[0] === "v1" && parts[1] === "environments" && parts.length === 3 && method === "GET") {
      const environment = this.environments.find((e) => e.id === parts[2]);
      return environment === undefined
        ? Response.json({ error: "Environment not found" }, { status: 404 })
        : Response.json(environment);
    }
    if (parts[0] === "v1" && parts[1] === "vaults" && parts.length === 3 && method === "GET") {
      const vault = this.vaults.get(parts[2] ?? "");
      return vault === undefined
        ? Response.json({ error: "Vault not found" }, { status: 404 })
        : Response.json({ id: parts[2], display_name: vault.name });
    }
    if (parts[0] === "v1" && parts[1] === "memory_stores" && parts.length === 3 && method === "GET") {
      // The Memory Store routes need their own beta, next to Managed Agents'.
      const betas = (headers.get("anthropic-beta") ?? "").split(",").map((b) => b.trim());
      if (!betas.includes("agent-memory-2026-07-22")) {
        return Response.json({ error: "Missing required anthropic-beta flag: agent-memory-2026-07-22" }, { status: 400 });
      }
      const store = this.memoryStores.get(parts[2] ?? "");
      return store === undefined
        ? Response.json({ error: "Memory store not found" }, { status: 404 })
        : Response.json({ id: parts[2], type: "memory_store", ...store });
    }
    if (parts[0] === "v1" && parts[1] === "vaults" && method === "POST") {
      if (parts.length === 2) {
        const displayName = (body as { display_name?: unknown }).display_name;
        if (typeof displayName !== "string" || displayName.length === 0) {
          return Response.json({ error: "display_name is required" }, { status: 400 });
        }
        const id = `vlt_${++this.next}`;
        this.vaults.set(id, { name: displayName, credentials: [] });
        return Response.json({ id }, { status: 201 });
      }
      const vault = this.vaults.get(parts[2] ?? "");
      if (vault === undefined || parts[3] !== "credentials") {
        return Response.json({ error: "Vault not found" }, { status: 404 });
      }
      vault.credentials.push(body);
      return Response.json({ id: `cred_${++this.next}` }, { status: 201 });
    }
    if (parts[0] === "v1" && parts[1] === "agents" && parts[2] !== undefined) {
      if (headers.get("anthropic-beta") !== "managed-agents-2026-04-01") {
        return Response.json({ error: "beta required" }, { status: 400 });
      }
      const agent = this.agents.get(parts[2]);
      if (agent === undefined) return Response.json({ error: "Agent not found" }, { status: 404 });
      if (method === "GET") return Response.json(agent);
      const b = body as {
        version: number;
        mcp_servers: Record<string, unknown>[];
        tools?: Record<string, unknown>[];
      };
      if (b.version !== agent.version) {
        return Response.json({ error: "version conflict" }, { status: 409 });
      }
      const tools = b.tools ?? agent.tools ?? [];
      const referenced = new Set(
        tools.filter((t) => t.type === "mcp_toolset").map((t) => t.mcp_server_name),
      );
      const unreferenced = b.mcp_servers.filter((m) => !referenced.has(m.name));
      if (unreferenced.length > 0) {
        return Response.json(
          { error: "every MCP server must be referenced by an mcp_toolset" },
          { status: 400 },
        );
      }
      agent.version += 1;
      agent.mcp_servers = b.mcp_servers;
      agent.tools = tools;
      return Response.json(agent);
    }
    if (parts[0] !== "v1" || parts[1] !== "sessions") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const id = parts[2];
    if (id === undefined) {
      if (method === "POST") {
        const b = body as {
          agent: string;
          title: string;
          environment_id?: string;
          vault_ids?: string[];
          resources?: unknown[];
        };
        if (typeof b.environment_id !== "string" || b.environment_id === "") {
          return Response.json({ error: "environment_id is required" }, { status: 400 });
        }
        const sid = this.createSession(b.title, b.agent);
        const session = this.sessions.get(sid)!;
        if (b.environment_id !== undefined) session.environment_id = b.environment_id;
        session.vault_ids = b.vault_ids ?? [];
        if (b.resources !== undefined) session.resources = b.resources;
        return Response.json(this.view(session));
      }
      const agent = url.searchParams.get("agent_id");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const data = [...this.sessions.values()]
        .filter(
          (s) =>
            s.archived_at === null &&
            (agent === null || s.agent === agent) &&
            s.title.toLowerCase().includes(q),
        )
        .map((s) => this.view(s));
      return Response.json({ data });
    }
    const session = this.sessions.get(id);
    if (session === undefined) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const action = parts.slice(3).join("/");
    if (action === "" && method === "GET") return Response.json(this.view(session));
    if (action === "archive" && method === "POST") {
      session.archived_at = new Date(0).toISOString();
      return Response.json(this.view(session));
    }
    if (action === "events" && method === "POST") {
      const events = (body as { events: FakeEvent[] }).events;
      const sent: StoredEvent[] = [];
      for (const event of events) {
        sent.push(this.append(id, event));
        const replies = this.responder(id, event) ?? [];
        // Like the harness, replies arrive after the request returns.
        queueMicrotask(() => {
          for (const reply of replies) this.append(id, reply);
        });
      }
      return Response.json({ data: sent });
    }
    if (action === "events" && method === "GET") {
      if (url.searchParams.get("order") !== "asc") {
        return Response.json({ error: "the fake only lists oldest first" }, { status: 400 });
      }
      this.onList(id);
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const start = Number(url.searchParams.get("page") ?? "0");
      const data = session.events.slice(start, start + limit);
      const end = start + data.length;
      return Response.json({
        data,
        next_page: end < session.events.length ? String(end) : null,
      });
    }
    if (action === "events/stream" && method === "GET") {
      return this.stream(session, init?.signal);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };

  private view(session: Session) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      archived_at: session.archived_at,
      vault_ids: session.vault_ids,
      environment_id: session.environment_id,
    };
  }

  private stream(session: Session, signal: AbortSignal | null | undefined): Response {
    const encoder = new TextEncoder();
    let subscriber: ((event: StoredEvent) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: StoredEvent) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ping\ndata: {}\n\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          } catch {
            // closed
          }
        };
        subscriber = send;
        session.subscribers.add(send);
        signal?.addEventListener("abort", () => {
          session.subscribers.delete(send);
          try {
            controller.close();
          } catch {
            // closed
          }
        });
      },
      cancel() {
        if (subscriber !== undefined) session.subscribers.delete(subscriber);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}
