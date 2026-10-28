/**
 * "Connect Feishu": one-click creation of a customer self-built Feishu (or
 * Lark) app for the `feishu-agent` Loop. The page shows a QR code; the user
 * scans it in Feishu and confirms an app pre-configured with the scopes and
 * events the Loop needs. The service polls in the background, hands the new
 * app's credentials to the host, and checks the app's setup.
 *
 * The registration's device code and the app secret never reach the browser.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  beginFeishuAppRegistration,
  checkFeishuAppSetup,
  feishuAgentSetup,
  pollFeishuAppRegistration,
  type FeishuAppSetupReport,
  type FeishuBrand,
  type Fetch,
} from "@openma/matter-feishu/bond";
import { Effect } from "effect";
import QRCode from "qrcode";

export interface RegisteredFeishuApp {
  readonly appId: string;
  readonly appSecret: string;
  readonly brand: FeishuBrand;
  /** Open origin of the brand, the Bond ProviderApp `baseUrl`. */
  readonly baseUrl: string;
  /** The confirming user's `open_id` in the new app, when returned. */
  readonly openId?: string;
}

/** Who started a registration, as the host's `authorize` reports it. */
export interface FeishuConnectPrincipal {
  readonly tenantId: string;
  readonly userId?: string;
}

/** What the host stores when a registration completes. */
export interface FeishuConnection {
  readonly app: RegisteredFeishuApp;
  readonly tenantId: string;
  readonly userId?: string;
  /** The OpenMA Agent the user chose to answer in Feishu, if any. */
  readonly agentId?: string;
}

export type FeishuConnectStatus =
  | { readonly status: "pending"; readonly url: string; readonly qrSvg: string; readonly expiresAt: string }
  | { readonly status: "expired" }
  | { readonly status: "denied" }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "registered";
      readonly appId: string;
      readonly brand: FeishuBrand;
      /** Undefined while the setup check runs. */
      readonly setup?: FeishuAppSetupReport;
      /** The setup check could not run; the app itself was saved. */
      readonly setupUnavailable?: true;
    };

/** A "Connect Feishu" registration as every replica reads and polls it. */
export interface RegistrationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId?: string;
  readonly agentId?: string;
  /** Never sent to the browser; a database store seals it at rest. */
  readonly deviceCode: string;
  readonly brand: FeishuBrand;
  readonly intervalS: number;
  readonly expiresAtMs: number;
  readonly status: FeishuConnectStatus;
  readonly nextPollAtMs: number;
  readonly finishedAtMs?: number;
}

/** Where registrations live. With a shared database, the replica that
 * started a registration need not be the one that polls it, nor the one
 * the browser asks for its status. */
export interface RegistrationStore {
  create(record: RegistrationRecord): Promise<void>;
  get(id: string): Promise<RegistrationRecord | undefined>;
  /** Take the next poll of `id` (or, without `id`, of any due registration)
   * for `ownerId` until `leaseUntilMs`. A poll is due at `nextPollAtMs`;
   * at most one replica holds it at a time. */
  claim(
    id: string | undefined,
    ownerId: string,
    nowMs: number,
    leaseUntilMs: number,
  ): Promise<RegistrationRecord | undefined>;
  /** Write a poll's result and give the poll back (only by its owner). */
  update(
    id: string,
    ownerId: string,
    patch: {
      readonly status: FeishuConnectStatus;
      readonly intervalS?: number;
      readonly brand?: FeishuBrand;
      readonly nextPollAtMs: number;
      readonly finishedAtMs?: number;
    },
  ): Promise<void>;
  /** Replace a finished registration's status (the setup check). */
  patchStatus(id: string, status: FeishuConnectStatus): Promise<void>;
  /** Drop registrations finished or expired before `beforeMs`. */
  prune(beforeMs: number): Promise<void>;
}

