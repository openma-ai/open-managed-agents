/**
 * The running Matter service: one OpenMatter application per connection
 * (a Feishu app, a GitLab instance, …), whatever its kind. Each has its own
 * store and inbox (a partition of the Matter database), its adapter's event
 * source and Loops, and an Agent driver for the OpenMA Agent the user chose.
 * All of them share the MCP endpoint (and its bridge), which tells their
 * Sessions apart by the per-Session bearer. What differs per kind lives in a
 * `MatterAdapter`.
 *
 * Every replica runs every connection. The database is the only state they
 * share: the inbox hands each event to one replica, the store serializes
 * the work on it, and `reconcile` brings each replica's running connections
 * in line with the saved ones.
 */

import { makeConnectorAgentDriver } from "@openma/matter/agent";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeLocalLongConnectionRuntime } from "@openma/matter-host-local/runtime";
import { Effect } from "effect";
import { isSafeConnectionKey, type MatterAdapter, type MatterConnection } from "./adapter.js";
import { createOpenMAConnector, isOmaSessionUnavailable } from "./connector.js";
import type { OmaClient, OmaMcpServer } from "./oma-client.js";
import type { MatterDatabase } from "./persistence.js";
import { withImages } from "./images.js";
import { sessionVaults } from "./session-tokens.js";
import type { OperationCallBridge } from "./tool-bridge.js";

export const DEFAULT_MCP_SERVER_NAME = "openmatter";

export interface MatterHostOptions {
  /** Saved connections, tokens, and each connection's store and inbox. */
  readonly db: MatterDatabase;
  readonly bridge: OperationCallBridge;
  /** The OpenMA API client for a tenant, or null when this service cannot
   * act in that tenant. */
  readonly clientFor: (tenantId: string) => OmaClient | null;
  /** The Matter MCP endpoint as OpenMA reaches it. */
  readonly mcpServerUrl: string;
  readonly mcpServerName?: string;
  /** The OpenMA environment new sessions run in: one for every workspace,
   * or found per workspace. */
  readonly environmentId: string | ((tenantId: string) => Promise<string>);
  /** Every kind of connection the service runs. Keys must not collide. */
  readonly adapters: readonly MatterAdapter<MatterConnection>[];
  readonly onError?: (error: unknown, key: string) => void;
  /** A connection started on this replica (for logs). */
  readonly onStarted?: (key: string, label: string) => void;
}

/** One connection as this replica sees it. */
export interface ConnectionState {
  readonly running: boolean;
  /** The last error the connection reported since it last started. */
  readonly lastError?: { readonly message: string; readonly at: string };
}

export interface MatterHost {
  /** Start every saved connection of every adapter. */
  start(): Promise<void>;
  /** Start saved connections this replica does not run yet, start changed
   * ones again, and stop deleted ones. Call it periodically. */
  reconcile(): Promise<void>;
  /** Start one saved connection, or start it again after it changed. */
  restart(kind: string, key: string): Promise<void>;
  /** Start one saved connection unless this replica already runs its
   * current revision (another replica may have just saved it). */
  ensure(kind: string, key: string): Promise<boolean>;
  /** Give an Agent the Matter MCP server before a connection uses it.
   * Throws when this service cannot act in the tenant. */
  prepareAgent(tenantId: string, agentId: string): Promise<void>;
  /** Keys of the connections currently running. */
  running(): readonly string[];
  /** Whether this replica runs `key`, and its last error. */
  state(key: string): ConnectionState;
  stop(): Promise<void>;
}

/**
 * Add the Matter MCP server (and the `mcp_toolset` OpenMA requires for it)
 * to an Agent, or point it at `url` again. Other servers and tools are kept.
 * A no-op when the Agent already has both.
 */
export const ensureAgentMcpServer = async (
  client: OmaClient,
  agentId: string,
  server: { readonly name: string; readonly url: string },
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const agent = await client.getAgent(agentId);
    if (agent === null) throw new Error(`OpenMA Agent ${agentId} not found`);
    const servers = agent.mcp_servers ?? [];
    const tools = agent.tools ?? [];
    const current = servers.find((s) => s.name === server.name);
    const toolset = tools.some(
      (t) => t.type === "mcp_toolset" && t.mcp_server_name === server.name,
    );
    if (current?.type === "url" && current.url === server.url && toolset) return;
    const next: OmaMcpServer[] = [
      ...servers.filter((s) => s.name !== server.name),
      { name: server.name, type: "url", url: server.url },
    ];
    try {
      await client.updateAgentMcp(agentId, agent.version, {
        mcp_servers: next,
        // Every MCP server must be referenced by an mcp_toolset. Nobody is
        // around to approve a call from a chat, so allow it explicitly
        // instead of relying on the server's default policy.
        tools: toolset
          ? tools
          : [
              ...tools,
              {
                type: "mcp_toolset",
                mcp_server_name: server.name,
                default_config: { permission_policy: { type: "always_allow" } },
              },
            ],
      });
      return;
    } catch (error) {
      // Someone saved the Agent in between; read it again.
      if ((error as { status?: number }).status !== 409) throw error;
    }
  }
  throw new Error(`OpenMA Agent ${agentId} kept changing; try again`);
};

interface Running {
  readonly kind: string;
  readonly revision: string;
  readonly stop: () => Promise<void>;
}

