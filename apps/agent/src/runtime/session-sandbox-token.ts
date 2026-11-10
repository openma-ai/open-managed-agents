// The Session's sandbox token on Cloudflare (#561, design §0.0 rule 10): one
// per execution attempt, shared by the E2B egress relay's first delivery and
// an in-sandbox ACP harness's model / MCP channels, issued by the main worker
// (MAIN_MCP.issueSandboxToken). One holder per isolate, keyed by Session
// (attemptSandboxTokens); memory only, a Session's next attempt replaces it.

import type { Env } from "@open-managed-agents/shared";
import { attemptSandboxTokens, type SessionExecutionAttemptRef } from "@open-managed-agents/sandbox-gateway";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

import { LegacySandboxTokenUnavailable, sandboxTokenResultError } from "./sandbox-token-rpc-error";

type MainBinding = Pick<Env, "MAIN_MCP">;

const held = attemptSandboxTokens();

/** `harness` is the agent's harness name: it fixes the scope (main decides). */
const issue = (env: MainBinding, attempt: SessionExecutionAttemptRef, harness: string | null) => async () => {
  const main = env.MAIN_MCP;
  if (main?.issueSandboxToken === undefined) throw new Error("Sandbox tokens require the MAIN_MCP binding");
  const { workspaceId, sessionId, executionId, attemptId, ownerId, generation } = attempt;
  const result = await main.issueSandboxToken({ tenantId: workspaceId, sessionId, attempt: { workspaceId, sessionId, executionId, attemptId, ownerId, generation }, harness, resultFormat: "typed" });
  if (result.type === "issued") return result.token;
  if (result.type === "legacy_without_token") throw new LegacySandboxTokenUnavailable(result.message);
  throw sandboxTokenResultError(result);
};

/** The token for one egress relay delivery of `attempt`. */
export function relaySandboxToken(env: MainBinding, attempt: SessionExecutionAttemptRef, harness: string | null, sandbox?: object | string): Promise<string> {
  return held.relayDelivery(attempt, issue(env, attempt, harness), sandbox);
}

/** HarnessContext.env for an in-sandbox ACP harness of the execution `fence`:
 * the model / MCP channels over the attempt's token (design §0.6). */
export async function acpSandboxExecutionEnv(env: MainBinding, fence: SessionExecutionFence, harness: string | null) {
  const main = env.MAIN_MCP;
  if (main?.managedAcpExecutionChannels === undefined) return {};
  const sessionsToken = await held.token(fence, issue(env, fence, harness));
  const result = await main.managedAcpExecutionChannels({ tenantId: fence.workspaceId, sessionId: fence.sessionId, sessionsToken, resultFormat: "typed" });
  if (!result || (result.type !== "ready" && result.type !== "failed")) throw new Error("Invalid ACP sandbox channel authority response");
  if (result.type === "failed") {
    const cause = result.cause === undefined ? undefined : Object.assign(new Error(result.cause.name), result.cause);
    throw Object.assign(new Error(result.message, { cause }), { phase: result.phase, code: result.code });
  }
  return { ANTHROPIC_API_KEY: "", ...result.channels };
}
