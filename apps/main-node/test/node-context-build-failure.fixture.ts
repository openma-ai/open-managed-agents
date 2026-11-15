import { vi } from "vitest";
import type { ScenarioContext } from "../../../packages/platform-parity/src/context.js";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { createNodeManagedAcpCapabilities } from "../../../packages/control-plane-node/src/lib/node-managed-acp-capability.js";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** SessionExecution context dependency failure, matching CF's fixture. Only
 * the dependency is substituted: real missing-channel configuration throws;
 * the runner owns running/error/exhausted/idle and all canonical persistence. */
export async function runNodeContextBuildFailure(context: ScenarioContext, sql: SqlClient): Promise<void> {
  const agent = await context.agent("parity-agent");
  const sessionId = await context.session(agent);
  const channels = createNodeManagedAcpCapabilities({ sql, now: () => new Date() });
  const accept = DefaultNodeManagedSessionRunner.prototype.accept;
  const hook = vi.spyOn(DefaultNodeManagedSessionRunner.prototype, "accept").mockImplementation(async function(this: DefaultNodeManagedSessionRunner, input) {
    if (input.sessionId !== sessionId) return accept.call(this, input);
    // TypeScript-private dependency object; scoped to this actual runner/turn.
    const runner = this as unknown as { dependencies: { buildModel: (value: any) => Promise<any> } };
    const original = runner.dependencies.buildModel;
    runner.dependencies.buildModel = async value => {
      await channels.issue({ ...value, executionFence: input.executionFence });
      throw new Error("Missing PUBLIC_BASE_URL unexpectedly accepted");
    };
    try { await accept.call(this, input); }
    finally { runner.dependencies.buildModel = original; }
  });
  try { await context.message("Start."); await context.waitIdle(1); }
  finally { hook.mockRestore(); }
}
