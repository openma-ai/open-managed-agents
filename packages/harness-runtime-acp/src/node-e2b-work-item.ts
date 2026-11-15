import { acpInstalledLauncherPath, resolvePinnedAcpRegistryAgent } from "@open-managed-agents/acp-runtime/registry-pins";
export { createE2BStateIo } from "./node-e2b-state-io.js";
import type { Spawner } from "@open-managed-agents/acp-runtime";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";

/** E2B root management may use only the template-certified installed closure. */
/** HOME of the unprivileged E2B agent identity (template `useradd oma-worker`). */
const E2B_AGENT_HOME = "/home/oma-worker";

/** Accepts exactly one pinned registry agent installed by the Environment
 * setup step (normally restored from the prepared environment snapshot) at
 * its deterministic launcher under the agent HOME. The base template bakes no
 * ACP agent. The launcher runs as the agent identity like any agent process
 * with no automatic management credential inheritance. Guest sudo can inspect
 * guest-resident management state; this is not a security boundary. Sources, packages, other paths
 * or unpinned versions are refused before ACK. */
export function assertE2BInstalledHarness(environment: Readonly<Record<string,string|undefined>>): void {
  const fail = () => { throw new Error("E2B worker requires a pinned ACP harness installed by Environment setup"); };
  if (environment.OPENMA_ACP_SOURCES !== undefined || environment.OPENMA_ACP_PACKAGES !== undefined) fail();
  let entries: unknown;
  try { entries = JSON.parse(environment.OPENMA_ACP_HARNESSES ?? ""); } catch { fail(); }
  if (!Array.isArray(entries) || entries.length !== 1) return fail();
  const [entry] = entries as unknown[];
  if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "command,id,version") return fail();
  const { id, version, command } = entry as Record<string, unknown>;
  if (typeof id !== "string" || typeof version !== "string" || typeof command !== "string") return fail();
  try {
    const pinned = resolvePinnedAcpRegistryAgent(`${id}@${version}`);
    if (pinned.id !== id || pinned.version !== version || command !== acpInstalledLauncherPath(E2B_AGENT_HOME, id, version)) fail();
  } catch { fail(); }
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
  return {spawn: spec => isolated.spawn({...spec, env: {PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/home/oma-worker",...spec.env}})};
}
