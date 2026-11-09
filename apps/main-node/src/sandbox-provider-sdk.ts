// The isolated sandbox adapters import their vendor SDK lazily, and declare it
// as an *optional* peer dependency: the monorepo install stays provider-neutral
// (`autoInstallPeers: false` in pnpm-workspace.yaml) so a deployment installs
// only the SDK for the adapter it selects. Nothing verified that the selected
// adapter actually had its SDK, and the bundled image installs none for most
// providers — so `SANDBOX_PROVIDER=e2b` booted happily and then failed on the
// *first session turn* with three retried sandbox errors and
// `retries_exhausted`.
//
// Resolve the SDK while the provider is resolved, so a missing one fails at
// startup with the command that fixes it. Resolution only — importing would
// load a vendor binary for no reason.

import { createRequire } from "node:module";

import type { NodeSandboxProvider } from "./sandbox-provider.js";

/**
 * Vendor SDK each provider's adapter imports at runtime. `boxrun` speaks HTTP
 * to an external `boxlite serve` and has no client SDK.
 */
export const SANDBOX_PROVIDER_SDK_PACKAGES: Partial<Record<NodeSandboxProvider, string>> = {
  sprites: "@fly/sprites",
  litebox: "@boxlite-ai/boxlite",
  boxlite: "@boxlite-ai/boxlite",
  daytona: "@daytonaio/sdk",
  opensandbox: "@alibaba-group/opensandbox",
  e2b: "e2b",
};

export function sandboxProviderSdkMissingMessage(provider: NodeSandboxProvider, packageName: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `SANDBOX_PROVIDER=${provider} requires the "${packageName}" SDK, which is not installed (${detail}). `
    + `Install it with \`pnpm add -w ${packageName}\` for a native deployment, or rebuild the Docker image `
    + `with \`SANDBOX_PROVIDERS=${packageName}\` (for example `
    + `\`SANDBOX_PROVIDERS=${packageName} docker compose build\`). `
    + `Provider SDKs are optional peers of the adapter packages, so no sandbox can start without one.`;
}

/** How the SDK is located, given the adapter module the provider resolved to. */
export type SandboxSdkResolver = (adapterModulePath: string, packageName: string) => string;

const resolveFromAdapter: SandboxSdkResolver = (adapterModulePath, packageName) => {
  const fromMainNode = createRequire(import.meta.url);
  // pnpm nests dependencies per package, so resolving from this file would miss
  // an SDK that lives in the adapter's own node_modules (or is a devDependency
  // of it, as `@boxlite-ai/boxlite` and `@alibaba-group/opensandbox` are).
  return createRequire(fromMainNode.resolve(adapterModulePath)).resolve(packageName);
};

/**
 * Throws when the selected provider needs a vendor SDK that cannot be resolved.
 * Providers without an SDK (`boxrun`) and the local test adapter pass through.
 */
export function assertSandboxProviderSdk(
  selection: { provider: NodeSandboxProvider | "test-local-subprocess"; modulePath: string },
  resolve: SandboxSdkResolver = resolveFromAdapter,
): void {
  if (selection.provider === "test-local-subprocess") return;
  const packageName = SANDBOX_PROVIDER_SDK_PACKAGES[selection.provider];
  if (packageName === undefined) return;
  try {
    resolve(selection.modulePath, packageName);
  } catch (cause) {
    throw new Error(sandboxProviderSdkMissingMessage(selection.provider, packageName, cause), { cause });
  }
}
