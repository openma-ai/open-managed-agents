// Prepared bridge's currently supported native network path. Not selected by
// nodeDefaults: operator authorization and the server must be reviewed first.
import type { RuntimeResourceScope, RuntimeResourceFence } from "@open-managed-agents/runtime-resource-contract";
import type { EgressPolicy, SandboxEgressPort } from "@open-managed-agents/sandbox";
import { compileFirewall, type FirewallRules } from "@open-managed-agents/sandbox-port-kit";

export function createNodeBridgePreparedEgress<R>(options: {
  apply(input: { runtime: R; workspaceId: string; rules: FirewallRules }): Promise<void>;
  authorize(fence: RuntimeResourceFence): Promise<boolean>;
}): SandboxEgressPort<R> {
  const requireScope = (scope: RuntimeResourceScope, fence: RuntimeResourceFence) => {
    if (scope.workspaceId !== fence.workspaceId || scope.sessionId !== fence.sessionId || scope.environmentId !== fence.environmentId || scope.workId !== fence.workId) throw new Error("Prepared bridge scope does not match execution fence");
  };
  const configure = async (input: { runtime: R; scope: RuntimeResourceScope; fence: RuntimeResourceFence; policy: EgressPolicy | null }) => {
    requireScope(input.scope, input.fence);
    if (input.policy && (input.policy.scope.workspaceId !== input.scope.workspaceId || input.policy.scope.sessionId !== input.scope.sessionId)) throw new Error("Prepared bridge policy scope mismatch");
    if (!input.policy || input.policy.networking.type !== "limited" || input.policy.substitutions.length > 0) {
      throw new Error("Prepared bridge currently supports public allowlist egress only; credential relay and unrestricted access are not available");
    }
    if (!await options.authorize(input.fence)) throw new Error("Prepared bridge execution fence is stale");
    await options.apply({ runtime: input.runtime, workspaceId: input.fence.workspaceId,
      rules: compileFirewall(input.policy, { gateway: { hosts: [] }, channels: [] }) });
  };
  return {
    async attach(input) { input.signal.throwIfAborted(); await configure(input); input.signal.throwIfAborted(); },
    update: configure,
    async revoke(input) {
      requireScope(input.scope, input.fence);
      if (!await options.authorize(input.fence)) throw new Error("Prepared bridge execution fence is stale");
      await options.apply({ runtime: input.runtime, workspaceId: input.scope.workspaceId, rules: compileFirewall({
        scope: { workspaceId: input.scope.workspaceId, sessionId: input.scope.sessionId, generation: 0 },
        networking: { type: "limited", hosts: [], packageSources: [], mcpHosts: [] }, substitutions: [],
      }, { gateway: { hosts: [] }, channels: [] }) });
    },
  };
}
