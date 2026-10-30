// @open-managed-agents/control-plane-node: the OpenMA control plane for Node,
// independent of any database driver, blob backend, sandbox provider, or
// identity provider. A distribution builds NodeComponents (database, auth,
// blobs, sandbox, realtime, secrets, email) and passes them to
// createNodeControlPlane(); serveNodeControlPlane() listens.
//
// The OMA default distribution, which picks adapters from environment
// variables, is @open-managed-agents/main-node.

export {
  createNodeControlPlane,
  type NodeControlPlane,
  type NodeControlPlaneApp,
} from "./control-plane.js";
export { serveNodeControlPlane, type NodeServer, type ServeNodeControlPlaneOptions } from "./serve.js";

export type { NodeComponentOverrides, NodeComponents, NodeRealtime } from "./components.js";
export type { NodeAuth, NodeAuthSession, NodeSignInMethods } from "./auth.js";
export type {
  FilesBlobs,
  MemoryBlobPollerContext,
  MemoryBlobs,
  NodeBlobs,
  S3Location,
} from "./blobs.js";
export {
  redactNodeConfig,
  type BlobBackendConfig,
  type DatabaseConfig,
  type NodeConfig,
  type NodeEnvironment,
  type NodeProcessMode,
  type RealtimeFanoutConfig,
  type RealtimeFanoutMode,
  type SandboxEgressProxyConfig,
  type SandboxEgressProxySettings,
} from "./config.js";
export type {
  NodeAuthDatabase,
  NodeAuthDatabaseOptions,
  NodeDatabase,
  NodeDialect,
} from "@open-managed-agents/node-database";
export { createNodeSecrets, type NodeSecrets, type PurposeCipher } from "./secrets.js";
export { ensureTenantSqlite } from "./tenants.js";

export {
  createManagedSessionRealtimeHub,
  InProcessEventStreamHub,
  type EventStreamHub,
  type EventStreamHubAttachOptions,
  type EventWriter,
} from "./lib/event-stream-hub.js";
export { SqlPollingEventStreamHub, type SqlPollingEventStreamHubOptions } from "./lib/sql-polling-event-stream-hub.js";
export { parseAllowHosts } from "./lib/skill-sources.js";

// Deployment composition: register code-owned harnesses before creating sessions.
// The registry is process-scoped, shared by discovery and both session resolvers.
export {
  registerHarness,
  setDefaultHarness,
  getHarnessCatalog,
  type HarnessFactory,
  type HarnessDescriptor,
  type HarnessCatalog,
  type HarnessExecutionPlacement,
} from "@open-managed-agents/agent/harness/registry";
export type { HarnessInterface, HarnessContext } from "@open-managed-agents/agent/harness/interface";
