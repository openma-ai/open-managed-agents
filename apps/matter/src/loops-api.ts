/**
 * The Loop API behind the Console proxy. A Loop is the one thing users
 * configure: a template plus its configuration, where the Bond it runs on
 * (`config.bond`, such as `feishu:cli_…`) and the Agent that answers
 * (`config.agentId`) are configuration fields like any other. Bonds are
 * listed only as the choices for that field, and linked through the Feishu
 * and GitLab connect flows.
 *
 *   GET    /loop-templates           templates, with `bond` in each schema
 *   GET    /loops                    the workspace's Loops and their state
 *   POST   /loops                    { template, config, enabled? }
 *   PATCH  /loops/:id                { config?, enabled? }
 *   DELETE /loops/:id
 *   GET    /bonds?provider=          linked apps and instances (choices)
 *   GET    /bonds/:bond/resources    chats or projects, for list fields
 *   DELETE /bonds/:bond              only when no Loop uses it
 */

import { issueJson, MissingReferenceError, type LoopIssue } from "./issues.js";
import { findRepositoryBond } from "./repository-credential.js";
import { randomUUID } from "node:crypto";
import type { ProviderAppConfig } from "@openma/matter/bond";
import { makeFeishuResourceCatalog, mintTenantAccessToken } from "@openma/matter-feishu/bond";
import { makeGitLabResourceCatalog } from "@openma/matter-gitlab/bond";
import { Effect } from "effect";
import { FEISHU_ADAPTER_KIND } from "./feishu-adapter.js";
import type { FeishuConnectPrincipal, FeishuConnectService } from "./feishu-connect.js";
import { GITLAB_ADAPTER_KIND } from "./gitlab-adapter.js";
import type { MatterHost } from "./host.js";
import {
  LoopConfigError,
  loopTemplate,
  loopTemplates,
  normalizeLoopConfig,
  hostFields,
  splitLoopConfig,
} from "./loops.js";
import { isScheduled } from "./schedule.js";
import type { LoopRecord, MatterDatabase } from "./persistence.js";

type Provider = "feishu" | "gitlab";

const KINDS: Readonly<Record<Provider, string>> = { feishu: FEISHU_ADAPTER_KIND, gitlab: GITLAB_ADAPTER_KIND };

/** `feishu:cli_…` ↔ adapter kind and connection key. */
const parseBond = (value: unknown): { provider: Provider; kind: string; key: string } | undefined => {
  if (typeof value !== "string") return undefined;
  const at = value.indexOf(":");
  const provider = value.slice(0, at) as Provider;
  const key = value.slice(at + 1);
  return at > 0 && key !== "" && provider in KINDS ? { provider, kind: KINDS[provider], key } : undefined;
};
const bondId = (kind: string, key: string) =>
  `${(Object.entries(KINDS).find(([, k]) => k === kind)?.[0] ?? kind) as string}:${key}`;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems?: readonly string[],
    readonly issues?: readonly LoopIssue[],
  ) {
    super(message);
  }
}

