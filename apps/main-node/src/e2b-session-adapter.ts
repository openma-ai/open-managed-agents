// SANDBOX_PROVIDER=e2b: Session sandboxes go through the native Sandbox SDK v2
// E2B adapter (research/sandbox-sdk-v2-design.md §0.2) under the shared
// Session sandbox core. The `e2b` SDK is this application's dependency (the
// adapter only declares it as an optional peer), so it is loaded here and
// handed to the adapter.

import type { NodeSessionSandboxAdapter } from "@open-managed-agents/control-plane-node";
import { readS3MemoryBucket } from "@open-managed-agents/sandbox";
import {
  createE2BV2Adapter,
  E2B_SANDBOX_DIRECTORIES,
  type E2BV2Module,
} from "@open-managed-agents/sandbox-adapter-e2b/v2";

/** E2B lease (idle reclaim) when E2B_SANDBOX_TIMEOUT_MS is unset; renewed by keepAlive. */
export const DEFAULT_E2B_LEASE_MS = 30 * 60_000;

export async function createNodeE2BSessionAdapter(
  env: Readonly<Record<string, string | undefined>>,
  loadSdk: () => Promise<unknown> = () => import("e2b"),
): Promise<NodeSessionSandboxAdapter> {
  const maxLifetimeMs = positiveMs(env, "E2B_MAX_LIFETIME_MS");
  if (maxLifetimeMs === undefined) {
    throw new TypeError(
      "E2B_MAX_LIFETIME_MS is required with SANDBOX_PROVIDER=e2b: the account plan's continuous-run cap in milliseconds (Hobby 3600000, Pro 86400000)",
    );
  }
  const leaseMs = positiveMs(env, "E2B_SANDBOX_TIMEOUT_MS") ?? DEFAULT_E2B_LEASE_MS;
  const memoryBucket = readS3MemoryBucket(env);
  const adapter = createE2BV2Adapter({
    sdk: (await loadSdk()) as E2BV2Module,
    connection: {
      ...(env.E2B_API_KEY === undefined ? {} : { apiKey: env.E2B_API_KEY }),
      ...(env.E2B_API_URL === undefined ? {} : { apiUrl: env.E2B_API_URL }),
      ...(env.E2B_SANDBOX_URL === undefined ? {} : { sandboxUrl: env.E2B_SANDBOX_URL }),
      ...(env.E2B_DOMAIN === undefined ? {} : { domain: env.E2B_DOMAIN }),
    },
    leaseMs,
    maxLifetimeMs,
    // A base template's default user cannot create /mnt mount points.
    user: "root",
    setup: E2B_SANDBOX_DIRECTORIES,
    // The executor's s3fs mounts for Node's outputs and native Memory Store calls.
    ...(memoryBucket === undefined ? {} : { memoryBucket }),
  });
  const template = env.SANDBOX_IMAGE;
  return {
    adapter,
    // An Environment-selected catalog image overrides the process default.
    image: (catalogImage) => catalogImage?.reference ?? template ?? "base",
    keepAliveMs: Math.floor(leaseMs / 3),
  };
}

function positiveMs(env: Readonly<Record<string, string | undefined>>, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new TypeError(`${name} must be a positive integer of milliseconds`);
  return ms;
}
