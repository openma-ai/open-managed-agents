import {
  DYING_ACP_AGENT,
  dyingAcpAgentSandbox,
  type DyingAcpAgentStdio,
} from "../../../test/fakes/dying-acp-agent-sandbox";

/** Harness id both runners register for the acp-child-exit scenario. */
export const ACP_REVISION_TIMEOUT_HARNESS = "platform-parity-acp-revision-timeout";
export const ACP_TIMEOUT_HARNESS = "platform-parity-acp-timeout";
export const ACP_CHILD_EXIT_HARNESS = "platform-parity-acp-child-exit";

interface AcpHarness<C> {
  run(ctx: C): Promise<void>;
  dispose(reason: "destroy"): Promise<void>;
}

/**
 * The real ACP sandbox harness and acp-runtime placement, run inside the
 * platform's own turn (event log, settlement, idle), over a sandbox whose ACP
 * child dies mid-prompt with the platform's stdio behaviour. Only
 * `runtime.sandbox` and the agent's ACP launch are replaced.
 */
export function acpChildExitHarness<C extends { runtime: object; agent: object }>(
  createAcp: () => AcpHarness<C>,
  stdio: DyingAcpAgentStdio,
): { run(ctx: C): Promise<void> } {
  return {
    async run(ctx) {
      const sandbox = dyingAcpAgentSandbox(stdio);
      const runtime = new Proxy(ctx.runtime, {
        get(target, key) {
          if (key === "sandbox") return sandbox;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const acp = createAcp();
      try {
        await acp.run({ ...ctx, runtime, agent: { ...ctx.agent, acp: { agent: DYING_ACP_AGENT, ...(stdio.timeout ? { per_turn_timeout_ms: 20 } : {}) } } } as C);
      } finally {
        await acp.dispose("destroy");
      }
    },
  };
}
