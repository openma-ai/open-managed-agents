import { randomUUID } from "node:crypto";
import { Hono, type Context, type Env } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

/** Opt-in transport adapter. All state, authorization and execution stay in OMA. */
type NativeFetch = (request: Request) => Response | Promise<Response>;
const object = z.record(z.string(), z.unknown());
type Row = z.infer<typeof object>;
const metadata = z.record(z.string().max(64), z.string().max(512))
  .refine((value) => Object.keys(value).length <= 16);
const text = z.object({ type: z.literal("text"), text: z.string() }).strict();
const environmentInput = z.object({
  name: z.string().min(1).max(256), description: z.string().max(2048).optional(),
  config: z.union([
    z.object({ type: z.literal("cloud"),
      networking: z.union([
        z.object({ type: z.literal("unrestricted") }).strict(),
        z.object({ type: z.literal("limited"), allowed_hosts: z.array(z.string()).optional(),
          allow_mcp_servers: z.boolean().optional(), allow_package_managers: z.boolean().optional() }).strict(),
      ]).optional(),
      packages: z.object(Object.fromEntries(
        ["apt", "cargo", "gem", "go", "npm", "pip"].map((key) => [key, z.array(z.string()).optional()]),
      )).strict().optional(),
    }).strict(),
    z.object({ type: z.literal("self_hosted") }).strict(),
  ]), metadata: metadata.optional(),
}).strict();
const sessionInput = z.object({
  agent_id: z.string().min(1), environment_id: z.string().min(1).max(128),
  agent_version: z.string().regex(/^[1-9]\d*$/).refine((v) => Number.isSafeInteger(Number(v))).optional(),
  title: z.string().max(256).optional(), metadata: metadata.optional(),
}).strict();
const messageInput = z.object({
  type: z.literal("next_turn").optional(),
  events: z.array(z.object({ type: z.literal("user.message"),
    data: z.object({ content: z.array(text).optional() }).strict(),
  }).strict()).min(1).max(1),
}).strict();

const interruptInput = z.object({
  // Kimi ignores scheduling mode for interrupt; it must be the only event.
  type: z.enum(["next_turn", "steer"]).optional(),
  events: z.tuple([z.object({ type: z.literal("user.interrupt"),
    data: z.object({ expected_control_epoch: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).optional() }).strict().optional(),
  }).strict()]),
}).strict();
const eventsInput = z.union([messageInput, interruptInput]);

