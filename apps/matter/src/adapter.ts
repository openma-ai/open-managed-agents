/**
 * What the host needs from one kind of integration (Feishu, GitLab, …) to run
 * a connection (a Bond: a linked Feishu app or GitLab instance): the
 * connections users made, and for each one the OpenMatter integrations, the
 * Loops users configured on it, and the event source. The host owns the
 * rest, the same for every kind: a store and inbox per connection, the
 * OpenMA connector and Agent driver, and the durable intake runtime.
 */

import type { LongConnectionSource } from "@openma/matter-host-local/runtime";
import type { ImageLoader } from "./images.js";
import type { LoopRecord } from "./persistence.js";
import type { createOpenMatter } from "@openma/matter/runtime";

export type MatterApplication = ReturnType<typeof createOpenMatter>;
export type MatterIntegrations = Parameters<typeof createOpenMatter>[0]["integrations"];

/** One connection a user made, as the host sees it. */
export interface MatterConnection {
  /** Unique across every adapter; also names the data directory
   * (`<dataDir>/apps/<key>/`), so it must be a safe path segment. */
  readonly key: string;
  /** The OpenMA workspace the connection belongs to. */
  readonly tenantId: string;
  /** The enabled Loops on this connection; each names its Agent in its
   * configuration. A connection without one does not run. */
  readonly loops: readonly LoopRecord[];
  /** Names the connection in logs and errors, for example `Feishu app cli_…`. */
  readonly label: string;
  /** Changes whenever the saved connection changes; a replica running an
   * older revision starts the connection again. */
  readonly revision: string;
}

/** How one connection is wired into an OpenMatter application. */
export interface MatterWiring {
  readonly integrations: MatterIntegrations;
  /** Install the connection's Loops. */
  readonly install: (application: MatterApplication, loops: readonly LoopRecord[]) => void;
  /** Delivers the provider's events; the host persists each in the inbox
   * before the source acknowledges it. */
  readonly source: LongConnectionSource;
  /** Downloads an image of one of this connection's messages, so the Agent
   * sees it. Without it the Agent only sees the image's id. */
  readonly image?: ImageLoader;
}

export interface MatterAdapter<C extends MatterConnection = MatterConnection> {
  /** `feishu`, `gitlab`, … */
  readonly kind: string;
  /** Every saved connection of this kind. */
  list(): Promise<readonly C[]>;
  get(key: string): Promise<C | undefined>;
  /** `report` receives errors the source sees after it started. */
  wire(connection: C, report: (error: unknown) => void): MatterWiring;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The connection's revision: the Bond's and every enabled Loop's. */
export const connectionRevision = (bondRevision: string, loops: readonly LoopRecord[]): string =>
  [bondRevision, ...loops.map((loop) => `${loop.id}@${loop.updatedAt}`)].join("|");

/** Enabled Loops of every connection of one kind, by connection key. */
export const enabledLoopsByBond = (
  loops: readonly LoopRecord[],
  kind: string,
): Map<string, LoopRecord[]> => {
  const byKey = new Map<string, LoopRecord[]>();
  for (const loop of loops) {
    if (loop.bondKind !== kind || !loop.enabled) continue;
    byKey.set(loop.bondKey, [...(byKey.get(loop.bondKey) ?? []), loop]);
  }
  return byKey;
};

/** Whether `key` is safe as a directory name (SQLite) or partition (MySQL). */
export const isSafeConnectionKey = (key: string): boolean =>
  SAFE_KEY.test(key) && !key.includes("..");
