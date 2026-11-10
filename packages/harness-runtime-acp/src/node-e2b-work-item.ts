export { createE2BStateIo } from "./node-e2b-state-io.js";
import type { Spawner } from "@open-managed-agents/acp-runtime";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";

/** E2B root management may use only the template-certified installed closure. */
export function assertE2BInstalledHarness(environment: Readonly<Record<string,string|undefined>>): void {
  const inventory = JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/opt/oma-harnesses/codex-acp/bin/codex-acp"}]);
  if (environment.OPENMA_ACP_SOURCES !== undefined || environment.OPENMA_ACP_PACKAGES !== undefined || environment.OPENMA_ACP_HARNESSES !== inventory) {
    throw new Error("E2B worker requires the fixed preinstalled codex-acp@1.8.0 inventory");
  }
}

/** Fixed root-private module; never discover isolation code through workspace or env. */
export async function loadE2BAgentSpawner(
  load: (url: string) => Promise<unknown> = url => import(url),
): Promise<Spawner> {
  const module = await load("file:///opt/oma-managed/agent-spawner.mjs") as { isolateE2BAgentSpawner?: (spawner: Spawner) => Spawner };
  if (typeof module.isolateE2BAgentSpawner !== "function") {
    throw new TypeError("Trusted E2B module must export isolateE2BAgentSpawner");
  }
  const isolated = module.isolateE2BAgentSpawner(new NodeSpawner());
  if (!isolated || typeof isolated.spawn !== "function") throw new TypeError("Invalid isolated E2B agent spawner");
  return isolated;
}
