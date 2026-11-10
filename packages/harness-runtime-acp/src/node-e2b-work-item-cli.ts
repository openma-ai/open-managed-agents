import { createDefaultWorkComposition } from "./node-work-composition.js";
import { createNodeManagedAcpWorkItemRunner, type NodeManagedAcpWorkItemRunnerOptions } from "./node-work-item.js";
import { assertE2BInstalledHarness, createE2BStateIo, loadE2BAgentSpawner } from "./node-e2b-work-item.js";

export async function runNodeE2BWorkItemCli(options: Omit<NodeManagedAcpWorkItemRunnerOptions,"supervisorApp"|"supervisorFactory"> = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  assertE2BInstalledHarness(environment);
  // The one runner owns bootstrap, recovery, heartbeat and settlement. This
  // wrapper contributes only mandatory native isolation in the run branch.
  await createNodeManagedAcpWorkItemRunner({ ...options, environment,
    composition: async context => {
      const configured = await (options.composition ?? createDefaultWorkComposition({ ...options.runtime, workspacePath: options.workspacePath, environment, fetch: options.fetch, resolveExecutionChannels: options.resolveExecutionChannels }))(context);
      if (!configured.createAcpRuntime) throw new Error("E2B Work composition requires a verified createAcpRuntime(spawner) factory; installed common 0.13.1 is not a gated runtime");
      const spawner = await loadE2BAgentSpawner();
      return { ...configured, acpRuntime: configured.createAcpRuntime(spawner), stateIo: createE2BStateIo(spawner) };
    },
  }).run();
}

if (import.meta.main) await runNodeE2BWorkItemCli();
