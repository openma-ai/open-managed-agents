import { Type } from "@earendil-works/pi-ai";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { HarnessContext } from "../../interface";
import { toolsToPi } from "../../pi-loop-tools";
import { createToolCatalogSearch } from "../components/tool-catalog-search";
import { createMcpInvokeTool } from "../components/mcp-invoke";
import { supportsNativeToolLoading } from "../model-capabilities";
import { MCP_INVOKE_TOOL_NAME } from "../../tool-proxy";
import { createToolExposureStrategy } from "../strategies/exposure";
import { planSkillExposure } from "../strategies/skill-exposure";
import { buildToolCatalog, isMcpToolName } from "../catalog";
import { resolveToolAssemblyConfig } from "../config";
import { resolveSkillAssemblyConfig } from "../skill-config";
import { resolveReassemblyConfig } from "../reassembly-config";
import { resolvePostCompactionAssembly } from "../post-compaction-reassembly";
import {
  broadcastLoadedToolNames,
  restoreLoadedToolNames,
} from "../loaded-tools-state";
import {
  broadcastLoadedSkillIds,
  restoreLoadedSkillIds,
} from "../loaded-skills-state";
import { createDeferredHintCoordinator } from "../strategies/deferred-hints";
import type { DeferredHintBootstrapMessage } from "../strategies/deferred-hints";
import { skillMountsFromContext } from "../skills/resolve-context";
import { parseSkillCatalogName, skillCatalogName } from "../skills/types";
import type { AssemblyState, ToolCatalogEntry } from "../types";
import type { SkillMountDescriptor } from "../../skills";

const TOOL_SEARCH_NAME = "tool_search";
const SKILL_TOOL_NAME = "skill";

export interface PiToolAssembly {
  initialTools: AgentTool[];
  systemPrompt: string;
  /** User messages to prepend before the first model turn (strategy-specific). */
  bootstrapTurnMessages: DeferredHintBootstrapMessage[];
  attach(agent: Agent): void;
  getState(): AssemblyState;
}