/** Registrations in process memory: a single process, and tests. */
export const memoryRegistrationStore = (): RegistrationStore => {
  type Row = RegistrationRecord & { leaseOwner?: string; leaseUntilMs?: number };
  const rows = new Map<string, Row>();
  const free = (row: Row, nowMs: number) =>
    row.finishedAtMs === undefined && (row.leaseUntilMs === undefined || row.leaseUntilMs <= nowMs);
  const strip = ({ leaseOwner: _o, leaseUntilMs: _u, ...record }: Row): RegistrationRecord => record;
  return {
    create: async (record) => void rows.set(record.id, { ...record }),
    get: async (id) => {
      const row = rows.get(id);
      return row === undefined ? undefined : strip(row);
    },
    claim: async (id, ownerId, nowMs, leaseUntilMs) => {
      const candidates = id === undefined ? [...rows.values()] : [rows.get(id)].filter((r) => r !== undefined);
      const row = candidates
        .filter((r) => free(r, nowMs) && r.nextPollAtMs <= nowMs)
        .sort((a, b) => a.nextPollAtMs - b.nextPollAtMs)[0];
      if (row === undefined) return undefined;
      rows.set(row.id, { ...row, leaseOwner: ownerId, leaseUntilMs });
      return strip(row);
    },
    update: async (id, ownerId, patch) => {
      const row = rows.get(id);
      if (row === undefined || row.leaseOwner !== ownerId) return;
      const { leaseOwner: _o, leaseUntilMs: _u, ...rest } = row;
      rows.set(id, {
        ...rest,
        status: patch.status,
        intervalS: patch.intervalS ?? row.intervalS,
        brand: patch.brand ?? row.brand,
        nextPollAtMs: patch.nextPollAtMs,
        ...(patch.finishedAtMs === undefined ? {} : { finishedAtMs: patch.finishedAtMs }),
      });
    },
    patchStatus: async (id, status) => {
      const row = rows.get(id);
      if (row !== undefined) rows.set(id, { ...row, status });
    },
    prune: async (beforeMs) => {
      for (const [id, row] of rows) {
        if ((row.finishedAtMs !== undefined && row.finishedAtMs < beforeMs) || row.expiresAtMs < beforeMs) {
          rows.delete(id);
        }
      }
    },
  };
};

export interface FeishuConnectOptions {
  /** Store the new app (seal the secret). Called once per registration. */
  readonly onRegistered: (connection: FeishuConnection) => Promise<void>;
  /** Defaults to `memoryRegistrationStore()`: a single process. */
  readonly store?: RegistrationStore;
  /** This replica, as lease owner (default: random). */
  readonly ownerId?: string;
  /** Pre-filled app name and description on the confirmation page. */
  readonly appName?: string;
  readonly appDescription?: string;
  /** Also read every group message; the tenant administrator must approve. */
  readonly allGroupMessages?: boolean;
  readonly fetch?: Fetch;
  /** Run `task` after `ms`; defaults to an unref'd `setTimeout`. */
  readonly schedule?: (task: () => void, ms: number) => void;
  readonly now?: () => number;
  /** How long a finished registration stays readable (default 1 h). */
  readonly retainMs?: number;
  /** How long one poll may hold a registration (default 30 s). */
  readonly leaseMs?: number;
}

const openOrigin = (brand: FeishuBrand) =>
  brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

const defaultSchedule = (task: () => void, ms: number) => {
  const timer = setTimeout(task, ms);
  timer.unref?.();
};

export class FeishuConnectService {
  private readonly store: RegistrationStore;
  private readonly ownerId: string;
  private readonly schedule: (task: () => void, ms: number) => void;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly setup: ReturnType<typeof feishuAgentSetup>;

  constructor(private readonly options: FeishuConnectOptions) {
    this.store = options.store ?? memoryRegistrationStore();
    this.ownerId = options.ownerId ?? randomBytes(8).toString("hex");
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.setup = feishuAgentSetup({
      allGroupMessages: options.allGroupMessages === true,
    });
  }

