// createForwarderEgress (design §0.2): policy first, Vault second. The
// provider firewall (when the vendor can apply one at runtime) carries the
// policy; the in-sandbox forwarder is installed only when there are
// substitutions and sends only credential hosts to the gateway.

import type { EgressPolicy, SandboxEgressPort, SandboxPort } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { clearSandboxEgress, prepareSandboxEgress } from "@open-managed-agents/sandbox-egress";
import { attemptOfFence } from "@open-managed-agents/session-runtime/session-sandbox-fence";
import { compileFirewall } from "./firewall";
import type { SandboxEgressDepsPort, SandboxVendorPort } from "./ports";
import { v1FileView } from "./sync-storage";

/**
 * The token is delivered through a one-use 0600 binding file; the relay
 * reads it into memory and immediately deletes the file. The CA key is not
 * on tmpfs. The loopback port is stable for the sandbox (18080 in isolated
 * networks, allocated per local Session), so inherited proxies survive restart.
 * The relay bundle is embedded in sandbox-egress, so Workers hosts install
 * it too; the sandbox image needs `node`.
 */
export function createForwarderEgress<R extends object>(
  vendor: SandboxVendorPort<R>,
  deps: SandboxEgressDepsPort,
): SandboxEgressPort<R> {
  const views = new WeakMap<R, SandboxPort>();
  const view = (runtime: R) => {
    const own = vendor.asSandboxPort?.(runtime);
    if (own !== undefined) return own;
    let port = views.get(runtime);
    if (port === undefined) {
      port = v1FileView(vendor, runtime);
      views.set(runtime, port);
    }
    return port;
  };
  const gatewayHost = new URL(deps.gateway.endpoint.url).hostname;
  const configure = async (input: {
    runtime: R;
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    policy: EgressPolicy | null;
    signal: AbortSignal;
  }) => {
    input.signal.throwIfAborted();
    if (vendor.applyFirewall !== undefined) {
      await vendor.applyFirewall(input.runtime, compileFirewall(input.policy, {
        gateway: { hosts: [gatewayHost], ...(deps.gateway.endpoint.fixedIps === undefined ? {} : { fixedIps: deps.gateway.endpoint.fixedIps }) },
        channels: [...(await deps.channels?.(input.scope) ?? [])],
      }));
    }
    const substitutions = input.policy?.substitutions ?? [];
    if (substitutions.length === 0) {
      await clearSandboxEgress(view(input.runtime));
      return;
    }
    const placeholders = Object.fromEntries(substitutions.map((item) => [item.envName, item.placeholder]));
    await prepareSandboxEgress({
      sandbox: view(input.runtime),
      scope: {
        workspaceId: input.scope.workspaceId,
        sessionId: input.scope.sessionId,
        vaultIds: [...new Set(substitutions.map((item) => item.credentialId))],
      },
      relay: { endpoint: deps.gateway.endpoint.url },
      issueToken: async () => deps.gateway.issueToken({ scope: input.scope, attempt: attemptOfFence(input.fence), sandbox: await vendor.sandboxIdentity?.(input.runtime) ?? input.runtime }),
      placeholders: async () => placeholders,
    });
    input.signal.throwIfAborted();
  };
  return {
    attach: configure,
    async update(input) {
      await configure({ ...input, signal: new AbortController().signal });
    },
    async revoke(input) {
      await clearSandboxEgress(view(input.runtime));
    },
  };
}
