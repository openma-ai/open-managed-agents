import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { generateSandboxToken } from "@open-managed-agents/sandbox-gateway";
import type { ScenarioContext } from "../../packages/platform-parity/src/context";

/**
 * acp-sandbox now belongs to Environment Work, not the SessionExecution lane.
 * Exercise the latter's context-startup failure boundary with a scoped context
 * dependency fault: the REAL channels RPC refuses this deployment's missing
 * PUBLIC_BASE_URL. No events/status/consumption are fabricated by the fixture.
 * This is not a test of Work dispatch or a real container/ACP launch.
 */
export async function runCfContextBuildFailure(context: ScenarioContext): Promise<void> {
  const agent = await context.agent("parity-agent");
  const sessionId = await context.session(agent);
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", sessionId])));
  let restore: (() => void) | undefined;
  await runInDurableObject(stub, async (instance) => {
    await instance._sandboxWarm;
    // Budget construction is an awaited context dependency, before running is
    // announced. Inject only its failure source, leaving settlement untouched.
    const dependency = vi.spyOn(instance, "resolveBudgetGate").mockImplementation(async () => {
      const result = await env.MAIN_MCP!.managedAcpExecutionChannels!({
        tenantId: "default", sessionId, sessionsToken: generateSandboxToken(), resultFormat: "typed",
      });
      if (result.type !== "failed" || result.phase !== "configuration" || result.code !== "missing_configuration") {
        throw new Error("Expected missing ACP channel configuration");
      }
      throw new Error(result.message);
    });
    restore = () => dependency.mockRestore();
  });
  try {
    await context.message("Start.");
    await context.waitIdle(1);
  } finally {
    await runInDurableObject(stub, () => restore?.());
  }
}
