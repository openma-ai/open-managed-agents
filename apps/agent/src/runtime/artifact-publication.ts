import type { Env } from "@open-managed-agents/shared";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { sandboxStdout, readSandboxFileBytes } from "./sandbox-output";

/** Publication is part of fenced cleanup: failure must reach the turn owner. */
export async function publishAgentsApiArtifacts(
  binding: Env["MAIN_MCP"],
  state: { tenant_id?: string | null; session_id?: string | null },
  executionFence: SessionExecutionFence,
  sandbox: () => Promise<Parameters<typeof sandboxStdout>[0]>,
): Promise<void> {
  const tenantId = state.tenant_id, sessionId = state.session_id;
  if (!binding?.publishManagedSessionArtifacts || !tenantId || !sessionId) return;
  await binding.publishManagedSessionArtifacts({
    tenantId, sessionId, executionFence,
    outputManifest: async () => sandboxStdout(await sandbox(), "cd /workspace && if test -d ./outputs; then find ./outputs -type f -print0 | base64 -w0; fi", 30_000),
    readOutput: async path => readSandboxFileBytes(await sandbox(), path, 60_000),
  });
}
