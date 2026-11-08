import type { SandboxPorts } from "@open-managed-agents/sandbox";
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
  const egress = native?.port ?? createForwarderEgress(adapter.vendor, deps.egress);
  const ports: SandboxPorts<R> = { sandbox: adapter.lifecycle, storage, egress };
  return native?.ingress === undefined ? { ports } : { ports, ingress: native.ingress };
}