function formatSearchResult(
  entries: ToolCatalogEntry[],
  tools: AgentTool[],
  mounts: SkillMountDescriptor[],
): string {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const mountsById = new Map(mounts.map((mount) => [mount.skillId, mount]));
  const lines: string[] = [];
  for (const entry of entries) {
    const skillId = parseSkillCatalogName(entry.name);
    if (skillId) {
      const mount = mountsById.get(skillId);
      lines.push(`## ${entry.name}`);
      lines.push(entry.description);
      if (mount?.body?.trim()) {
        lines.push("");
        lines.push(mount.body);
      } else if (mount) {
        lines.push("");
        lines.push(`Read: \`${mount.mountRoot}SKILL.md\``);
      }
      lines.push("");
      continue;
    }
    const tool = byName.get(entry.name);
    lines.push(`## ${entry.name}`);
    lines.push(entry.description);
    if (tool) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(tool.parameters, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function skillCatalogEntries(
  mounts: SkillMountDescriptor[],
  deferredSkillIds: string[],
): ToolCatalogEntry[] {
  const byId = new Map(mounts.map((mount) => [mount.skillId, mount]));
  return deferredSkillIds.map((skillId) => {
    const mount = byId.get(skillId);
    return {
      name: skillCatalogName(skillId),
      description: mount?.description || mount?.name || skillId,
      serverName: "skill",
    };
  });
}

function appendSkillSection(systemPrompt: string, section: string): string {
  if (!section.trim()) return systemPrompt;
  return `${systemPrompt}\n\n${section.trim()}`;
}

export function createPiToolAssembly(ctx: HarnessContext): PiToolAssembly {
  const toolConfig = resolveToolAssemblyConfig(ctx.agent);
  const skillConfig = resolveSkillAssemblyConfig(ctx.agent);
  const reassemblyConfig = resolveReassemblyConfig(ctx.agent);
  const model = ctx.pi!.model;
  // Without native mid-conversation tool declarations, loading a deferred tool would resend the
  // whole tool list and invalidate the cached prefix. Such models reach deferred tools through
  // `mcp_invoke` instead, so their tool list stays fixed for the session.
  const nativeToolLoading = supportsNativeToolLoading(model);
  const deferredHints = createDeferredHintCoordinator(
    toolConfig.deferredHintStrategy ?? (nativeToolLoading ? "claude_code" : "pi"),
  );
  const exposure = createToolExposureStrategy();
  const search = createToolCatalogSearch();
  const skillMounts = skillMountsFromContext(ctx);
  const mountsById = new Map(skillMounts.map((mount) => [mount.skillId, mount]));
  const allTools = toolsToPi(ctx);
  const toolCatalog = buildToolCatalog(allTools);
  const events = ctx.runtime.history.getEvents();
  const loadedTools = restoreLoadedToolNames(events);
  const loadedSkills = restoreLoadedSkillIds(events);
  const baseSystemPrompt = ctx.systemPrompt;

  const postCompaction = resolvePostCompactionAssembly({
    events,
    mounts: skillMounts,
    loadedTools,
    config: reassemblyConfig,
    model,
    broadcast: ctx.runtime.broadcast.bind(ctx.runtime),
  });
  const postCompactionSkillSection = postCompaction.skillRetentionSection;

  function combinedSearchCatalog(): ToolCatalogEntry[] {
    const liveSkillPlan = planSkillExposure({
      mounts: skillMounts,
      loadedSkillIds: loadedSkills,
      config: skillConfig,
      model,
    });
    return [
      ...toolCatalog,
      ...skillCatalogEntries(skillMounts, liveSkillPlan.deferredSkillIds),
    ];
  }

  const skillPlan = planSkillExposure({
    mounts: skillMounts,
    loadedSkillIds: loadedSkills,
    config: skillConfig,
    model,
  });

  const skillTool: AgentTool | undefined = skillConfig.mode === "tool" && skillMounts.length > 0
    ? {
      name: SKILL_TOOL_NAME,
      label: SKILL_TOOL_NAME,
      description:
        "Load a skill's SKILL.md for the next turn. "
        + skillMounts.map((m) => `${m.name} (${m.skillId})`).join("; "),
      parameters: Type.Object({
        skill_id: Type.String({ description: "Skill id from the available-skills list" }),
      }),
      execute: async (_toolCallId, params) => {
        const record = params as { skill_id?: string };
        const skillId = typeof record.skill_id === "string" ? record.skill_id : "";
        const mount = mountsById.get(skillId);
        if (!mount) {
          return {
            content: [{ type: "text", text: `Unknown skill_id: ${skillId}` }],
            details: {},
            isError: true,
          };
        }
        loadedSkills.add(skillId);
        broadcastLoadedSkillIds(ctx.runtime.broadcast.bind(ctx.runtime), [skillId]);
        const body = mount.body?.trim()
          ? mount.body
          : `Read SKILL.md at ${mount.mountRoot}SKILL.md`;
        return {
          content: [{ type: "text", text: body }],
          details: { loadedSkillIds: [skillId] },
        };
      },
    }
    : undefined;

  const toolSearchPiTool: AgentTool = {
    name: TOOL_SEARCH_NAME,
    label: TOOL_SEARCH_NAME,
    description:
      "Search deferred MCP tools and deferred skills by keyword, server name, +required terms, or select:name1,name2. "
      + (nativeToolLoading
        ? "Loaded entries become available on the next model turn."
        : `Returns each tool's JSON schema; call the tools through ${MCP_INVOKE_TOOL_NAME}. `
          + "Loaded skills become available on the next model turn."),
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default from agent config)" })),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { query?: string; limit?: number };
      const query = typeof record.query === "string" ? record.query : "";
      const limit = typeof record.limit === "number"
        ? Math.max(1, Math.min(32, Math.floor(record.limit)))
        : toolConfig.searchLimit;
      const result = search.search(combinedSearchCatalog(), { query, limit });
      const loadedToolNames: string[] = [];
      const loadedSkillIds: string[] = [];
      for (const entry of result.entries) {
        const skillId = parseSkillCatalogName(entry.name);
        if (skillId) {
          loadedSkills.add(skillId);
          loadedSkillIds.push(skillId);
        } else if (nativeToolLoading) {
          loadedTools.add(entry.name);
          loadedToolNames.push(entry.name);
        }
      }
      if (loadedToolNames.length > 0) {
        broadcastLoadedToolNames(ctx.runtime.broadcast.bind(ctx.runtime), loadedToolNames);
      }
      if (loadedSkillIds.length > 0) {
        broadcastLoadedSkillIds(ctx.runtime.broadcast.bind(ctx.runtime), loadedSkillIds);
      }
      const header = nativeToolLoading
        ? `Loaded ${result.entries.length} item(s) for the next turn:`
        : `Found ${result.entries.length} item(s). Call tools through ${MCP_INVOKE_TOOL_NAME} `
          + `with {"tool_name": "<name>", "arguments": {...}}; skills are loaded for the next turn:`;
      const text = result.entries.length === 0
        ? "No tools matched. Try different keywords or select:tool_name."
        : `${header}\n\n${formatSearchResult(result.entries, allTools, skillMounts)}`;
      return {
        content: [{ type: "text", text }],
        details: { loadedToolNames, loadedSkillIds },
      };
    },
  };

  const allToolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
  const mcpInvokeTool = nativeToolLoading
    ? undefined
    : createMcpInvokeTool({
      resolveTarget: (name) => (isMcpToolName(name) ? allToolsByName.get(name) : undefined),
    });

  const toolsWithSearch = [
    ...allTools.filter((t) =>
      t.name !== TOOL_SEARCH_NAME && t.name !== SKILL_TOOL_NAME && t.name !== MCP_INVOKE_TOOL_NAME),
    ...(skillTool ? [skillTool] : []),
    toolSearchPiTool,
    ...(mcpInvokeTool ? [mcpInvokeTool] : []),
  ];

  function deferredSkillIdsForSearch(): string[] {
    return planSkillExposure({
      mounts: skillMounts,
      loadedSkillIds: loadedSkills,
      config: skillConfig,
      model,
    }).deferredSkillIds;
  }

  function planTools() {
    const forceToolSearch = deferredSkillIdsForSearch().length > 0;
    return exposure.plan({
      allTools: toolsWithSearch,
      loadedToolNames: loadedTools,
      config: toolConfig,
      model,
      forceToolSearch,
      nativeToolLoading,
    });
  }

  function assembleSystemPrompt(
    plan: { toolSearchEnabled: boolean; deferredNames: string[] },
    skillSection: string,
  ): string {
    const skillParts = [skillSection, postCompactionSkillSection].filter((s) => s.trim().length > 0);
    const withSkills = appendSkillSection(baseSystemPrompt, skillParts.join("\n\n"));
    return deferredHints.augmentSystemPrompt(withSkills, plan);
  }

  function currentSkillSection(): string {
    return planSkillExposure({
      mounts: skillMounts,
      loadedSkillIds: loadedSkills,
      config: skillConfig,
      model,
    }).systemSection;
  }

  const initialPlan = planTools();
  let lastDeferredHintKey = deferredHints.initialDeferredHintKey(initialPlan);
  const bootstrapTurnMessages = deferredHints.bootstrapTurnMessages(initialPlan);

  return {
    initialTools: initialPlan.exposed,
    systemPrompt: assembleSystemPrompt(initialPlan, skillPlan.systemSection),
    bootstrapTurnMessages,
    getState: () => ({
      loadedToolNames: [...loadedTools],
      loadedSkillIds: [...loadedSkills],
    }),
    attach(agent: Agent) {
      agent.prepareRequest = async ({ context }) => {
        const plan = planTools();
        return {
          context: {
            ...context,
            tools: plan.exposed,
            systemPrompt: assembleSystemPrompt(plan, currentSkillSection()),
          },
        };
      };

      agent.prepareNextTurnWithContext = async (turnContext) => {
        const plan = planTools();
        const baseContext = {
          ...turnContext.context,
          tools: plan.exposed,
          systemPrompt: assembleSystemPrompt(plan, currentSkillSection()),
        };
        const turnHints = deferredHints.prepareNextTurn(plan, lastDeferredHintKey);
        lastDeferredHintKey = turnHints.nextDeferredHintKey;
        if (!turnHints.messages || turnHints.messages.length === 0) {
          return { context: baseContext };
        }
        return {
          context: baseContext,
          messages: turnHints.messages,
        };
      };
    },
  };
}

/** @alias createPiToolAssembly — Pi harness assembly (tools + skills). */
export const createPiAssembly = createPiToolAssembly;
