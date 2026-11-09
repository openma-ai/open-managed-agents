import { attemptOfFence } from "@open-managed-agents/session-runtime/session-sandbox-fence";
import type { SandboxEgressPort, SandboxPorts } from "@open-managed-agents/sandbox";
import { createForwarderEgress } from "./forwarder-egress";
import type { EgressIngress, SandboxAdapterPort, SandboxPortDeps } from "./ports";
import { createSyncStorage } from "./sync-storage";

/** Composition (design §0.2): native when the adapter supplies it, generic
 * otherwise. The only place that decides; called once per deployment. */
export function createSandboxPorts<R extends object>(
  adapter: SandboxAdapterPort<R>,
  deps: SandboxPortDeps,
): { ports: SandboxPorts<R>; ingress?: EgressIngress } {
  const storage = adapter.native?.storage?.(deps.storage) ?? createSyncStorage(adapter.vendor, deps.storage);
  const native = adapter.native?.egress?.(deps.egress);
  const delivery = native?.port ?? createForwarderEgress(adapter.vendor, deps.egress);
  // Every runtime attach/update crosses the authority before any consumer,
  // including native/no-relay adapters and Sessions without Vault credentials.
  // The authority's shared holder alone decides reuse, rotation and revocation.
  const bind = async (input: Parameters<SandboxEgressPort<R>["attach"]>[0]) => {
    input.signal.throwIfAborted();
    const attempt = attemptOfFence(input.fence);
    if (attempt !== null) await deps.egress.gateway.issueToken({
      scope: input.scope, attempt, sandbox: await adapter.vendor.sandboxIdentity?.(input.runtime) ?? input.runtime,
    });
    input.signal.throwIfAborted();
  };
  const egress: SandboxEgressPort<R> = {
    async attach(input) { await bind(input); await delivery.attach(input); },
    async update(input) { await bind({ ...input, signal: new AbortController().signal }); await delivery.update(input); },
    revoke: input => delivery.revoke(input),
  };
  const ports: SandboxPorts<R> = { sandbox: adapter.lifecycle, storage, egress };
  return native?.ingress === undefined ? { ports } : { ports, ingress: native.ingress };
}
