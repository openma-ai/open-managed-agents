import { reconcileSessionResourceEnvironment, type SessionResourceFacts } from "@open-managed-agents/runtime-resource-contract";
import type { SandboxPort } from "./ports";
import { parseExecResult } from "./environment-packages";

/** Read names only: resource values and unrelated credentials never leave the sandbox. */
export async function reconcileSandboxResourceEnvironment(
  sandbox: Pick<SandboxPort, "exec">,
  facts: SessionResourceFacts,
  inherited: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string | undefined>> {
  const result = parseExecResult(await sandbox.exec(
    `# OMA_RESOURCE_ENV_KEYS
env | while IFS='=' read -r name value; do case "$name" in OMA_MEMORY_*|OMA_OUTPUTS_DIR) printf '%s\n' "$name";; esac; done`,
  ));
  if (result.exitCode !== 0) throw new Error("Cannot inspect sandbox resource environment");
  const existing: Record<string, string | undefined> = {};
  for (const name of result.stdout.split("\n").filter(Boolean)) {
    if (!/^(OMA_MEMORY_[A-Za-z0-9_]*|OMA_OUTPUTS_DIR)$/.test(name)) throw new Error("Invalid sandbox resource environment name");
    existing[name] = undefined;
  }
  return reconcileSessionResourceEnvironment(facts, { ...existing, ...inherited });
}
