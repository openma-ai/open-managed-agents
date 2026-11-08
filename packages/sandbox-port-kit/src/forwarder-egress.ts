// createForwarderEgress (design §0.2): policy first, Vault second. The
// provider firewall (when the vendor can apply one at runtime) carries the
// policy; the in-sandbox forwarder is installed only when there are
// substitutions and sends only credential hosts to the gateway.

import type { EgressPolicy, SandboxEgressPort, SandboxPort } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { clearSandboxEgress, prepareSandboxEgress } from "@open-managed-agents/sandbox-egress";
import { compileFirewall } from "./firewall";
import type { SandboxEgressDepsPort, SandboxVendorPort } from "./ports";
import { v1FileView } from "./sync-storage";

/**
 * Known gaps of the reused installer (§0.2 table), not changed here: the
 * relay token is persisted in the sandbox's binding file rather than held
 * only in memory, the CA key is not on tmpfs, and the relay port is random.
 * The relay bundle is embedded in sandbox-egress, so Workers hosts install
 * it too; the sandbox image needs `node`.
 */
export function createForwarderEgress<R extends object>(
  vendor: SandboxVendorPort<R>,
  deps: SandboxEgressDepsPort,
): SandboxEgressPort<R> {
  const views = new WeakMap<R, SandboxPort>();
  const view = (runtime: R) => {
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
        channels: [],
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
      relay: { endpoint: deps.gateway.endpoint.url, pass: "" },
      issuePass: () => deps.gateway.issueToken({ scope: input.scope, fence: input.fence }),
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
