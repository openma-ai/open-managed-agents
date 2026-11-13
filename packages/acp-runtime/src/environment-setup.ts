import { installAcpSandboxAgent, prepareAcpSandboxAgent } from "./sandbox-agent";
import { acpInstalledLauncherPath, resolvePinnedAcpRegistryAgent } from "./acp-registry-pins";
import { parseInstalledHarnesses, type InstalledAcpHarness } from "./installed-harnesses";

export interface PreparedEnvironmentAcp {
  harness: { id: string; version: string };
  inventory: string;
  launch: { command: string; args?: string[] };
}

/** Environment setup shared by prepared snapshot builds and live cache misses.
 * Hosts provide execution/package setup and cache notification, never ACP policy.
 */
export async function prepareEnvironmentAcp(input: {
  sessionId: string;
  agent?: Parameters<typeof prepareAcpSandboxAgent>[0]["agent"];
  installedHarnesses?: string;
  runtime: Parameters<typeof installAcpSandboxAgent>[0];
  preparePackages?(): Promise<void>;
  prepared?(): void;
  assertCurrent?(): Promise<void>;
}): Promise<PreparedEnvironmentAcp | null> {
  const registry = input.agent?.registry ? resolvePinnedAcpRegistryAgent(input.agent.registry) : undefined;
  const preparation = registry ? prepareAcpSandboxAgent({ sessionId: input.sessionId, agent: input.agent! }) : undefined;
  const inventory = parseInstalledHarnesses(input.installedHarnesses);
  let selected: InstalledAcpHarness | undefined;
  if (input.agent && !registry) {
    const matches = inventory?.filter(entry => (input.agent!.id === undefined || entry.id === input.agent!.id) && entry.command === input.agent!.command
      && JSON.stringify(entry.args ?? []) === JSON.stringify(input.agent!.args ?? [])) ?? [];
    if (matches.length !== 1) throw new Error("Pinned harness is not installed in the Environment inventory");
    selected = matches[0];
  }
  await input.assertCurrent?.();
  await input.preparePackages?.();
  await input.assertCurrent?.();
  if (registry && preparation) {
    const installed = await installAcpSandboxAgent(input.runtime, preparation);
    await input.assertCurrent?.();
    // The installer reports a HOME-dependent path. Validate the exact pinned
    // suffix rather than assuming every provider uses the same agent HOME.
    const suffix = acpInstalledLauncherPath("/", registry.id, registry.version);
    if (!installed.launch.command.endsWith(suffix) || !installed.launch.command.startsWith("/")) {
      throw new Error("Environment ACP install returned a launcher with a mismatched registry version");
    }
    selected = { id: registry.id, version: registry.version, command: installed.launch.command,
      ...(installed.launch.args ? { args: installed.launch.args } : {}) };
  }
  input.prepared?.();
  return selected ? { harness: { id: selected.id, version: selected.version }, inventory: JSON.stringify([selected]),
    launch: { command: selected.command, ...(selected.args ? { args: selected.args } : {}) } } : null;
}

/** Consumer-side contract; providers cannot replace a prepared pin/inventory. */
export function assertPreparedEnvironmentAcp(prepared: PreparedEnvironmentAcp | null | undefined, expected: { id: string; version: string }): PreparedEnvironmentAcp {
  const inventory = prepared ? parseInstalledHarnesses(prepared.inventory) : null;
  if (!prepared || prepared.harness.id !== expected.id || prepared.harness.version !== expected.version
    || inventory?.length !== 1 || inventory[0]!.id !== expected.id || inventory[0]!.version !== expected.version
    || inventory[0]!.command !== prepared.launch.command
    || JSON.stringify(inventory[0]!.args ?? []) !== JSON.stringify(prepared.launch.args ?? [])) {
    throw new Error("Work Environment prepared launcher inventory does not match the authorized harness");
  }
  return prepared;
}

/** Snapshot cache key uses the same immutable install selection as preparation. */
export function environmentAcpInstall(registry: string | undefined) {
  if (!registry) return null;
  const pinned = resolvePinnedAcpRegistryAgent(registry);
  return { package: pinned.package, version: pinned.version, nodeMajor: pinned.nodeMajor };
}
