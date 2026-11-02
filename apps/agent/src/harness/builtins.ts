import { DefaultHarness } from "./default-loop";
import { PiHarness } from "./pi-loop";
import { AcpSandboxHarness } from "./acp-sandbox-loop";
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
  add({
    id: "pi", label: "Pi", description: "Pi agent loop in the control-plane host.",
    execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [],
  }, () => new PiHarness());
  add({
    id: "ai-sdk", label: "AI SDK (legacy)", description: "Legacy AI SDK loop in the control-plane host.",
    execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [],
  }, () => new DefaultHarness());
  add({
    id: "acp-sandbox", label: "ACP Sandbox", description: "ACP agent loop in the session sandbox; requires duplex process support.",
    execution: { placement: "sandbox" }, capabilities: { runtime_binding: false },
    // `a|b`: either path satisfies the requirement (explicit command or pinned registry agent).
    requirements: ["acp.agent.command|acp.agent.registry"],
  }, () => new AcpSandboxHarness());
  if (existing.default_harness_id === null) setDefaultHarness("pi");
}
