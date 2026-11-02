import { groupDeferredNamesByServer } from "./loaded-tools-state";
import type { DeferredToolInvocation } from "./strategies/exposure";
import { MCP_INVOKE_TOOL_NAME } from "../tool-proxy";

const DEFERRED_TOOL_LIST_CAP = 48;

function howToReach(invocation: DeferredToolInvocation): string {
  return invocation === "proxy"
    ? `Call tool_search to get their schemas, then call them through ${MCP_INVOKE_TOOL_NAME}.`
    : "Call tool_search to load them for the next turn.";
}

export function formatDeferredToolsBlock(
  deferredNames: string[],
  invocation: DeferredToolInvocation = "direct",
): string {
  if (deferredNames.length === 0) return "";
  const capped = deferredNames.slice(0, DEFERRED_TOOL_LIST_CAP);
  const omitted = deferredNames.length - capped.length;
  const groups = groupDeferredNamesByServer(capped);
  const lines: string[] = [
    "",
    "<deferred-tools>",
    `The following tools are not loaded yet. ${howToReach(invocation)}`,
  ];
  for (const [server, tools] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${server}`);
    for (const tool of tools.sort()) lines.push(`- ${tool}`);
  }
  if (omitted > 0) {
    lines.push(`… and ${omitted} more (use tool_search to find them).`);
  }
  lines.push("</deferred-tools>");
  return lines.join("\n");
}

export function appendDeferredIndex(
  systemPrompt: string,
  deferredNames: string[],
  invocation: DeferredToolInvocation = "direct",
): string {
  const block = formatDeferredToolsBlock(deferredNames, invocation);
  if (!block) return systemPrompt;
  return `${systemPrompt}${block}`;
}

const CLAUDE_CODE_DEFERRED_CAP = 512;

/** Claude Code–style user-turn reminder listing deferred tool names. */
export function formatClaudeCodeDeferredReminder(
  deferredNames: string[],
  invocation: DeferredToolInvocation = "direct",
): string {
  if (deferredNames.length === 0) return "";
  const capped = deferredNames.slice(0, CLAUDE_CODE_DEFERRED_CAP);
  const omitted = deferredNames.length - capped.length;
  const instruction = invocation === "proxy"
    ? "The following deferred tools are available via tool_search. They are not declared as tools — "
      + "use tool_search with query \"select:<name>[,<name>...]\" to get their schemas, then call them "
      + `through ${MCP_INVOKE_TOOL_NAME}:`
    : "The following deferred tools are now available via tool_search. Their schemas are NOT loaded — "
      + "calling them directly will fail. Use tool_search with query \"select:<name>[,<name>...]\" "
      + "to load tool schemas before calling them:";
  const lines = ["<system-reminder>", instruction, ...capped];
  if (omitted > 0) {
    lines.push(`… and ${omitted} more (use tool_search to find them).`);
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

export function formatIncrementalDeferredChangeReminder(remainingCount: number): string {
  return `<system-reminder>Deferred tools changed (${remainingCount} still unloaded). Use tool_search to load more.</system-reminder>`;
}
