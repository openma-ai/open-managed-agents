// The components a Node control plane is assembled from. Each one is a value:
// construct it yourself, or let nodeDefaults() build it from NodeConfig.
//
//   const config = loadNodeConfig(process.env);
//   const cp = await createNodeControlPlane(await nodeDefaults(config, {
//     sandbox: mySandboxFactory,
//     realtime: { hub: new SqlPollingEventStreamHub({ sql }), description: "sql-poll" },
//     secrets: kmsSecrets,
//     stores: { agents: new MemoryAgentStore() },
//   }));
//
// NodeConfig keeps the plain values (paths, ports, limits); this module is
// where behaviour is chosen.

import type { EmailSender } from "@open-managed-agents/email";
import { NodemailerSender } from "@open-managed-agents/email/adapters/nodemailer";
import type { NodePlatformStores } from "@open-managed-agents/platform-node";
import type { SandboxFactory } from "@open-managed-agents/sandbox";

import { createBetterAuthComponent, type NodeAuth } from "./auth/node-auth.js";
import { createFilesBlobs, createMemoryBlobs, type NodeBlobs } from "./blobs.js";
import type { NodeConfig } from "./config.js";
import { openNodeDatabase, type NodeDatabase } from "./database.js";
import { createNodeRealtime, type NodeRealtime } from "./realtime.js";
import { resolveSandboxProviderForEnvironment } from "./sandbox-provider.js";
import { createNodeSecrets, type NodeSecrets } from "./secrets.js";

// Building blocks. Each default is an ordinary exported constructor, so a
// composition root can call the ones it wants and hand-build the rest.
export { createBetterAuthComponent, type NodeAuth, type NodeAuthSession } from "./auth/node-auth.js";
export { createFilesBlobs, createMemoryBlobs, type FilesBlobs, type MemoryBlobs, type NodeBlobs } from "./blobs.js";
export {
  migrateNodeDatabase,
  openNodeDatabase,
  type NodeDatabase,
  type NodeDatabaseDriver,
  type NodeDialect,
} from "./database.js";
export { createNodeRealtime, type NodeRealtime } from "./realtime.js";
export { InProcessEventStreamHub, type EventStreamHub } from "./lib/event-stream-hub.js";
export { PgEventStreamHub } from "./lib/pg-event-stream-hub.js";
export { SqlPollingEventStreamHub } from "./lib/sql-polling-event-stream-hub.js";
export { createNodeSecrets, type NodeSecrets, type PurposeCipher } from "./secrets.js";

export interface NodeComponents {
  config: NodeConfig;
  database: NodeDatabase;
  /** null: nothing that needs sealing (vault credentials, integrations, …) is available. */
  secrets: NodeSecrets | null;
  /** null: every request is the "default" tenant (AUTH_DISABLED). */
  auth: NodeAuth | null;
  email: EmailSender | null;
  sandbox: SandboxFactory;
  realtime: NodeRealtime;
  blobs: NodeBlobs;
  /** Replace individual managed-platform stores; anything omitted is SQL-backed. */
  stores?: Partial<NodePlatformStores>;
}

export type NodeComponentOverrides = Partial<Omit<NodeComponents, "config">>;

/**
 * Build every component the config asks for, except those the caller
 * already chose. Ownership: the returned database/auth/realtime are stopped
 * by the control plane when it stops, whether they came from here or from
 * the caller.
 */
export async function nodeDefaults(
  config: NodeConfig,
  overrides: NodeComponentOverrides = {},
): Promise<NodeComponents> {
  const database = overrides.database ?? await openNodeDatabase(config.database);
  const email = overrides.email !== undefined
    ? overrides.email
    : config.email === null ? null : new NodemailerSender(config.email);
  const secrets = overrides.secrets !== undefined
    ? overrides.secrets
    : config.platformRootSecret === undefined ? null : createNodeSecrets(config.platformRootSecret);
  const auth = overrides.auth !== undefined
    ? overrides.auth
    : config.auth.disabled ? null : await createBetterAuthComponent({ config, database, email });
  const sandbox = overrides.sandbox ?? await loadSandboxFactory(config);
  const realtime = overrides.realtime ?? await createNodeRealtime(config.realtime, database, {
    ...(config.database.kind === "postgres" && { postgresDsn: config.database.url }),
  });
  const blobs = overrides.blobs ?? {
    memory: await createMemoryBlobs(config.blobs.memory),
    files: createFilesBlobs(config.blobs.files),
  };
  return {
    config,
    database,
    secrets,
    auth,
    email,
    sandbox,
    realtime,
    blobs,
    ...(overrides.stores !== undefined && { stores: overrides.stores }),
  };
}

/**
 * Standalone processes run sessions themselves, so the provider is resolved
 * and its module loaded at startup (a bad SANDBOX_PROVIDER fails fast).
 * Serverless processes hand sessions to an Environment Worker and may never
 * need a sandbox; resolution is deferred to first use, as before.
 */
async function loadSandboxFactory(config: NodeConfig): Promise<SandboxFactory> {
  const load = async (): Promise<SandboxFactory> => {
    const selection = resolveSandboxProviderForEnvironment(config.sandbox.environment);
    const mod = (await import(selection.modulePath)) as { sandboxFactory: SandboxFactory };
    return mod.sandboxFactory;
  };
  if (config.processMode === "standalone") return load();
  let loaded: Promise<SandboxFactory> | undefined;
  return (ctx, env) => (loaded ??= load()).then((factory) => factory(ctx, env));
}
