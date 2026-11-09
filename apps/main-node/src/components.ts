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

import { NodemailerSender } from "@open-managed-agents/email/adapters/nodemailer";
import {
  createNodeSecrets,
  sandboxIdlePauseMs,
  type NodeComponentOverrides,
  type NodeComponents,
  type NodeSessionSandboxProvider,
} from "@open-managed-agents/control-plane-node";
import type { SandboxFactory, SandboxPort, SandboxProviderPort, SandboxRuntimePort } from "@open-managed-agents/sandbox";
import type { E2BModule } from "@open-managed-agents/sandbox-adapter-e2b";

import { createBetterAuthComponent } from "./auth/node-auth.js";
import { createFilesBlobs, createMemoryBlobs } from "./blobs.js";
import type { NodeConfig } from "./config.js";
import { openNodeDatabase } from "./database.js";
import { createNodeE2BSessionAdapter } from "./e2b-session-adapter.js";
import { createNodeRealtime } from "./realtime.js";
import { resolveSandboxProviderForEnvironment } from "./sandbox-provider.js";

// Building blocks. Each default is an ordinary exported constructor, so a
// composition root can call the ones it wants and hand-build the rest.
export {
  createBetterAuthComponent,
  type BetterAuthComponentOptions,
  type NodeAuth,
  type NodeAuthSession,
  type NodeSignInMethods,
} from "./auth/node-auth.js";
export type { OidcSignInProvider } from "@open-managed-agents/auth-config";
export { createFilesBlobs, createMemoryBlobs } from "./blobs.js";
export type {
  FilesBlobs,
  MemoryBlobs,
  NodeBlobs,
  NodeComponentOverrides,
  NodeComponents,
  NodeRealtime,
} from "@open-managed-agents/control-plane-node";
export {
  migrateNodeDatabase,
  openNodeDatabase,
  type NodeAuthDatabase,
  type NodeAuthDatabaseOptions,
  type NodeDatabase,
  type NodeDialect,
} from "./database.js";
export { createNodeRealtime } from "./realtime.js";
export {
  createNodeSecrets,
  InProcessEventStreamHub,
  SqlPollingEventStreamHub,
  type EventStreamHub,
  type NodeSecrets,
  type PurposeCipher,
} from "@open-managed-agents/control-plane-node";
export { PgEventStreamHub } from "./lib/pg-event-stream-hub.js";

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
  const sessionSandboxAdapter = overrides.sessionSandboxAdapter
    ?? (overrides.sandbox === undefined ? await loadSessionSandboxAdapter(config) : undefined);
  const sessionSandboxProvider = overrides.sessionSandboxProvider
    ?? (overrides.sandbox === undefined && sessionSandboxAdapter === undefined ? await loadSessionSandboxProvider(config) : undefined);
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
    ...(sessionSandboxAdapter !== undefined && { sessionSandboxAdapter }),
    ...(sessionSandboxProvider !== undefined && { sessionSandboxProvider }),
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
    if (selection.provider === "e2b") {
      // The adapter declares `e2b` only as an optional peer: main-node's own
      // dependency is the install that resolves, so the SDK is injected.
      const [adapter, sdk] = await Promise.all([import("@open-managed-agents/sandbox-adapter-e2b"), import("e2b")]);
      return adapter.createE2BSandboxFactory(sdk as unknown as E2BModule);
    }
    const mod = (await import(selection.modulePath)) as { sandboxFactory: SandboxFactory };
    return mod.sandboxFactory;
  };
  if (config.processMode === "standalone") return load();
  let loaded: Promise<SandboxFactory> | undefined;
  return (ctx, env) => (loaded ??= load()).then((factory) => factory(ctx, env));
}

/**
 * The provider's Sandbox SDK v2 adapter for Session sandboxes, where one
 * exists (SANDBOX_PROVIDER=e2b); every other provider runs its v1 factory
 * through the v1 bridge. Standalone only: a serverless process hands its
 * sessions to an Environment Worker.
 */
async function loadSessionSandboxAdapter(config: NodeConfig) {
  if (config.processMode !== "standalone") return undefined;
  const selection = resolveSandboxProviderForEnvironment(config.sandbox.environment);
  const environment = config.sandbox.environment;
  return selection.provider === "e2b" ? createNodeE2BSessionAdapter(environment, sandboxIdlePauseMs(environment.SANDBOX_IDLE_PAUSE_MS)) : undefined;
}

/** The provider names whose module exports a v1 SandboxProviderPort
 * (`sandboxProvider`), as their runtimeHandle().provider. */
const SESSION_SANDBOX_PROVIDERS: Partial<Record<string, string>> = {
  "test-local-subprocess": "local-subprocess",
  opensandbox: "opensandbox",
};

/** The provider's v1 SandboxProviderPort, when its module exports one
 * (design §0.0b A.8): Session sandboxes are then found again by their
 * persisted handle. Other providers keep the v1 factory alone. */
async function loadSessionSandboxProvider(config: NodeConfig): Promise<NodeSessionSandboxProvider | undefined> {
  if (config.processMode !== "standalone") return undefined;
  const selection = resolveSandboxProviderForEnvironment(config.sandbox.environment);
  const name = SESSION_SANDBOX_PROVIDERS[selection.provider];
  if (name === undefined) return undefined;
  const mod = (await import(selection.modulePath)) as { sandboxProvider?: SandboxProviderPort<SandboxPort & SandboxRuntimePort> };
  if (mod.sandboxProvider === undefined) throw new Error(`SANDBOX_PROVIDER=${selection.provider}: ${selection.modulePath} exports no sandboxProvider`);
  return { name, provider: mod.sandboxProvider };
}
