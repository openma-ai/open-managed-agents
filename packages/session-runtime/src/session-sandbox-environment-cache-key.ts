// The environment cache key, shared by every deployment: a content hash of
// everything that changes what an environment snapshot contains. The image
// reference is part of it because a provider may still start a snapshot of an
// older image. Package lists keep their given order (the order the setup
// installs them in). Networking is not part of it (design §0.1 step 1).
//
// WebCrypto only: the same bytes hash the same on Workers and Node.

import { hasEnvironmentPackages, type EnvironmentPackages } from "@open-managed-agents/sandbox";

/** Bump whenever the setup scripts a snapshot contains change (environment
 * packages script, ACP install script, marker format). */
export const ENVIRONMENT_CACHE_SETUP_VERSION = "2026-10-24.1";

/** The pinned registry install a snapshot contains (the non-secret identity). */
export interface EnvironmentCacheAcpInstall {
  package: string;
  version: string;
  nodeMajor: number;
}

export interface EnvironmentCacheKeyInput {
  adapter: string;
  /** The image (digest or reference) the plan starts from. */
  image: string;
  /** Catalog alias; it counts too, since the setup markers carry it. */
  imageAlias?: string;
  packages?: EnvironmentPackages;
  pipIndexUrl?: string;
  acp: EnvironmentCacheAcpInstall | null;
  setupVersion?: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key, or null when there is nothing worth caching (no packages and no
 * pinned ACP install). */
export async function environmentCacheKey(input: EnvironmentCacheKeyInput): Promise<string | null> {
  const packages = hasEnvironmentPackages(input.packages) ? input.packages! : undefined;
  if (packages === undefined && input.acp === null) return null;
  const pipIndexUrl = input.pipIndexUrl?.trim();
  return sha256(JSON.stringify({
    v: 2,
    adapter: input.adapter,
    image: input.image,
    alias: input.imageAlias ?? null,
    packages: {
      apt: [...(packages?.apt ?? [])],
      pip: [...(packages?.pip ?? [])],
      npm: [...(packages?.npm ?? [])],
      cargo: [...(packages?.cargo ?? [])],
      go: [...(packages?.go ?? [])],
    },
    pipIndexUrl: pipIndexUrl ? await sha256(pipIndexUrl) : null,
    acp: input.acp === null ? null : { package: input.acp.package, version: input.acp.version, nodeMajor: input.acp.nodeMajor },
    setup: input.setupVersion ?? ENVIRONMENT_CACHE_SETUP_VERSION,
  }));
}