class CompatError extends Error {
  constructor(readonly status: number, message: string, readonly param?: string) { super(message); }
}
function failure(error: unknown): Response {
  const status = error instanceof CompatError ? error.status : 500;
  const type = error instanceof CompatError && error.param ? "invalid_parameter_error" :
    ({ 400: "invalid_request_error", 401: "authentication_error", 403: "permission_denied_error",
      404: "resource_not_found_error", 409: "conflict_error", 429: "rate_limit_reached_error" } as Record<number, string>)[status] ?? "server_error";
  const requestId = randomUUID();
  return Response.json({ error: { type,
    message: error instanceof CompatError ? error.message : "KHA compatibility adapter failed",
    ...(error instanceof CompatError && error.param ? { param: error.param } : {}), request_id: requestId,
  } }, { status, headers: { "Msh-Request-Id": requestId } });
}
async function input<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new CompatError(400, "Request body must be valid JSON"); }
  const result = schema.safeParse(body);
  if (!result.success) throw new CompatError(400, result.error.issues[0].message, result.error.issues[0].path.join(".") || "body");
  return result.data;
}
function fields(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.filter((key) => row[key] != null).map((key) => [key, row[key]]));
}
function agent(row: Row): Row {
  const model = typeof row.model === "string" ? row.model : { id: object.parse(row.model).id };
  return { ...fields(row, ["id", "name", "description", "system", "created_at", "updated_at", "archived_at", "metadata"]),
    model, version: String(row.version), scope: "project" };
}
function environment(row: Row): Row {
  return { ...fields(row, ["id", "name", "description", "config", "created_at", "updated_at", "archived_at", "metadata"]), scope: "project" };
}
function session(row: Row): Row {
  const snapshot = object.parse(row.agent);
  return { ...fields(row, ["id", "environment_id", "title", "metadata", "created_at", "updated_at", "archived_at"]),
    agent_id: snapshot.id, agent: fields(agent(snapshot), ["id", "name", "description", "system", "model", "version"]),
    status: row.status === "rescheduled" ? "running" : row.status };
}
export function projectKhaEvent(row: Row): Row | null {
  const base = fields(row, ["id", "processed_at", "session_thread_id"]);
  const type = String(row.type);
  if (["user.message", "agent.message", "agent.thinking"].includes(type)) {
    return { ...base, type, data: { content: row.content ?? [] } };
  }
  if (/^session\.(status|thread_status)_(idle|running|rescheduled|terminated)$/.test(type)) {
    const stop = row.stop_reason == null ? undefined : object.parse(row.stop_reason);
    return { ...base, type: type.startsWith("session.thread_") ? "session.thread_status" : "session.status", data: {
      status: type.endsWith("_rescheduled") ? "running" : type.slice(type.lastIndexOf("_") + 1),
      ...(stop ? { stop_reason: { ...fields(stop, ["event_ids"]), type: stop.type === "interrupted" ? "canceled" : ["end_turn", "requires_action"].includes(String(stop.type)) ? stop.type : "internal_error" } } : {}),
    } };
  }
  if (type === "session.error") {
    const error = object.parse(row.error);
    return { ...base, type, data: { error_type: "internal_error", message: error.message } };
  }
  if (type === "user.interrupt" || type === "agent.thread_context_compacted") {
    return { ...base, type };
  }
  if (type === "span.model_request_start") return { ...base, type: "agent.model_started" };
  if (type === "session.thread_created") return { ...base, type, data: fields(row, ["agent_name"]) };
  if (type === "agent.custom_tool_use") return { ...base, type, data: fields(row, ["name", "input"]) };
  if (type === "agent.thread_message_received" || type === "agent.thread_message_sent") {
    return { ...base, type, data: fields(row, ["content", "from_session_thread_id", "from_agent_name", "to_session_thread_id", "to_agent_name"]) };
  }
  if (type === "agent.tool_use" || type === "agent.mcp_tool_use") {
    const permission = row.evaluated_permission === "allow" ? "always_allow"
      : row.evaluated_permission === "ask" ? "always_ask" : undefined;
    // Kimi requires a permission policy. Missing/denied is not permission to
    // execute; neither synthesize allow nor pretend this is tool_started.
    if (!permission) return null;
    return { ...base, type: "agent.tool_use", data: {
      tool_use: fields(row, ["id", "name", "input"]), evaluated_permission: permission,
      ...(type === "agent.mcp_tool_use" ? { mcp: { server_name: row.mcp_server_name } } : {}),
    } };
  }
  if (type === "agent.tool_result" || type === "agent.mcp_tool_result") {
    const content = z.array(text).safeParse(row.content ?? []);
    // Only text blocks have a verified cross-contract representation here.
    // An absent error flag is unknown, not a successful tool invocation.
    if (!content.success || typeof row.is_error !== "boolean") return null;
    return { ...base, type: "agent.tool_result", data: { tool_result: {
      tool_use_id: row.tool_use_id ?? row.mcp_tool_use_id,
      content: content.data, structured_content: content.data, is_error: row.is_error,
    } } };
  }
  // Usage/end spans, outcome/workflow events and unsupported native-only
  // events have no faithful Kimi counterpart. Omit instead of fabricating one.
  return null;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value: string): unknown {
  try { return JSON.parse(Buffer.from(value, "base64url").toString()); }
  catch { throw new CompatError(400, "Invalid opaque token", "cursor"); }
}
function cursor(sessionId: string, eventId?: unknown): string { return eventId ? encode([sessionId, eventId]) : "0"; }
function offset(rows: Row[], sessionId: string, token: string): number {
  if (token === "0") return 0;
  const pair = z.tuple([z.string(), z.string()]).safeParse(decode(token));
  const index = pair.success && pair.data[0] === sessionId ? rows.findIndex((row) => row.id === pair.data[1]) : -1;
  if (index < 0) throw new CompatError(400, "Cursor is invalid or no longer retained for this session", "cursor");
  return index + 1;
}
function query(c: Context, allowed: string[]): URLSearchParams {
  const params = new URL(c.req.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key)) throw new CompatError(400, `Unsupported spike query: ${key}`, key);
  return params;
}
function pageSize(params: URLSearchParams): number {
  const raw = params.get("page_size") ?? "50";
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 100) throw new CompatError(400, "page_size must be between 1 and 100", "page_size");
  return Number(raw);
}