export const createMatterHost = (options: MatterHostOptions): MatterHost => {
  const mcpServerName = options.mcpServerName ?? DEFAULT_MCP_SERVER_NAME;
  const running = new Map<string, Running>();
  const lastErrors = new Map<string, { message: string; at: string }>();
  const report = (error: unknown, key: string) => {
    lastErrors.set(key, {
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    });
    options.onError?.(error, key);
  };
  const adapterOf = (kind: string) => {
    const adapter = options.adapters.find((a) => a.kind === kind);
    if (adapter === undefined) throw new Error(`No adapter for ${kind}`);
    return adapter;
  };

  const startConnection = async (
    adapter: MatterAdapter<MatterConnection>,
    connection: MatterConnection,
  ): Promise<void> => {
    const { key } = connection;
    if (!isSafeConnectionKey(key)) throw new Error(`Unsafe connection key ${JSON.stringify(key)}`);
    await running.get(key)?.stop();
    running.delete(key);
    // A Bond no Loop uses stays idle.
    if (connection.loops.length === 0) {
      lastErrors.delete(key);
      return;
    }
    const agentIds = [
      ...new Set(
        connection.loops
          .map((loop) => loop.config.agentId)
          .filter((id): id is string => typeof id === "string" && id !== ""),
      ),
    ];
    const client = options.clientFor(connection.tenantId);
    if (client === null) {
      report(new Error(`No OpenMA access for tenant ${connection.tenantId}`), key);
      return;
    }
    const { store, inbox } = options.db.connectionStorage(key);
    const wiring = adapter.wire(connection, (error) => report(error, key));
    const image = wiring.image;
    const connector = createOpenMAConnector({
      ...(image === undefined ? {} : { content: (content) => withImages(content, image) }),
      client,
      bridge: options.bridge,
      mcpServerName,
      vaultIds: sessionVaults({
        client,
        tokens: options.db.tokens,
        mcpServerUrl: options.mcpServerUrl,
      }),
      environmentId:
        typeof options.environmentId === "string"
          ? options.environmentId
          : () => (options.environmentId as (tenantId: string) => Promise<string>)(connection.tenantId),
    });
    const application = createOpenMatter({
      store,
      integrations: wiring.integrations,
      agents: Object.fromEntries(
        agentIds.map((agentId) => [
          agentId,
          makeConnectorAgentDriver({ connector, agentId, isSessionUnavailable: isOmaSessionUnavailable }),
        ]),
      ),
    });
    wiring.install(application, connection.loops);
    const runtime = makeLocalLongConnectionRuntime({
      source: wiring.source,
      application,
      inbox,
      connectionLabel: connection.label,
      onError: (error) => report(error, key),
    });
    try {
      await runtime.start();
    } catch (error) {
      await Effect.runPromise(Effect.either(inbox.close));
      await Effect.runPromise(Effect.either(store.close));
      throw error;
    }
    lastErrors.delete(key);
    options.onStarted?.(key, connection.label);
    running.set(key, {
      kind: adapter.kind,
      revision: connection.revision,
      stop: async () => {
        await runtime.stop();
        await Effect.runPromise(Effect.either(inbox.close));
        await Effect.runPromise(Effect.either(store.close));
      },
    });
  };

  // One start or stop at a time, so a reconcile and a restart do not race.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const reconcile = () =>
    serial(async () => {
      const saved = new Map<string, { adapter: MatterAdapter<MatterConnection>; connection: MatterConnection }>();
      for (const adapter of options.adapters) {
        let connections: readonly MatterConnection[];
        try {
          connections = await adapter.list();
        } catch (error) {
          // Keep what runs; the next reconcile tries again.
          report(error, adapter.kind);
          for (const [key, r] of running) {
            if (r.kind === adapter.kind) saved.set(key, { adapter, connection: { key } as MatterConnection });
          }
          continue;
        }
        for (const connection of connections) saved.set(connection.key, { adapter, connection });
      }
      for (const [key, r] of [...running]) {
        if (!saved.has(key)) {
          running.delete(key);
          await r.stop().catch((error: unknown) => report(error, key));
        }
      }
      for (const [key, { adapter, connection }] of saved) {
        const current = running.get(key);
        if (current !== undefined && (connection.revision === undefined || current.revision === connection.revision)) {
          continue;
        }
        try {
          await startConnection(adapter, connection);
        } catch (error) {
          report(error, key);
        }
      }
    });

  return {
    start: reconcile,
    reconcile,
    restart: (kind, key) =>
      serial(async () => {
        const adapter = adapterOf(kind);
        const connection = await adapter.get(key);
        if (connection === undefined) throw new Error(`No ${kind} connection ${key}`);
        await startConnection(adapter, connection);
      }),
    ensure: (kind, key) =>
      serial(async () => {
        const adapter = adapterOf(kind);
        const connection = await adapter.get(key);
        if (connection === undefined) return false;
        if (running.get(key)?.revision !== connection.revision) {
          await startConnection(adapter, connection);
        }
        return running.has(key);
      }),
    prepareAgent: async (tenantId, agentId) => {
      const client = options.clientFor(tenantId);
      if (client === null) throw new Error(`No OpenMA access for tenant ${tenantId}`);
      await ensureAgentMcpServer(client, agentId, {
        name: mcpServerName,
        url: options.mcpServerUrl,
      });
    },
    running: () => [...running.keys()],
    state: (key) => {
      const lastError = lastErrors.get(key);
      return { running: running.has(key), ...(lastError === undefined ? {} : { lastError }) };
    },
    stop: () =>
      serial(async () => {
        const all = [...running.values()];
        running.clear();
        await Promise.all(all.map((r) => r.stop()));
      }),
  };
};
