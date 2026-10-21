/**
 * Feishu as a Matter adapter: each linked app (a Feishu Bond) has a long
 * connection to Feishu and runs the Loops users configured on it, each
 * answering with the Agent its configuration names. The app id is the
 * connection key and the OpenMatter authority.
 */

import { randomUUID } from "node:crypto";
import {
  downloadFeishuMessageResource,
  inspectFeishuApp,
  makeFeishuIntegration,
  mintTenantAccessToken,
  type FeishuCredentials,
} from "@openma/matter-feishu/bond";
import {
  makeFeishuLongConnectionSource,
  type FeishuLongConnectionOptions,
} from "@openma/matter-feishu/long-connection";
import { Effect } from "effect";
import {
  connectionRevision,
  enabledLoopsByBond,
  type MatterAdapter,
  type MatterConnection,
} from "./adapter.js";
import type { FeishuConnection } from "./feishu-connect.js";
import type { MatterHost } from "./host.js";
import { installLoops, normalizeLoopConfig } from "./loops.js";
import type { FeishuAppRecord, LoopRecord, MatterDatabase } from "./persistence.js";

export type FeishuAppConnection = FeishuAppRecord & MatterConnection;

export interface FeishuAdapterOptions {
  readonly db: MatterDatabase;
  readonly fetch?: typeof fetch;
  /** Builds the Feishu WebSocket client; tests pass a fake. */
  readonly createWsClient?: FeishuLongConnectionOptions["createClient"];
}

const asConnection = (app: FeishuAppRecord, loops: readonly LoopRecord[]): FeishuAppConnection => ({
  ...app,
  key: app.appId,
  label: `Feishu app ${app.appId}`,
  loops,
  revision: connectionRevision(app.connectedAt, loops),
});

/** Tenant tokens for one app, minted on demand and reused until shortly
 * before they expire. Never persisted. */
const tenantTokens = (app: FeishuAppRecord, doFetch?: typeof fetch) => {
  let cached: { token: string; refreshAt: number } | undefined;
  return async (): Promise<FeishuCredentials> => {
    if (cached === undefined || Date.now() >= cached.refreshAt) {
      const minted = await Effect.runPromise(
        mintTenantAccessToken({
          baseUrl: app.baseUrl,
          appId: app.appId,
          appSecret: app.appSecret,
          ...(doFetch === undefined ? {} : { fetch: doFetch }),
        }),
      );
      cached = {
        token: minted.token,
        refreshAt: Date.parse(minted.expiresAt) - 5 * 60_000,
      };
    }
    return { baseUrl: app.baseUrl, token: cached.token };
  };
};

export const FEISHU_ADAPTER_KIND = "feishu";

export const createFeishuAdapter = (
  options: FeishuAdapterOptions,
): MatterAdapter<FeishuAppConnection> => ({
  kind: FEISHU_ADAPTER_KIND,
  list: async () => {
    const loops = enabledLoopsByBond(await options.db.loops.list(), FEISHU_ADAPTER_KIND);
    return (await options.db.apps.list()).map((app) => asConnection(app, loops.get(app.appId) ?? []));
  },
  get: async (key) => {
    const app = await options.db.apps.get(key);
    if (app === undefined) return undefined;
    const loops = (await options.db.loops.listForBond(FEISHU_ADAPTER_KIND, key)).filter((l) => l.enabled);
    return asConnection(app, loops);
  },
  wire: (app, report) => {
    const credentials = tenantTokens(app, options.fetch);
    return {
      integrations: {
        feishu: makeFeishuIntegration({
          // Every event of this application carries this app as authority.
          credentials: () => credentials(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      },
      install: (application, loops) => installLoops(application, loops, "feishu"),
      image: async (event, image) => {
        const payload = (event.payload ?? {}) as { messageId?: unknown };
        if (typeof payload.messageId !== "string") return undefined;
        return Effect.runPromise(
          downloadFeishuMessageResource({
            credentials: () => credentials(),
            messageId: payload.messageId,
            fileKey: image.id,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        );
      },
      source: makeFeishuLongConnectionSource({
        baseUrl: app.baseUrl,
        appId: app.appId,
        appSecret: app.appSecret,
        authority: app.appId,
        ...(app.botOpenId === undefined ? {} : { botOpenId: app.botOpenId }),
        ...(options.createWsClient === undefined
          ? {}
          : { createClient: options.createWsClient }),
        onState: (state) => {
          if (state.state === "failed") report(state.error);
        },
      }),
    };
  },
});

/**
 * `onRegistered` for `FeishuConnectService`: store the linked app (a Bond).
 * It answers once a Loop uses it; a registration started with an Agent
 * (the one-step flow) also gets a `feishu-agent` Loop for it.
 */
export const connectFeishuApp =
  (host: MatterHost, options: Pick<FeishuAdapterOptions, "db" | "fetch">) =>
  async (connection: FeishuConnection): Promise<void> => {
    if (connection.agentId !== undefined) await host.prepareAgent(connection.tenantId, connection.agentId);
    // The bot's open_id decides which group messages mention it. Without
    // it the long connection still delivers direct messages.
    const info = await Effect.runPromise(
      Effect.either(
        inspectFeishuApp({
          baseUrl: connection.app.baseUrl,
          appId: connection.app.appId,
          appSecret: connection.app.appSecret,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      ),
    );
    const { agentId, ...bond } = connection;
    const record = await options.db.apps.save(bond, info._tag === "Right" ? { botOpenId: info.right.botOpenId } : {});
    if (agentId !== undefined) {
      await options.db.loops.save({
        id: `loop-${randomUUID()}`,
        tenantId: connection.tenantId,
        bondKind: FEISHU_ADAPTER_KIND,
        bondKey: record.appId,
        template: "feishu-agent",
        config: normalizeLoopConfig("feishu-agent", { agentId }),
        enabled: true,
      });
    }
    await host.restart(FEISHU_ADAPTER_KIND, record.appId);
  };
