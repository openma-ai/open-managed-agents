import { PiHarness } from "./pi-loop";
import { AcpSandboxHarness } from "./acp-sandbox-loop";
import {
  ACP_SANDBOX_HARNESS_DESCRIPTOR,
  PI_HARNESS_DESCRIPTOR,
} from "@open-managed-agents/api-types";
import { getHarnessCatalog, registerHarness, setDefaultHarness, type HarnessDescriptor, type HarnessFactory } from "./registry";

/**
 * Register the platform-neutral harness implementations shared by every host.
 * Platform-specific harnesses (for example ACP proxy on Cloudflare) are added
 * by that platform's composition root.
 */
export function registerCoreHarnesses(): void {
  const existing = getHarnessCatalog();
  const add = (descriptor: HarnessDescriptor, factory: HarnessFactory) => {
    if (!existing.data.some(({ id }) => id === descriptor.id)) registerHarness(descriptor, factory);
  };
  add(PI_HARNESS_DESCRIPTOR, () => new PiHarness());
  add(ACP_SANDBOX_HARNESS_DESCRIPTOR, () => new AcpSandboxHarness());
  if (existing.default_harness_id === null) setDefaultHarness("pi");
}
