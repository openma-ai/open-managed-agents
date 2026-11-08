import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";

import { getToolPermission } from "./tools";

/** The parts of an ACP `session/request_permission` request this policy reads. */
export interface AcpPermissionRequest {
  readonly toolCall?: { readonly _meta?: unknown } | null;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly kind: string }>;
}

export type AcpPermissionResponse =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

/** Claude Code's built-in tool names → the agent toolset's tool names. */
const CLAUDE_CODE_TOOLS: Readonly<Record<string, string>> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
};

function claudeCodeToolName(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (claudeCode === null || typeof claudeCode !== "object") return undefined;
  const name = (claudeCode as { toolName?: unknown }).toolName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Answer an ACP permission request from the agent's tool permission policy.
 * The sandbox harness has no interactive confirmation channel, so a tool the
 * policy does not always allow is refused rather than approved.
 */
export function answerAcpPermission(
  agent: AgentConfig,
  request: AcpPermissionRequest,
): AcpPermissionResponse {
  const native = claudeCodeToolName(request.toolCall?._meta);
  const tool = native === undefined ? "" : CLAUDE_CODE_TOOLS[native] ?? native;
  const allowed = getToolPermission(agent, tool) === "always_allow";
  const kinds = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
