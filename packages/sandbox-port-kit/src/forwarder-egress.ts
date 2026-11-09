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
 * Known gaps of the reused installer (§0.2 table), not changed here: the
 * relay token is persisted in the sandbox's binding file rather than held
 * only in memory and the CA key is not on tmpfs. The relay uses the shared
 * fixed loopback port so inherited proxy environments survive a restart.
 * The relay bundle is embedded in sandbox-egress, so Workers hosts install
 * it too; the sandbox image needs `node`.
 */
export function createForwarderEgress<R extends object>(
  vendor: SandboxVendorPort<R>,
  deps: SandboxEgressDepsPort,
): SandboxEgressPort<R> {
  const views = new WeakMap<R, SandboxPort>();
  // attach/update are re-entrant. Re-delivering a policy to the same live
  // runtime must not ask the authority to rotate the attempt token. A new
  // runtime (sandbox replacement), attempt, or revoke starts a new delivery.
  const tokens = new WeakMap<R, { key: string; token: Promise<string> }>();
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
      issueToken: () => {
        const attempt = attemptOfFence(input.fence);
        const key = JSON.stringify([input.scope.workspaceId, input.scope.sessionId, attempt]);
        const held = tokens.get(input.runtime);
        if (held?.key === key) return held.token;
        const entry = { key, token: deps.gateway.issueToken({ scope: input.scope, attempt }) };
        tokens.set(input.runtime, entry);
        entry.token.catch(() => { if (tokens.get(input.runtime) === entry) tokens.delete(input.runtime); });
        return entry.token;
      },
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
      tokens.delete(input.runtime);
      await clearSandboxEgress(view(input.runtime));
    },
  };
}
