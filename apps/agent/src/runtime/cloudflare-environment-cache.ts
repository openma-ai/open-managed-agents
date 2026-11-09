// Cloudflare composition of the shared environment cache (session-runtime
// EnvironmentCache and environmentCacheKey, design §0.0 rule 13). Lookup,
// expiry, warnings and the build lifecycle are the core's; this file only
// supplies what is Cloudflare's:
//   - records in the tenant D1 kv_entries table (strongly consistent: a
//     Session started right after a build sees it, which KV would not
//     guarantee); one row per workspace and key;
//   - the key: the image digest from ctx.container.images (a snapshot of an
//     older image still starts it), the packages, the adapter;
//   - the build sandbox: its own Sandbox Durable Object (the build id), no
//     outputs, Memory or Vault, egress limited to public package sources and
//     passed through without credentials, then the same setup a Session runs
//     (ensureEnvironmentPackages), so a Session started from the snapshot
//     finds its setup markers and installs nothing.
// Retention: container snapshots expire 30 days after creation or their last
// restore and cannot be deleted, so both TTLs stay under that cap.

import {
  EnvironmentCache,
  environmentCacheKey,
  type EnvironmentCacheStore,
  type EnvironmentCacheWarning,
  type SessionEnvironmentCache,
} from "@open-managed-agents/session-runtime";
import { ensureEnvironmentPackages, type EnvironmentPackages, type SandboxLifecyclePort } from "@open-managed-agents/sandbox";
import { PACKAGE_HOSTS } from "@open-managed-agents/sandbox-port-kit";
import { log, logWarn } from "@open-managed-agents/shared";
import { CLOUDFLARE_ADAPTER, CLOUDFLARE_SNAPSHOT_RETENTION_MS, type CloudflareSandboxRuntime } from "./cloudflare-sandbox-ports";

const OP = "agent.environment_cache";
/** Plan image when the Sandbox Durable Object cannot name its digest; no key then. */
export const UNKNOWN_SANDBOX_IMAGE = "deployment";
/** session-runtime buildEnvironmentSnapshot names build sandboxes so. */
const BUILD_ID_PREFIX = "env_snapshot_";

export const isEnvironmentBuildId = (sessionId: string): boolean => sessionId.startsWith(BUILD_ID_PREFIX);

/** What a build sandbox may reach: the public package sources a Session's
 * own setup uses. No gateway, Vault, R2 or Environment host. */
export const ENVIRONMENT_BUILD_HOSTS: readonly string[] = Object.freeze([...PACKAGE_HOSTS]);

/** The Environment setup a Session asks for. */
export interface CloudflareEnvironmentSetup {
  environmentId: string;
  packages: EnvironmentPackages;
}

/** kv_entries of the tenant's D1, scoped to one workspace. */
export function d1EnvironmentCacheStore(db: D1Database, workspaceId: string): EnvironmentCacheStore {
  return {
    async retiredKeys(prefix, cursor, limit) {
      const page = await db.prepare("SELECT key FROM kv_entries WHERE tenant_id = ? AND substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?")
        .bind(workspaceId, prefix.length, prefix, cursor, limit).all<{ key: string }>();
      const keys = page.results.map(row => row.key);
      return { keys, cursor: keys.length === limit ? keys[keys.length - 1]! : "" };
    },
    async compareAndSwap(key, expected, value) {
      const statement = expected === null
        ? db.prepare("INSERT INTO kv_entries (tenant_id, key, value, expires_at) VALUES (?, ?, ?, NULL) ON CONFLICT (tenant_id, key) DO NOTHING").bind(workspaceId, key, value)
        : value === null
          ? db.prepare("DELETE FROM kv_entries WHERE tenant_id = ? AND key = ? AND value = ?").bind(workspaceId, key, expected)
          : db.prepare("UPDATE kv_entries SET value = ?, expires_at = NULL WHERE tenant_id = ? AND key = ? AND value = ?").bind(value, workspaceId, key, expected);
      if (expected === null && value === null) return (await this.get(key)) === null;
      return (await statement.run()).meta.changes === 1;
    },
    async get(key) {
      const row = await db.prepare("SELECT value, expires_at FROM kv_entries WHERE tenant_id = ? AND key = ?")
        .bind(workspaceId, key).first<{ value: string; expires_at: number | null }>();
      if (row === null) return null;
      return row.expires_at !== null && row.expires_at <= Date.now() ? null : row.value;
    },
    async put(key, value) {
      await db.prepare(
        "INSERT INTO kv_entries (tenant_id, key, value, expires_at) VALUES (?, ?, ?, NULL) " +
        "ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, expires_at = NULL",
      ).bind(workspaceId, key, value).run();
    },
    async delete(key) {
      await db.prepare("DELETE FROM kv_entries WHERE tenant_id = ? AND key = ?").bind(workspaceId, key).run();
    },
  };
}

