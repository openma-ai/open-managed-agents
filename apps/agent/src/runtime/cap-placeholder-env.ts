import type { SandboxExecutor } from "@open-managed-agents/sandbox";

export interface ManagedCapCliEnvironmentSource {
  resolveManagedCapCliEnvironment(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<
    | { type: "found"; env: Record<string, string> }
    | { type: "not_found" }
  >;
}

/**
 * CLI placeholder environment (cap spec `bootstrap.env`) for the sandbox.
 *
 * A v1 managed Session gets its placeholders from the main worker, which
 * alone reads the managed Vault store; any failure there propagates and
 * fails warmup like every other managed input. Only when the main worker
 * reports the session is not managed does `legacy` run, unchanged.
 */
export async function applyCapCliPlaceholderEnvironment(input: {
  source: ManagedCapCliEnvironmentSource | undefined;
  tenantId: string;
  sessionId: string | undefined;
  sandbox: Pick<SandboxExecutor, "setEnvVars">;
  legacy: () => Promise<void>;
}): Promise<"managed" | "legacy"> {
  const managed = input.sessionId && input.source
    ? await input.source.resolveManagedCapCliEnvironment({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
      })
    : { type: "not_found" as const };
  if (managed.type === "not_found") {
    await input.legacy();
    return "legacy";
  }
  if (Object.keys(managed.env).length > 0) {
    if (!input.sandbox.setEnvVars) {
      throw new Error("This sandbox cannot set the CLI placeholder environment for Vault cap_cli credentials");
    }
    await input.sandbox.setEnvVars(managed.env);
  }
  return "managed";
}
