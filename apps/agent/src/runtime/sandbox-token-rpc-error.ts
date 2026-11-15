import type { SandboxTokenIssueResult } from "@open-managed-agents/shared";

/** Local error only: never thrown by the RPC callee. */
export class LegacySandboxTokenUnavailable extends Error {
  readonly phase = "session_lookup";
  constructor(message: string) { super(message); this.name = "LegacySandboxTokenUnavailable"; }
}
export function sandboxTokenResultError(result: Extract<SandboxTokenIssueResult, { type: "failed" }>): Error {
  const cause = result.cause === undefined ? undefined : Object.assign(new Error(result.cause.name), result.cause);
  return Object.assign(new Error(result.message, { cause }), { name: "SandboxTokenAuthorityError", phase: result.phase, code: result.code });
}
