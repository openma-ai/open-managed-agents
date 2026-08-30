import { DefaultHarness } from "./default-loop";
import { PiHarness } from "./pi-loop";
import { AcpSandboxHarness } from "./acp-sandbox-loop";
import { registerHarness } from "./registry";

/**
 * Register the platform-neutral harness implementations shared by every host.
 * Platform-specific harnesses (for example ACP proxy on Cloudflare) are added
 * by that platform's composition root.
 */
export function registerCoreHarnesses(): void {
  registerHarness("default", () => new DefaultHarness());
  registerHarness("ai-sdk", () => new DefaultHarness());
  registerHarness("pi", () => new PiHarness());
  registerHarness("acp-sandbox", () => new AcpSandboxHarness());
}