  /** Start a registration. This replica polls it first; any replica's
   * `sweep` takes the poll over if this one goes away. */
  async begin(input: {
    readonly principal: FeishuConnectPrincipal;
    readonly agentId?: string;
  }): Promise<{ readonly id: string; readonly status: FeishuConnectStatus }> {
    await this.store.prune(this.now() - (this.options.retainMs ?? 3_600_000)).catch(() => undefined);
    const registration = await Effect.runPromise(
      beginFeishuAppRegistration({
        name: this.options.appName ?? "OpenMA Agent",
        ...(this.options.appDescription === undefined
          ? {}
          : { description: this.options.appDescription }),
        addons: this.setup.addons,
        createOnly: true,
        source: "openma",
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      }),
    );
    const id = randomBytes(16).toString("base64url");
    const status: FeishuConnectStatus = {
      status: "pending",
      url: registration.url,
      qrSvg: await QRCode.toString(registration.url, { type: "svg", margin: 1 }),
      expiresAt: registration.expiresAt,
    };
    await this.store.create({
      id,
      tenantId: input.principal.tenantId,
      ...(input.principal.userId === undefined ? {} : { userId: input.principal.userId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      deviceCode: registration.deviceCode,
      brand: registration.brand,
      intervalS: registration.interval,
      expiresAtMs: Date.parse(registration.expiresAt),
      status,
      nextPollAtMs: this.now() + registration.interval * 1000,
    });
    this.later(id, registration.interval);
    return { id, status };
  }

  /** A registration's status, readable only by the tenant that started it. */
  async status(id: string, tenantId: string): Promise<FeishuConnectStatus | undefined> {
    const record = await this.store.get(id);
    return record?.tenantId === tenantId ? record.status : undefined;
  }

  /** Poll every due registration whose poll no replica holds. Call it
   * periodically on every replica. */
  async sweep(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const record = await this.store.claim(undefined, this.ownerId, this.now(), this.now() + this.leaseMs);
      if (record === undefined) return;
      await this.pollClaimed(record);
    }
  }

  /** One poll of `id`, if it is due and no replica holds it. */
  async poll(id: string): Promise<void> {
    const record = await this.store.claim(id, this.ownerId, this.now(), this.now() + this.leaseMs);
    if (record !== undefined) await this.pollClaimed(record);
  }

  private later(id: string, intervalS: number): void {
    this.schedule(() => void this.poll(id).catch(() => undefined), intervalS * 1000);
  }

  private async pollClaimed(record: RegistrationRecord): Promise<void> {
    const id = record.id;
    const finish = (status: FeishuConnectStatus) =>
      this.store.update(id, this.ownerId, {
        status,
        nextPollAtMs: record.nextPollAtMs,
        finishedAtMs: this.now(),
      });
    const again = async (intervalS: number, brand: FeishuBrand) => {
      await this.store.update(id, this.ownerId, {
        status: record.status,
        intervalS,
        brand,
        nextPollAtMs: this.now() + intervalS * 1000,
      });
      this.later(id, intervalS);
    };
    if (record.status.status !== "pending") {
      await finish(record.status);
      return;
    }
    if (this.now() >= record.expiresAtMs) {
      await finish({ status: "expired" });
      return;
    }
    let result;
    try {
      result = await Effect.runPromise(
        pollFeishuAppRegistration({
          deviceCode: record.deviceCode,
          interval: record.intervalS,
          brand: record.brand,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        }),
      );
    } catch {
      // A transient platform error: keep polling until the code expires.
      await again(record.intervalS, record.brand);
      return;
    }
    switch (result.status) {
      case "pending":
      case "slow_down":
        await again(result.interval, result.brand);
        return;
      case "expired":
      case "denied":
        await finish({ status: result.status });
        return;
      case "registered": {
        const app: RegisteredFeishuApp = {
          appId: result.appId,
          appSecret: result.appSecret,
          brand: result.brand,
          baseUrl: openOrigin(result.brand),
          ...(result.openId === undefined ? {} : { openId: result.openId }),
        };
        try {
          await this.options.onRegistered({
            app,
            tenantId: record.tenantId,
            ...(record.userId === undefined ? {} : { userId: record.userId }),
            ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
          });
        } catch {
          await finish({
            status: "failed",
            reason: "The app was created but could not be saved. Connect again.",
          });
          return;
        }
        const registered = { status: "registered", appId: app.appId, brand: app.brand } as const;
        await finish(registered);
        void this.check(id, registered, app);
        return;
      }
    }
  }

  /** Check a connected app against what the `feishu-agent` Loop needs;
   * undefined when Feishu could not be asked. */
  async checkSetup(app: {
    readonly baseUrl: string;
    readonly appId: string;
    readonly appSecret: string;
  }): Promise<FeishuAppSetupReport | undefined> {
    try {
      return await Effect.runPromise(
        checkFeishuAppSetup(
          {
            baseUrl: app.baseUrl,
            appId: app.appId,
            appSecret: app.appSecret,
            ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
          },
          this.setup.requirements,
        ),
      );
    } catch {
      return undefined;
    }
  }

  private async check(
    id: string,
    registered: Extract<FeishuConnectStatus, { status: "registered" }>,
    app: RegisteredFeishuApp,
  ): Promise<void> {
    const setup = await this.checkSetup(app);
    const status: FeishuConnectStatus =
      setup === undefined ? { ...registered, setupUnavailable: true } : { ...registered, setup };
    await this.store.patchStatus(id, status).catch(() => undefined);
  }
}

export interface FeishuConnectHandlerOptions {
  readonly service: FeishuConnectService;
  /** Who is asking, for example from an OpenMA session or a trusted proxy
   * (`trustedProxyPrincipal`). Requests it rejects (null) get 401. */
  readonly authorize: (request: Request) => Promise<FeishuConnectPrincipal | null>;
  /** Path the handler is mounted at (default `/connect/feishu`). */
  readonly basePath?: string;
}

/**
 * `GET {base}` serves the page, `POST {base}/registrations` starts a
 * registration and `GET {base}/registrations/:id` reports its status.
 */
export const createFeishuConnectHandler = (options: FeishuConnectHandlerOptions) => {
  const base = (options.basePath ?? "/connect/feishu").replace(/\/+$/, "");
  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path !== base && !path.startsWith(`${base}/`)) return undefined;
    const principal = await options.authorize(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const rest = path.slice(base.length);
    if (rest === "" && request.method === "GET") {
      return new Response(connectPage(base, pickLocale(request.headers.get("accept-language"))), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
        },
      });
    }
    if (rest === "/registrations" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => ({}));
      const agentId =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as { agentId?: unknown }).agentId
          : undefined;
      if (agentId !== undefined && (typeof agentId !== "string" || agentId === "")) {
        return Response.json({ error: "agentId must be a non-empty string" }, { status: 400 });
      }
      try {
        return Response.json(
          await options.service.begin({
            principal,
            ...(agentId === undefined ? {} : { agentId }),
          }),
          { status: 201 },
        );
      } catch {
        return Response.json(
          { error: "Feishu did not start the registration. Try again." },
          { status: 502 },
        );
      }
    }
    const match = /^\/registrations\/([A-Za-z0-9_-]+)$/.exec(rest);
    if (match?.[1] !== undefined && request.method === "GET") {
      const status = await options.service.status(match[1], principal.tenantId);
      return status === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json(status, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
};

/** Headers a trusted reverse proxy (the OpenMA control plane serving the
 * Console) sets after authenticating the user. */
export const MATTER_PROXY_HEADERS = {
  secret: "x-matter-proxy-secret",
  tenant: "x-oma-tenant-id",
  user: "x-oma-user-id",
  /** The control plane itself calling `/internal/*` (credentials). Its
   * Console proxy never sends it, so a signed-in user cannot reach them. */
  internal: "x-matter-internal-secret",
} as const;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Headers with which the Matter service calls the OpenMA API as one
 * workspace, without an API key: the control plane trusts the tenant header
 * only alongside the shared proxy secret (the same pair it sends to Matter).
 */
export const matterTrustHeaders = (secret: string, tenantId: string): Record<string, string> => ({
  [MATTER_PROXY_HEADERS.secret]: secret,
  [MATTER_PROXY_HEADERS.tenant]: tenantId,
});

/**
 * `authorize` for a Matter service reached only through the OpenMA control
 * plane: trusts the tenant and user headers when the request carries the
 * shared proxy secret.
 */
export const trustedProxyPrincipal =
  (secret: string) =>
  async (request: Request): Promise<FeishuConnectPrincipal | null> => {
    if (secret.length === 0) return null;
    const given = request.headers.get(MATTER_PROXY_HEADERS.secret) ?? "";
    if (!timingSafeEqual(digest(given), digest(secret))) return null;
    const tenantId = request.headers.get(MATTER_PROXY_HEADERS.tenant);
    if (tenantId === null || tenantId === "") return null;
    const userId = request.headers.get(MATTER_PROXY_HEADERS.user);
    return userId === null || userId === "" ? { tenantId } : { tenantId, userId };
  };

const MESSAGES = {
  "zh-CN": {
    title: "连接飞书",
    intro: "用飞书扫码，确认创建一个企业自建应用。应用已预先配置好机器人收发消息所需的权限和事件，Agent 会以这个应用的机器人身份回复。",
    start: "生成二维码",
    starting: "正在生成…",
    openIn: "或在飞书中打开：",
    waiting: "等待确认…",
    created: "已创建应用",
    checking: "正在检查应用配置…",
    checkUnavailable: "暂时无法检查应用配置，可以先在飞书里 @机器人 试试。",
    ready: "配置检查通过，可以在飞书里 @机器人 了。",
    fixes: "还差几步：",
    expired: "二维码已过期，请重新生成。",
    denied: "已在飞书中取消。",
    failed: "连接失败。",
    statusFailed: "查询状态失败。",
    startFailed: "生成失败。",
  },
  en: {
    title: "Connect Feishu",
    intro: "Scan with Feishu and confirm to create a self-built app. The app comes pre-configured with the scopes and events the bot needs to read and send messages; the Agent replies as this app's bot.",
    start: "Show QR code",
    starting: "Starting…",
    openIn: "Or open in Feishu: ",
    waiting: "Waiting for confirmation…",
    created: "Created app",
    checking: "Checking the app's setup…",
    checkUnavailable: "The app's setup could not be checked right now. Try mentioning the bot in Feishu.",
    ready: "Setup check passed. Mention the bot in Feishu to start.",
    fixes: "A few steps remain:",
    expired: "The QR code expired. Show a new one.",
    denied: "Cancelled in Feishu.",
    failed: "Connecting failed.",
    statusFailed: "Could not read the status.",
    startFailed: "Could not start.",
  },
} as const;

type Locale = keyof typeof MESSAGES;

/** `zh*` in Accept-Language selects Chinese; anything else English. */
const pickLocale = (acceptLanguage: string | null): Locale => {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("zh") ? "zh-CN" : "en";
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const connectPage = (base: string, locale: Locale) => {
  const m = MESSAGES[locale];
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(m.title)}</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2329; }
  h1 { font-size: 1.4rem; }
  button { font: inherit; padding: .5rem 1.2rem; border-radius: 6px; border: 0; background: #3370ff; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  #qr svg { width: 220px; height: 220px; }
  .muted { color: #646a73; }
  .ok { color: #2ea121; } .warn { color: #d83931; }
  li { margin: .25rem 0; }
</style>
</head>
<body>
<h1>${escapeHtml(m.title)}</h1>
<p class="muted">${escapeHtml(m.intro)}</p>
<p><button id="start">${escapeHtml(m.start)}</button></p>
<div id="panel"></div>
<script>
const base = ${JSON.stringify(base)};
const m = ${JSON.stringify(m)};
const panel = document.getElementById("panel");
const start = document.getElementById("start");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
let timer;
function render(s) {
  if (s.status === "pending") {
    panel.innerHTML = '<div id="qr">' + s.qrSvg + '</div><p>' + esc(m.openIn) + '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a></p><p class="muted">' + esc(m.waiting) + '</p>';
  } else if (s.status === "registered") {
    let html = '<p class="ok">' + esc(m.created) + ' <code>' + esc(s.appId) + '</code> (' + esc(s.brand) + ')</p>';
    if (s.setupUnavailable) html += '<p class="muted">' + esc(m.checkUnavailable) + '</p>';
    else if (!s.setup) html += '<p class="muted">' + esc(m.checking) + '</p>';
    else if (s.setup.ready) html += '<p class="ok">' + esc(m.ready) + '</p>';
    else html += '<p class="warn">' + esc(m.fixes) + '</p><ul>' + s.setup.problems.map((p) => '<li>' + esc(p) + '</li>').join("") + '</ul>';
    panel.innerHTML = html;
  } else {
    const text = s.status === "failed" ? (s.reason || m.failed) : (m[s.status] || m.failed);
    panel.innerHTML = '<p class="warn">' + esc(text) + '</p>';
  }
}
async function poll(id) {
  const response = await fetch(base + "/registrations/" + encodeURIComponent(id), { credentials: "same-origin" });
  if (!response.ok) { panel.innerHTML = '<p class="warn">' + esc(m.statusFailed) + '</p>'; start.disabled = false; return; }
  const s = await response.json();
  render(s);
  const done = s.status !== "pending" && !(s.status === "registered" && !s.setup && !s.setupUnavailable);
  if (done) { start.disabled = false; return; }
  timer = setTimeout(() => poll(id), 3000);
}
start.addEventListener("click", async () => {
  clearTimeout(timer);
  start.disabled = true;
  panel.innerHTML = '<p class="muted">' + esc(m.starting) + '</p>';
  const response = await fetch(base + "/registrations", { method: "POST", credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { panel.innerHTML = '<p class="warn">' + esc(body.error || m.startFailed) + '</p>'; start.disabled = false; return; }
  render(body.status);
  timer = setTimeout(() => poll(body.id), 3000);
});
</script>
</body>
</html>
`;
};
