import { createNodeManagedAcpWorkItemRunner, type NodeManagedAcpWorkItemRunnerOptions } from "./node-work-item.js";

/** Same entry used by the executable and integration tests. Dependencies are
 * trusted host composition, never loaded from agent-controlled workspace. */
export async function runNodeWorkItemCli(options: NodeManagedAcpWorkItemRunnerOptions = {}): Promise<void> {
  await createNodeManagedAcpWorkItemRunner(options).run();
}

if (import.meta.main) await runNodeWorkItemCli();