/** One Bond as the Loop form offers it; never carries a secret. */
export interface BondChoice {
  readonly id: string;
  readonly provider: Provider;
  readonly label: string;
  readonly connectedAt: string;
  /** This replica runs it (it has an enabled Loop and started). */
  readonly running: boolean;
  readonly lastError?: { readonly message: string; readonly at: string };
  /** Loops that use it. */
  readonly loops: number;
  /** Feishu: the app's setup, checked now, with the console pages that fix it. */
  readonly setup?: unknown;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface LoopApiOptions {
  readonly db: MatterDatabase;
  readonly host: MatterHost;
  readonly feishuConnect: FeishuConnectService;
  readonly authorize: (request: Request) => Promise<FeishuConnectPrincipal | null>;
  readonly publicUrl?: string;
  readonly fetch?: typeof fetch;
}

/** The template list with `bond` as the first configuration field. */
const templates = () =>
  loopTemplates().map(({ provider, loop, name }) => {
    const definition = loop.definition;
    const schema = (definition.configSchema ?? { type: "object" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      id: definition.id,
      ...(name === undefined ? {} : { name }),
      version: definition.version,
      provider,
      description: definition.description,
      requiredBonds: definition.requiredBonds ?? [],
      configSchema: {
        ...schema,
        type: "object",
        properties: {
          bond: { type: "string", minLength: 1, title: "Bond", "x-oma-widget": "bond", "x-bond-provider": provider },
          ...(schema.properties ?? {}),
          ...hostFields(loop),
        },
        required: ["bond", ...(schema.required ?? []), ...(isScheduled(loop) ? ["schedule"] : [])],
      },
    };
  });

const loopView = async (loop: LoopRecord, host: MatterHost) => ({
  id: loop.id,
  template: loop.template,
  provider: loopTemplate(loop.template)?.provider,
  config: { bond: bondId(loop.bondKind, loop.bondKey), ...loop.config },
  enabled: loop.enabled,
  createdAt: loop.createdAt,
  updatedAt: loop.updatedAt,
  state: await host.sharedState(loop.bondKey),
});

export const createLoopApiHandler = (options: LoopApiOptions) => {
  const { db, host } = options;
  const providerFetch = options.fetch === undefined ? {} : { fetch: options.fetch };

  /** The Bond a Loop config names, checked to belong to the tenant. */
  const resolveBond = async (tenantId: string, value: unknown, provider: Provider) => {
    const bond = parseBond(value);
    if (bond === undefined || bond.provider !== provider) {
      throw new ApiError(400, `Choose a ${provider === "feishu" ? "Feishu app" : "GitLab instance"} for this Loop`);
    }
    const record =
      bond.provider === "feishu" ? await db.apps.get(bond.key) : await db.gitlab.get(bond.key);
    if (record === undefined || record.tenantId !== tenantId) throw new ApiError(404, "Bond not found");
    return { ...bond, record };
  };

  const saveLoop = async (
    principal: FeishuConnectPrincipal,
    input: { id: string; template: string; config: unknown; enabled: boolean },
  ) => {
    const entry = loopTemplate(input.template);
    if (entry === undefined) throw new ApiError(400, `Unknown Loop template ${input.template}`);
    const given = (typeof input.config === "object" && input.config !== null ? input.config : {}) as Record<
      string,
      unknown
    >;
    const { bond: bondValue, ...rest } = given;
    const bond = await resolveBond(principal.tenantId, bondValue, entry.provider);
    // The bot's own username is what a mention names.
    if (input.template === "gitlab-mention" && rest.username === undefined && "username" in bond.record) {
      rest.username = bond.record.username;
    }
    let config: Record<string, unknown>;
    try {
      config = normalizeLoopConfig(input.template, rest);
    } catch (error) {
      if (error instanceof LoopConfigError) throw new ApiError(400, error.message, error.problems, error.issues);
      throw error;
    }
    if (typeof config.agentId === "string") {
      try {
        await host.prepareAgent(principal.tenantId, config.agentId);
        await host.checkSession(principal.tenantId, splitLoopConfig(config).session);
      } catch (error) {
        if (error instanceof MissingReferenceError) {
          throw new ApiError(404, error.message, [error.message], [error.issue]);
        }
        if (error instanceof Error && /not found/.test(error.message)) throw new ApiError(404, error.message);
        throw error;
      }
    }
    const previous = await db.loops.get(input.id);
    const saved = await db.loops.save({
      id: input.id,
      tenantId: principal.tenantId,
      bondKind: bond.kind,
      bondKey: bond.key,
      template: input.template,
      config,
      enabled: input.enabled,
    });
    await host.restart(bond.kind, bond.key).catch(() => undefined);
    if (previous !== undefined && (previous.bondKind !== bond.kind || previous.bondKey !== bond.key)) {
      await host.restart(previous.bondKind, previous.bondKey).catch(() => undefined);
    }
    return saved;
  };

  const tenantLoop = async (tenantId: string, id: string) => {
    const loop = await db.loops.get(id);
    if (loop === undefined || loop.tenantId !== tenantId) throw new ApiError(404, "Loop not found");
    return loop;
  };

  const bonds = async (tenantId: string, provider: string | null): Promise<BondChoice[]> => {
    const loops = (await db.loops.list()).filter((l) => l.tenantId === tenantId);
    const used = (kind: string, key: string) => loops.filter((l) => l.bondKind === kind && l.bondKey === key).length;
    const out: BondChoice[] = [];
    if (provider === null || provider === "feishu") {
      const apps = (await db.apps.list()).filter((a) => a.tenantId === tenantId);
      out.push(
        ...(await Promise.all(
          apps.map(async (app) => {
            const setup = await options.feishuConnect.checkSetup(app);
            return {
              id: bondId(FEISHU_ADAPTER_KIND, app.appId),
              provider: "feishu" as const,
              label: app.appId,
              connectedAt: app.connectedAt,
              ...(await host.sharedState(app.appId)),
              loops: used(FEISHU_ADAPTER_KIND, app.appId),
              ...(setup === undefined ? {} : { setup }),
              details: { appId: app.appId, brand: app.brand },
            };
          }),
        )),
      );
    }
    if (provider === null || provider === "gitlab") {
      for (const c of (await db.gitlab.list()).filter((g) => g.tenantId === tenantId)) {
        const path = `/webhooks/gitlab/${c.id}`;
        out.push({
          id: bondId(GITLAB_ADAPTER_KIND, c.id),
          provider: "gitlab",
          label: `${c.username}@${new URL(c.baseUrl).host}`,
          connectedAt: c.connectedAt,
          ...(await host.sharedState(c.id)),
          loops: used(GITLAB_ADAPTER_KIND, c.id),
          details: {
            baseUrl: c.baseUrl,
            username: c.username,
            webhookUrl: options.publicUrl === undefined ? path : `${options.publicUrl}${path}`,
            // Known when GitLab told them at link time.
            ...(c.tokenScopes === undefined ? {} : { tokenScopes: c.tokenScopes.join(", ") }),
            ...(c.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: c.tokenExpiresAt }),
          },
        });
      }
    }
    return out;
  };

  const resources = async (tenantId: string, value: string, query: string | null) => {
    const bond = parseBond(value);
    if (bond === undefined) throw new ApiError(404, "Bond not found");
    const { record } = await resolveBond(tenantId, value, bond.provider);
    let page;
    if (bond.provider === "feishu" && "appSecret" in record) {
      const token = await Effect.runPromise(
        mintTenantAccessToken({ baseUrl: record.baseUrl, appId: record.appId, appSecret: record.appSecret, ...providerFetch }),
      );
      page = await Effect.runPromise(
        makeFeishuResourceCatalog(providerFetch).list({
          config: { provider: "feishu", baseUrl: record.baseUrl } as unknown as ProviderAppConfig,
          token: token.token,
          ...(query === null ? {} : { query }),
          limit: 100,
        }),
      );
    } else if ("token" in record) {
      page = await Effect.runPromise(
        makeGitLabResourceCatalog(providerFetch).list({
          config: { provider: "gitlab", baseUrl: record.baseUrl } as unknown as ProviderAppConfig,
          token: record.token,
          ...(query === null ? {} : { query }),
          limit: 100,
        }),
      );
    }
    return page?.items ?? [];
  };

  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });

  /** Whether a Loop of the tenant clones a repository with this GitLab Bond. */
  const clonesWith = async (tenantId: string, bondKey: string): Promise<boolean> => {
    for (const loop of await db.loops.list()) {
      if (loop.tenantId !== tenantId) continue;
      for (const url of splitLoopConfig(loop.config).session.repositories) {
        const served = await findRepositoryBond(db, tenantId, url).catch(() => undefined);
        if (served?.id === bondKey) return true;
      }
    }
    return false;
  };

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const route = /^\/(loop-templates|loops|bonds)(?:\/([^/]+))?(?:\/(resources|run))?$/.exec(path);
    if (route === null) return undefined;
    const [, collection, rawId, sub] = route;
    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
    const principal = await options.authorize(request);
    if (principal === null) return json({ error: "unauthorized" }, 401);
    const method = request.method;
    const body = async () => {
      const value: unknown = await request.json().catch(() => ({}));
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    };
    try {
      if (collection === "loop-templates" && id === undefined && method === "GET") {
        return json({ data: templates() });
      }
      if (collection === "loops" && id === undefined && method === "GET") {
        const loops = (await db.loops.list()).filter((l) => l.tenantId === principal.tenantId);
        return json({ data: await Promise.all(loops.map((l) => loopView(l, host))) });
      }
      if (collection === "loops" && id === undefined && method === "POST") {
        const input = await body();
        if (typeof input.template !== "string") throw new ApiError(400, "template is required");
        const saved = await saveLoop(principal, {
          id: `loop-${randomUUID()}`,
          template: input.template,
          config: input.config,
          enabled: input.enabled !== false,
        });
        return json(await loopView(saved, host), 201);
      }
      if (collection === "loops" && id !== undefined && sub === undefined && method === "PATCH") {
        const loop = await tenantLoop(principal.tenantId, id);
        const input = await body();
        const saved = await saveLoop(principal, {
          id: loop.id,
          template: loop.template,
          config:
            input.config === undefined
              ? { bond: bondId(loop.bondKind, loop.bondKey), ...loop.config }
              : input.config,
          enabled: typeof input.enabled === "boolean" ? input.enabled : loop.enabled,
        });
        return json(await loopView(saved, host));
      }
      if (collection === "loops" && id !== undefined && sub === "run" && method === "POST") {
        const loop = await tenantLoop(principal.tenantId, id);
        const template = loopTemplate(loop.template);
        if (template === undefined || !isScheduled(template.loop)) {
          throw new ApiError(400, "Only a scheduled Loop can be run now; other Loops run on their events");
        }
        if (!loop.enabled) throw new ApiError(409, "Enable the Loop to run it");
        let scheduledAt: string;
        try {
          scheduledAt = await host.runNow(loop.bondKind, loop.bondKey, loop.id);
        } catch (error) {
          throw new ApiError(409, error instanceof Error ? error.message : String(error));
        }
        return json({ loopId: loop.id, scheduledAt }, 202);
      }
      if (collection === "loops" && id !== undefined && sub === undefined && method === "DELETE") {
        const loop = await tenantLoop(principal.tenantId, id);
        await db.loops.delete(loop.id);
        await host.restart(loop.bondKind, loop.bondKey).catch(() => undefined);
        return new Response(null, { status: 204 });
      }
      if (collection === "bonds" && id === undefined && method === "GET") {
        return json({ data: await bonds(principal.tenantId, url.searchParams.get("provider")) });
      }
      if (collection === "bonds" && id !== undefined && sub === "resources" && method === "GET") {
        return json({ data: await resources(principal.tenantId, id, url.searchParams.get("query")) });
      }
      if (collection === "bonds" && id !== undefined && sub === undefined && method === "DELETE") {
        const bond = parseBond(id);
        if (bond === undefined) throw new ApiError(404, "Bond not found");
        await resolveBond(principal.tenantId, id, bond.provider);
        if ((await db.loops.listForBond(bond.kind, bond.key)).length > 0) {
          throw new ApiError(409, "Delete the Loops that use it first");
        }
        if (bond.provider === "gitlab" && (await clonesWith(principal.tenantId, bond.key))) {
          throw new ApiError(409, "Loops clone repositories with it; remove them from those Loops first");
        }
        if (bond.provider === "feishu") await db.apps.delete(bond.key);
        else await db.gitlab.delete(bond.key);
        await host.reconcile();
        return new Response(null, { status: 204 });
      }
      return json({ error: "method not allowed" }, 405);
    } catch (error) {
      if (error instanceof ApiError) {
        return json(
          {
            error: error.message,
            ...(error.problems === undefined ? {} : { problems: error.problems }),
            ...(error.issues === undefined ? {} : { issues: error.issues.map(issueJson) }),
          },
          error.status,
        );
      }
      throw error;
    }
  };
};