export interface CloudflareEnvironmentCacheOptions {
  /** The adapter's own lifecycle (the build sandbox is not the Session's). */
  lifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime>;
  sessionLifecycle?: SandboxLifecyclePort<CloudflareSandboxRuntime>;
  storeFor(workspaceId: string): EnvironmentCacheStore;
  /** The Session's Environment setup now; null = nothing to install. */
  setup(): Promise<CloudflareEnvironmentSetup | null>;
  warn(warning: EnvironmentCacheWarning): void;
  /** Keeps the background build alive past the request that started it. */
  waitUntil(promise: Promise<unknown>): void;
  /** Build sandbox setup; defaults to the Session's own setup steps. */
  build?(runtime: CloudflareSandboxRuntime, setup: CloudflareEnvironmentSetup): Promise<void>;
  clock?: { now(): number };
}

/** The environment cache of one SessionDO, as the core takes it. */
export function createCloudflareEnvironmentCache(options: CloudflareEnvironmentCacheOptions): SessionEnvironmentCache<CloudflareSandboxRuntime> & { idle(): Promise<void> } {
  const cache = new EnvironmentCache<CloudflareSandboxRuntime, CloudflareEnvironmentSetup>({
    adapter: CLOUDFLARE_ADAPTER,
    lifecycle: options.lifecycle,
    ...(options.sessionLifecycle === undefined ? {} : { sessionLifecycle: options.sessionLifecycle }),
    storeFor: options.storeFor,
    restrictEgress: (runtime) => runtime.restrictOutboundToHosts([...ENVIRONMENT_BUILD_HOSTS]),
    setup: (runtime, setup) => (options.build ?? buildEnvironment)(runtime, setup),
    maxRetentionMs: CLOUDFLARE_SNAPSHOT_RETENTION_MS,
    logger: {
      info: (fields, message) => log({ ...fields }, message),
      warn: (fields, message) => logWarn({ ...fields }, message),
    },
    op: OP,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    async acquire({ scope, plan, signal }) {
      const setup = await options.setup();
      const key = setup === null ? null : await environmentKey(setup, plan.from);
      return cache.acquire({
        scope, plan, signal, key, warn: options.warn,
        setup: setup as CloudflareEnvironmentSetup,
        fields: { environmentId: scope.environmentId },
      });
    },
    prepared(scope) {
      cache.prepared(scope);
      options.waitUntil(cache.idle());
    },
    idle: () => cache.idle(),
  };
}

/** null when the image digest is unknown: a key without it would hand out
 * snapshots of an older image after a deploy. */
export async function environmentKey(setup: CloudflareEnvironmentSetup, from: { image: string } | object): Promise<string | null> {
  if (!("image" in from) || from.image === UNKNOWN_SANDBOX_IMAGE || from.image.length === 0) return null;
  return environmentCacheKey({ adapter: CLOUDFLARE_ADAPTER, image: from.image, packages: setup.packages, acp: null });
}

/** The Session's own setup steps on the build sandbox; a failure fails the build. */
async function buildEnvironment(runtime: CloudflareSandboxRuntime, setup: CloudflareEnvironmentSetup): Promise<void> {
  const result = await ensureEnvironmentPackages(
    { exec: (command: string, timeout?: number) => runtime.exec(command, timeout) },
    setup.packages,
  );
  if (result.error !== undefined) throw new Error(`Environment setup failed at ${result.path}: ${result.error}`);
}
