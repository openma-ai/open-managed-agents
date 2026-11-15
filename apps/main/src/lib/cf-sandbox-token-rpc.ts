import type { SandboxTokenIssueRequest, SandboxTokenIssueResult } from "@open-managed-agents/shared";
import { issueSandboxToken, sandboxHarnessPlacement, sandboxTokenScopeFor, type SandboxTokenStore } from "@open-managed-agents/sandbox-gateway";

type Failure = Extract<SandboxTokenIssueResult, { type: "failed" }>;
interface Dependencies {
  store: SandboxTokenStore;
  legacySession(input: SandboxTokenIssueRequest): Promise<{ archivedAt: string | null } | null>;
  legacyFenceActive(input: SandboxTokenIssueRequest): Promise<boolean>;
  report(error: unknown): void;
}
const failed = (phase: Failure["phase"], code: Failure["code"], message: string): Failure => ({ type: "failed", phase, code, message });

/** Values across RPC, the SAME authority and atomic token replacement below. */
export async function issueCfSandboxTokenResult(deps: Dependencies, input: SandboxTokenIssueRequest): Promise<SandboxTokenIssueResult> {
  const attempt = input?.attempt;
  if (!attempt || !input.tenantId || !input.sessionId || attempt.workspaceId !== input.tenantId || attempt.sessionId !== input.sessionId || !attempt.executionId || !attempt.attemptId || !attempt.ownerId || !Number.isSafeInteger(attempt.generation) || attempt.generation < 1) {
    return failed("validation", "invalid_request", "Sandbox token requires this Session's current execution fence");
  }
  let phase: Failure["phase"] = "session_lookup";
  try {
    const session = await deps.store.findSession({ workspaceId: input.tenantId, sessionId: input.sessionId });
    if (session === null) {
      const legacy = await deps.legacySession(input);
      if (legacy === null) return failed(phase, "session_not_found", "Sandbox token Session was not found");
      if (legacy.archivedAt !== null) return failed(phase, "archived", "Archived Session cannot receive a sandbox token");
      if (!await deps.legacyFenceActive(input)) return failed(phase, "stale_fence", "Sandbox token Session Execution fence is stale");
      return { type: "legacy_without_token", phase, message: "Legacy Session has no managed sandbox token; Vault and GitHub credentials are unavailable" };
    }
    if (session.archivedAt !== null) return failed(phase, "archived", "Archived Session cannot receive a sandbox token");
    phase = "token_replace";
    let replacement: "replaced" | "stale" | "scope_mismatch" | undefined;
    try {
      const token = await issueSandboxToken({ ...deps.store, findSession: async () => session, replaceTokenHash: async value => (replacement = await deps.store.replaceTokenHash(value)) }, attempt, { scope: sandboxTokenScopeFor(sandboxHarnessPlacement(input.harness)) });
      return { type: "issued", token };
    } catch (error) {
      if (replacement === "stale") return failed(phase, "stale_fence", "Sandbox token Session Execution fence is stale");
      if (replacement === "scope_mismatch") return failed(phase, "scope_mismatch", "Sandbox token scope differs from this execution attempt");
      throw error;
    }
  } catch (error) {
    deps.report(error);
    return { ...failed(phase, "unavailable", "Sandbox token authority is unavailable"), cause: { name: "SandboxTokenAuthorityUnavailable", code: "unavailable" } };
  }
}