/**
 * Before Loops existed a connection named its Agent itself. Turn each such
 * connection into a Loop (once: the id is fixed and the Agent is cleared),
 * so it keeps answering. Safe to run on every replica at once.
 */
export const migrateConnectionsToLoops = async (db: MatterDatabase): Promise<void> => {
  for (const app of await db.apps.list()) {
    if (app.agentId === "") continue;
    await db.loops.saveIfAbsent({
      id: `loop-legacy-feishu-${app.appId}`,
      tenantId: app.tenantId,
      bondKind: FEISHU_ADAPTER_KIND,
      bondKey: app.appId,
      template: "feishu-agent",
      config: normalizeLoopConfig("feishu-agent", { agentId: app.agentId }),
      enabled: true,
    });
    await db.apps.forgetAgent(app.appId);
  }
  for (const c of await db.gitlab.list()) {
    if (c.agentId === "" || c.projectIds.length === 0) continue;
    await db.loops.saveIfAbsent({
      id: `loop-legacy-gitlab-${c.id}`,
      tenantId: c.tenantId,
      bondKind: GITLAB_ADAPTER_KIND,
      bondKey: c.id,
      template: "gitlab-mention",
      config: normalizeLoopConfig("gitlab-mention", {
        agentId: c.agentId,
        projects: c.projectIds.map((p) => `project:${p}`),
        username: c.username,
      }),
      enabled: true,
    });
    await db.gitlab.forgetAgent(c.id);
  }
  // OpenMatter 0.2.6 names session scopes the same in every template.
  // The WorkThread ids did not change, so the Loops keep their Sessions.
  for (const loop of await db.loops.list()) {
    const renamed = LEGACY_SESSION_SCOPES[loop.template]?.[String(loop.config.sessionScope)];
    if (renamed === undefined) continue;
    await db.loops.save({ ...loop, config: { ...loop.config, sessionScope: renamed } });
  }
};

/** Session scope values renamed by OpenMatter 0.2.6, per template. */
const LEGACY_SESSION_SCOPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "feishu-agent": { thread: "work-item", chat: "global" },
};
