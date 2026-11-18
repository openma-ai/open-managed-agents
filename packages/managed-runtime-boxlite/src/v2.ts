import type {
  SandboxFactoryContext,
  SandboxFactoryEnv,
} from "@open-managed-agents/sandbox";
import { fromV1SandboxProvider } from "@open-managed-agents/sandbox-port-kit";
import type { SandboxAdapterPort } from "@open-managed-agents/sandbox-port-kit/ports";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import {
  createBoxLiteProvider,
  type BoxLiteManagedRuntime,
  type BoxLiteProviderOptions,
  type BoxLiteProviderPort,
} from "./boxlite";

export interface BoxLiteV2AdapterOptions extends BoxLiteProviderOptions {
  leaseTtlMs: number;
  /** Runtime context used for BoxLite's provider-neutral lifecycle calls. */
  context?(scope: RuntimeResourceScope, plan: unknown): SandboxFactoryContext;
  environment?(scope: RuntimeResourceScope): SandboxFactoryEnv;
}

export interface BoxLiteV2Adapter extends SandboxAdapterPort<BoxLiteManagedRuntime> {
  /** Complete BoxLite provider inventory and native resource surface. */
  readonly boxlite: BoxLiteProviderPort;
}

/**
 * Compose the managed BoxLite provider through the Sandbox SDK v2 lifecycle
 * bridge. Provider-native BoxLite APIs remain available on `boxlite` while
 * the session core receives the standard lifecycle/vendor Ports.
 */
export function createBoxLiteV2Adapter(
  options: BoxLiteV2AdapterOptions,
): BoxLiteV2Adapter {
  const provider = createBoxLiteProvider(options);
  const adapter = fromV1SandboxProvider<BoxLiteManagedRuntime>({
    name: options.providerId,
    provider,
    context: (scope, plan) => options.context?.(scope, plan) ?? {
      sessionId: scope.sessionId,
      workdir: "/workspace",
    },
    env: {},
    leaseTtlMs: options.leaseTtlMs,
    // BoxLite exposes an inventory API, but its REST resource currently has no
    // workspace/session ownership labels. Keep v2 orphan reaping fail-closed
    // until the deployment supplies that binding instead of guessing labels.
    list: async () => [],
  });
  return { ...adapter, boxlite: provider };
}
