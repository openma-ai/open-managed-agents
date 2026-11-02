import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import { mcpServerNameFromToolName } from "./catalog";
import {
  indexOfLastCompactionBoundary,
  readContextReassembledDetails,
} from "./context-reassembled-state";

export const TOOL_ASSEMBLY_WARNING_SOURCE = "oma.tool_assembly";

export function broadcastLoadedToolNames(
  broadcast: (event: SessionEvent) => void,
  loadedToolNames: string[],
): void {
  if (loadedToolNames.length === 0) return;
  broadcast({
    type: "session.warning",
    source: TOOL_ASSEMBLY_WARNING_SOURCE,
    message: `Tool assembly loaded ${loadedToolNames.length} deferred tool(s)`,
    details: { loadedToolNames },
  });
}

function textFromToolSearchResultContent(content: string | ContentBlock[] | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
      ? block.text
      : ""))
    .join("\n");
}

function namesFromToolSearchResultContent(content: string | ContentBlock[] | unknown): string[] {
  const text = textFromToolSearchResultContent(content);
  if (!text) return [];
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^##\s+(\S+)/.exec(line.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/**
 * Rebuild the set of MCP tools loaded via `tool_search` from the session event log.
 */
function restoreLoadedToolNamesFromEvents(events: readonly SessionEvent[]): Set<string> {
  const loaded = new Set<string>();
  const pendingSearch = new Map<string, string>();

  for (const event of events) {
    if (event.type === "session.warning" && event.source === TOOL_ASSEMBLY_WARNING_SOURCE) {
      const details = event.details as { loadedToolNames?: unknown } | undefined;
      if (Array.isArray(details?.loadedToolNames)) {
        for (const name of details.loadedToolNames) {
          if (typeof name === "string" && name.length > 0) loaded.add(name);
        }
      }
      continue;
    }

    if (
      (event.type === "agent.tool_use" || event.type === "agent.custom_tool_use")
      && event.name === "tool_search"
      && event.id
    ) {
      pendingSearch.set(event.id, event.id);
      continue;
    }

    if (event.type === "agent.tool_result" && event.tool_use_id) {
      const toolUseId = event.tool_use_id;
      if (!pendingSearch.has(toolUseId)) continue;
      pendingSearch.delete(toolUseId);
      for (const name of namesFromToolSearchResultContent(event.content)) {
        loaded.add(name);
      }
    }
  }

  return loaded;
}

export function restoreLoadedToolNames(events: readonly SessionEvent[]): Set<string> {
  const loaded = restoreLoadedToolNamesFromEvents(events);
  const compactionIdx = indexOfLastCompactionBoundary(events);
  const details = readContextReassembledDetails(events);
  if (details && compactionIdx >= 0 && details.afterCompactionIndex === compactionIdx) {
    return new Set(details.loadedToolNames);
  }
  return loaded;
}

export function groupDeferredNamesByServer(names: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const server = mcpServerNameFromToolName(name) ?? "other";
    const list = groups.get(server) ?? [];
    list.push(name);
    groups.set(server, list);
  }
  return groups;
}
