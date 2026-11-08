import { buildObservation, type NormalizeContext, type ParityObservation } from "./normalize";
import { parityModels, RUN_SUFFIX_SEPARATOR, type ParityModelStep } from "./models";

/** The only thing a platform gives a scenario: its public HTTP surface. */
export type PublicFetch = (request: Request) => Promise<Response>;

/**
 * Headers of the official Managed Agents API (`/v1/*`). No anthropic-beta:
 * the server stopped requiring it (2361d560), and headers are not observed.
 */
export const PUBLIC_HEADERS = {
  "content-type": "application/json",
} as const;

/** Harness id every runner registers: AI SDK DefaultHarness over parityModels. */
export const PARITY_HARNESS = "platform-parity";
/** Model id every runner backs with a model card pointing at an unreachable host. */
export const PARITY_MODEL = "parity-model";
export const UNREACHABLE_MODEL_BASE_URL = "http://parity-model.invalid";

export interface JsonResponse {
  status: number;
  body: any;
}

const POLL_MS = 40;
const WAIT_MS = 15_000;
const SETTLE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What a scenario may do. Everything goes through the public API; the only
 * other input is the scripted model, keyed by agent name.
 */
export class ScenarioContext {
  readonly runSuffix: string;
  private readonly knownIds = new Map<string, string>();
  private readonly reads: Record<string, unknown> = {};
  private readonly timeouts: string[] = [];
  private readonly eventsFailures = new Set<string>();
  private readonly batches: string[][] = [];
  private sessionId: string | null = null;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly fetchPublic: PublicFetch,
    headers: Record<string, string> = {},
    options: { hostPaths?: Record<string, string> } = {},
  ) {
    this.runSuffix = `${RUN_SUFFIX_SEPARATOR}${Math.random().toString(36).slice(2, 10)}`;
    this.headers = { ...PUBLIC_HEADERS, ...headers };
    parityModels.reset(this.runSuffix);
    for (const [concrete, placeholder] of Object.entries(options.hostPaths ?? {})) this.name(concrete, placeholder);
  }

  /** Remember a concrete id under a stable placeholder for normalisation. */
  name(concrete: string | undefined, placeholder: string): void {
    if (concrete) this.knownIds.set(concrete, `<${placeholder}>`);
  }

  models(agentName: string, steps: ParityModelStep[]): void {
    parityModels.install(agentName, steps);
  }

  async request(method: string, path: string, body?: unknown): Promise<JsonResponse> {
    const response = await this.fetchPublic(new Request(`http://parity.local${path}`, {
      method,
      headers: this.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }

  /** Record a public read for the observation. */
  record(key: string, value: unknown): void {
    this.reads[key] = value;
  }

  async environment(): Promise<string> {
    const created = await this.request("POST", "/v1/environments", {
      name: `parity-env${this.runSuffix}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    if (created.status !== 201) throw new Error(`environment create: ${created.status} ${JSON.stringify(created.body)}`);
    this.name(created.body.id, "environment");
    return created.body.id;
  }

  async agent(name: string, body: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
    const created = await this.request("POST", "/v1/agents", {
      name: `${name}${this.runSuffix}`,
      model: PARITY_MODEL,
      system: "You are a platform parity scenario.",
      tools: [{ type: "agent_toolset_20260401" }],
      _oma: { harness: PARITY_HARNESS },
      ...body,
    });
    if (created.status !== 201) throw new Error(`agent ${name} create: ${created.status} ${JSON.stringify(created.body)}`);
    this.name(created.body.id, `agent:${name}`);
    return { id: created.body.id, version: created.body.version };
  }

  async session(agent: { id: string; version: number }, body: Record<string, unknown> = {}): Promise<string> {
    const environmentId = await this.environment();
    const created = await this.request("POST", "/v1/sessions", {
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environmentId,
      ...body,
    });
    this.record("session_create_status", created.status);
    if (created.status !== 201) throw new Error(`session create: ${created.status} ${JSON.stringify(created.body)}`);
    this.sessionId = created.body.id;
    this.name(created.body.id, "session");
    return created.body.id;
  }

  /** `/v1/sessions/<current session><suffix>`. */
  sessionPath(suffix = ""): string {
    return `/v1/sessions/${this.requireSession()}${suffix}`;
  }

  private requireSession(): string {
    if (this.sessionId === null) throw new Error("scenario has no session");
    return this.sessionId;
  }

  async send(events: unknown[], label = "send"): Promise<number> {
    const types = events.map((event) => String((event as { type?: unknown }).type));
    if (new Set(types).size > 1) this.batches.push(types);
    const sent = await this.request("POST", `/v1/sessions/${this.requireSession()}/events`, { events });
    this.record(`${label}_status`, sent.status);
    return sent.status;
  }

  async message(text: string, label = "message"): Promise<number> {
    return this.send([{ type: "user.message", content: [{ type: "text", text }] }], label);
  }

  async events(): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = [];
    let page: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const query = new URLSearchParams({ limit: "500", order: "asc" });
      if (page) query.set("page", page);
      const listed = await this.request("GET", `/v1/sessions/${this.requireSession()}/events?${query}`);
      if (listed.status !== 200) {
        // A failing public read is behaviour to compare, not a harness error.
        const message = String(listed.body?.error?.message ?? listed.body ?? "").split(";")[0]!
          .replace(/\bdata\.\d+\b/u, "data.<n>");
        const failure = `events list ${listed.status} ${listed.body?.error?.type ?? "error"}: ${message}`;
        this.eventsFailures.add(failure);
        return all;
      }
      const rows = (listed.body?.data ?? []) as Array<Record<string, unknown>>;
      all.push(...rows.map((row) => (row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : row)));
      page = listed.body?.next_page ?? undefined;
      if (!page) break;
    }
    return all;
  }

  /** Wait until `predicate` holds and the stream stops growing. Never throws. */
  async waitFor(label: string, predicate: (events: Array<Record<string, unknown>>) => boolean): Promise<boolean> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      const events = await this.events();
      if (predicate(events)) {
        let count = events.length;
        let stableSince = Date.now();
        while (Date.now() - stableSince < SETTLE_MS && Date.now() < deadline + SETTLE_MS) {
          await sleep(POLL_MS);
          const next = (await this.events()).length;
          if (next !== count) {
            count = next;
            stableSince = Date.now();
          }
        }
        return true;
      }
      await sleep(POLL_MS);
    }
    this.timeouts.push(label);
    return false;
  }

  /** Wait for the n-th `session.status_idle` (optionally of one stop reason). */
  waitIdle(count: number, stopReason?: string): Promise<boolean> {
    return this.waitFor(`idle#${count}${stopReason ? `:${stopReason}` : ""}`, (events) =>
      events.filter((event) => event.type === "session.status_idle"
        && (stopReason === undefined || (event.stop_reason as { type?: string } | undefined)?.type === stopReason)).length >= count);
  }

  async observe(): Promise<ParityObservation> {
    const sessionId = this.requireSession();
    const [events, session] = await Promise.all([
      this.events(),
      this.request("GET", `/v1/sessions/${sessionId}`),
    ]);
    const context: NormalizeContext = { knownIds: this.knownIds, runSuffix: this.runSuffix };
    return buildObservation({
      events,
      session: session.status === 200 ? session.body : null,
      reads: {
        ...this.reads,
        ...(this.eventsFailures.size > 0 ? { events_list_failures: [...this.eventsFailures].sort() } : {}),
      },
      models: parityModels.summary(),
      timeouts: this.timeouts,
      context,
      batches: this.batches,
    });
  }
}

export interface ParityScenario {
  /** Golden file name: packages/platform-parity/golden/<name>.json */
  name: string;
  /** What the scenario covers (design §0.7 gate 3 coverage list). */
  covers: string;
  run(context: ScenarioContext): Promise<void>;
}
