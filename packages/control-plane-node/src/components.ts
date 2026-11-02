// The components a Node control plane is assembled from. A distribution
// builds each one (or reuses a default) and hands the set to
// createNodeControlPlane(). The OMA default distribution builds them from
// environment variables in @open-managed-agents/main-node/components
// (nodeDefaults); another distribution may wire different adapters.
//
// Nothing here opens a connection or picks a driver.

import type { EmailSender } from "@open-managed-agents/email";
import type { NodeDatabase } from "@open-managed-agents/node-database";
import type { NodePlatformStores } from "@open-managed-agents/platform-node";
import type { SandboxFactory } from "@open-managed-agents/sandbox";

import type { NodeAuth } from "./auth.js";
import type { NodeBlobs } from "./blobs.js";
import type { NodeConfig } from "./config.js";
import type { EventStreamHub } from "./lib/event-stream-hub.js";
import type { NodeSecrets } from "./secrets.js";

export interface NodeRealtime {
  /** Fanout for legacy /v1/oma event streams. */
  hub: EventStreamHub;
  /**
   * How official /v1 Session streams see events produced on other replicas:
   * null means this is the only replica and the in-memory runtime stream is
   * complete; otherwise each replica also tails the canonical SQL projection
   * at this interval.
   */
  replicaSync: { pollIntervalMs: number } | null;
  /** Shown in /health as backends.hub. */
  description: string;
  stop?(): Promise<void> | void;
}

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
