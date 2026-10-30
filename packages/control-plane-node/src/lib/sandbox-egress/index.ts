/**
 * Sandbox egress proxy composition: CA, pass authority and listener from
 * configuration. See ./proxy.ts for the request path.
 */
import type { SandboxEgressProxySettings } from "../../config.js";
import { createEgressCertificateAuthority, loadOrCreateEgressCa } from "./ca.js";
import type { SandboxEgressSettings } from "./environment.js";
import { createEgressPassAuthority } from "./pass.js";
import { createSandboxEgressProxy, type SandboxEgressProxyDependencies } from "./proxy.js";

export { applySandboxEgress, type SandboxEgress, type SandboxEgressSettings } from "./environment.js";

export interface StartedSandboxEgressProxy {
  settings: SandboxEgressSettings;
  port: number;
  close(): Promise<void>;
}

export async function startSandboxEgressProxy(
  config: SandboxEgressProxySettings,
  rootSecret: string,
  dependencies: Omit<SandboxEgressProxyDependencies, "passes" | "ca">,
): Promise<StartedSandboxEgressProxy> {
  const ca = await createEgressCertificateAuthority(await loadOrCreateEgressCa(config.caDir));
  const passes = createEgressPassAuthority(rootSecret, { now: () => new Date() });
  const proxy = createSandboxEgressProxy({
    ...dependencies,
    passes,
    ca,
  });
  const { port } = await proxy.listen(config.listenPort, config.listenHost);
  return {
    settings: {
      publicUrl: config.publicUrl,
      caCertificatePem: ca.certificatePem,
      passes,
      passTtlMs: config.passTtlMs,
    },
    port,
    close: () => proxy.close(),
  };
}