export function buildKimiKhaCompatRoutes(nativeFetch: NativeFetch, options: { pollMs?: number } = {}): Hono {
  const app = new Hono();
  app.onError((error) => failure(error));
  app.notFound(() => failure(new CompatError(404, "Operation is outside the KHA spike subset")));

  // Dispatch to existing authenticated /v1 routes, never to a caller-supplied URL.
  async function native(c: Context, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(c.req.raw.headers);
    headers.set("anthropic-beta", "managed-agents-2026-04-01");
    headers.delete("content-length"); headers.delete("accept");
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await nativeFetch(new Request(`http://oma.internal/v1${path}`, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, c.req.raw.signal]) : c.req.raw.signal,
    }));
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
      throw new CompatError(response.status, typeof data.error === "string" ? data.error : data.error?.message ?? "OMA request failed");
    }
    return response;
  }
  async function json(c: Context, path: string, body?: unknown): Promise<Row> {
    return object.parse(await (await native(c, path, body)).json());
  }
  async function list(c: Context, path: string, project: (row: Row) => Row): Promise<Response> {
    const params = query(c, ["page_size", "page_token"]);
    const upstream = new URLSearchParams({ limit: String(pageSize(params)) });
    if (params.has("page_token")) upstream.set("page", params.get("page_token")!);
    const result = await json(c, `${path}?${upstream}`);
    return c.json({ items: z.array(object).parse(result.data).map(project),
      ...(result.next_page ? { next_page_token: result.next_page } : {}) });
  }
  for (const [path, project] of [["/agents", agent], ["/environments", environment], ["/sessions", session]] as const) {
    app.get(path, (c) => list(c, path, project));
    app.get(`${path}/:id`, async (c) => {
      query(c, []);
      return c.json(project(await json(c, `${path}/${encodeURIComponent(c.req.param("id"))}`)));
    });
  }
  app.post("/environments", async (c) => {
    const body = await input(c, environmentInput);
    const config = body.config.type === "cloud" && body.config.packages
      ? { ...body.config, packages: { ...body.config.packages, type: "packages" } } : body.config;
    return c.json(environment(await json(c, "/environments", { ...body, config })), 201);
  });
  app.post("/sessions", async (c) => {
    const { agent_id, agent_version, ...rest } = await input(c, sessionInput);
    return c.json(session(await json(c, "/sessions", { ...rest,
      agent: agent_version ? { type: "agent", id: agent_id, version: Number(agent_version) } : agent_id,
    })), 201);
  });
  app.post("/sessions/:id/events", async (c) => {
    const body = await input(c, eventsInput);
    const path = `/sessions/${encodeURIComponent(c.req.param("id"))}`;
    const firstInput = body.events[0];
    if (firstInput.type === "user.interrupt") {
      if (firstInput.data?.expected_control_epoch !== undefined) {
        await json(c, path); // Authorize and check existence before reporting the gap.
        throw new CompatError(501, "OMA has no control_epoch fencing; expected_control_epoch cannot be enforced");
      }
      await json(c, `${path}/events`, { events: [{ type: "user.interrupt" }] });
      // Native acceptance is asynchronous. No Kimi control epoch or completed
      // cancellation is implied, and interrupt is not a queued Kimi input ID.
      return c.json({}, 202);
    }
    const result = await json(c, `${path}/events`, {
      events: [firstInput].map((event) => ({ type: event.type,
        content: event.data.content?.length ? event.data.content : [{ type: "text", text: "Continue." }],
      })),
    });
    const first = z.array(object).parse(result.data ?? [])[0];
    return c.json(first?.id ? { event_id: first.id } : {});
  });

  app.post("/sessions/:id/continue", async (c) => {
    query(c, []);
    const current = await json(c, `/sessions/${encodeURIComponent(c.req.param("id"))}`);
    if (current.status === "terminated" || current.archived_at != null) {
      throw new CompatError(409, "A terminated or archived session cannot continue");
    }
    throw new CompatError(501, "OMA has no message-free continue or durable interrupted/control_epoch state; send a new user.message to start a new turn. Native interrupt preserves queued work but does not pause it");
  });

  // Native next_page is an opaque keyset boundary. At the tail it is absent,
  // so retain the last page's START and a bounded set of already-read IDs.
  // Idle polls reread at most 100 rows, never the accumulated history. Do not
  // synthesize native cursors or use processed_at as a unique sequence.
  async function eventPage(c: Context, id: string, page?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ order: "asc", limit: "100" });
    if (page) params.set("page", page);
    const result = object.parse(await (await native(c, `/sessions/${encodeURIComponent(id)}/events?${params}`, undefined, signal)).json());
    return { rows: z.array(object).parse(result.data),
      next: result.next_page == null ? undefined : z.string().parse(result.next_page) };
  }
  async function history(c: Context, id: string) {
    const rows: Row[] = [];
    let page: string | undefined;
    for (let n = 0; n < 100; n++) {
      const result = await eventPage(c, id, page);
      rows.push(...result.rows);
      if (!result.next) return { rows, page, seen: new Set(result.rows.map((row) => row.id)) };
      page = result.next;
    }
    throw new CompatError(409, "Spike replay limit exceeded (10,000 retained events)");
  }
  app.get("/sessions/:id/events", async (c) => {
    const params = query(c, ["page_size", "page_token", "order"]);
    if (params.has("order") && params.get("order") !== "asc") throw new CompatError(400, "Only ascending history is supported", "order");
    const limit = pageSize(params), id = c.req.param("id");
    const { rows } = await history(c, id);
    const start = offset(rows, id, params.get("page_token") ?? "0");
    const page = rows.slice(start, start + limit);
    const end = cursor(id, page.at(-1)?.id ?? rows[start - 1]?.id);
    return c.json({ items: page.map(projectKhaEvent).filter((row) => row !== null), stream_cursor: end,
      ...(start + limit < rows.length ? { next_page_token: end } : {}) });
  });
  app.get("/sessions/:id/events/stream", async (c) => {
    const params = query(c, ["cursor", "include_deltas"]);
    // kha attach requests previews. Accept the hint; this adapter only has durable full events.
    if (params.has("include_deltas") && !["true", "false"].includes(params.get("include_deltas")!)) throw new CompatError(400, "include_deltas must be a boolean", "include_deltas");
    const id = c.req.param("id"), token = params.get("cursor") ?? c.req.header("Last-Event-ID") ?? "0";
    const replay = await history(c, id);
    const rows = replay.rows;
    const position = token === "now" ? rows.length : offset(rows, id, token);
    let last = cursor(id, rows[position - 1]?.id);
    c.header("Cache-Control", "no-cache"); c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      // Flush immediately, even when no events exist, so clients can send after attach.
      if (token === "now") await stream.writeSSE({ event: "control", id: last, data: JSON.stringify({ cursor: last, reason: "tail" }) });
      else await stream.write(": connected\n\n");
      let wake: (() => void) | undefined;
      // Propagate downstream cancellation to an in-flight native page request.
      const controller = new AbortController();
      stream.onAbort(() => { controller.abort(); wake?.(); });
      let page = replay.page, seen = replay.seen;
      try {
        async function write(row: Row) {
          last = cursor(id, row.id);
          const event = projectKhaEvent(row);
          if (event) await stream.writeSSE({ id: last, event: String(event.type), data: JSON.stringify(event) });
        }
        for (const row of rows.slice(position)) {
          if (stream.aborted) return;
          await write(row);
        }
        while (!stream.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.pollMs ?? 1000);
            wake = () => { clearTimeout(timer); resolve(); };
          });
          if (stream.aborted) return;
          // Drain all new pages before sleeping. The overlap is only the tail
          // page from the preceding read; memory stays bounded as the log grows.
          for (;;) {
            const result = await eventPage(c, id, page, controller.signal);
            for (const row of result.rows) {
              if (stream.aborted) return;
              if (!seen.has(row.id)) await write(row);
            }
            if (!result.next) {
              seen = new Set(result.rows.map((row) => row.id));
              break;
            }
            page = result.next;
            seen = new Set();
            if (stream.aborted) return;
          }
          await stream.write(": hb\n\n");
        }
      } catch (error) {
        if (!stream.aborted) await stream.writeSSE({ event: "error", data: await failure(error).text() });
      }
    });
  });

  async function artifacts(c: Context, id: string): Promise<Row[]> {
    const result = await json(c, `/sessions/${encodeURIComponent(id)}/outputs`);
    return z.array(object).parse(result.data).map((output) => ({
      id: `art_${encode([id, output.filename])}`, session_id: id, path: `/output/${output.filename}`,
      name: output.filename, mime_type: output.media_type, size_bytes: output.size_bytes,
      version: "1", delivered_at: output.uploaded_at,
    })).sort((a, b) => String(b.delivered_at).localeCompare(String(a.delivered_at)));
  }
  app.get("/artifacts", async (c) => {
    const params = query(c, ["session_id", "page_size", "page_token"]);
    const id = params.get("session_id");
    if (!id) throw new CompatError(400, "session_id is required by the spike", "session_id");
    const rows = await artifacts(c, id), limit = pageSize(params);
    const start = offset(rows, id, params.get("page_token") ?? "0");
    const items = rows.slice(start, start + limit);
    return c.json({ items, ...(start + limit < rows.length ? { next_page_token: cursor(id, items.at(-1)?.id) } : {}) });
  });
  for (const suffix of ["", "/content"]) app.get(`/artifacts/:id${suffix}`, async (c) => {
    query(c, []);
    const raw = c.req.param("id");
    if (!raw.startsWith("art_")) throw new CompatError(404, "Artifact not found");
    const parsed = z.tuple([z.string().min(1), z.string().min(1)]).safeParse(decode(raw.slice(4)));
    if (!parsed.success) throw new CompatError(404, "Artifact not found");
    const [id, name] = parsed.data;
    const artifact = (await artifacts(c, id)).find((item) => item.name === name);
    if (!artifact) throw new CompatError(404, "Artifact not found");
    if (!suffix) return c.json(artifact);
    return native(c, `/sessions/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}`);
  });
  app.all("*", () => failure(new CompatError(404, "Operation is outside the KHA spike subset")));
  return app;
}

/** The extra base URL is opt-in; native /v1 routes retain their original shape. */
export function mountKimiKhaCompat<E extends Env>(app: Hono<E>, enabled: boolean | undefined, nativeFetch: NativeFetch): void {
  if (enabled) app.route("/kha/v1", buildKimiKhaCompatRoutes(nativeFetch));
}
