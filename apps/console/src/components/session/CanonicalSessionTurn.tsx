import type { AgentUITurnState } from "@openma/common/agent-ui";
import {
  AgentUITurnView,
  projectAcpChatTurn,
  type AgentUITurnLabels,
  type AgentUITurnSlots,
} from "@openma/common/chat-ui";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import { Markdown } from "../Markdown";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";

export interface CanonicalSessionTurnProps {
  turn: CanonicalChatTurn;
  projectedTurn?: AgentUITurnState;
  sessionId?: string;
}

/**
 * Managed owns the wire vocabulary; OpenMA common owns the conversation turn.
 * This adapter is deliberately pure so SessionDetail never rebuilds chat UI.
 */
export function projectCanonicalSessionTurn(turn: CanonicalChatTurn): AgentUITurnState {
  return projectAcpChatTurn(
    {
      id: turn.id,
      promptText: turn.userText,
      events: turn.rawEvents.map((payload) => ({ payload })),
      assistantText: turn.render.assistantText,
      status: canonicalTurnStatus(turn.status),
      errorMessage: turn.status === "errored"
        ? turn.render.notes.join("\n") || "The turn failed."
        : undefined,
    },
    { rendered: turn.render },
  );
}

export function CanonicalSessionTurn({
  turn,
  projectedTurn = projectCanonicalSessionTurn(turn),
  sessionId,
}: CanonicalSessionTurnProps) {
  return (
    <AgentUITurnView
      labels={MANAGED_TURN_LABELS}
      sessionId={sessionId}
      slots={managedTurnSlots(turn)}
      thoughts="history"
      turn={projectedTurn}
    />
  );
}

const MANAGED_TURN_LABELS: AgentUITurnLabels = {
  workingFor: (seconds) => `Working for ${formatElapsed(seconds)}`,
  workedFor: (seconds) => `Worked for ${formatElapsed(seconds)}`,
  thinking: "Thinking…",
  thoughtFor: (seconds) => `Thought for ${formatElapsed(seconds)}`,
  toolActivity: (tool) => tool.title || tool.name || "Using tool",
  toolRunSummary: (tools) => tools.length === 1
    ? tools[0]?.title || tools[0]?.name || "Used a tool"
    : `Used ${tools.length} tools`,
};

function managedTurnSlots(source: CanonicalChatTurn): AgentUITurnSlots {
  return {
    hasSupplementalProcess: () => source.render.plan.length > 0,
    renderProcessBefore: () => source.render.plan.length > 0 ? (
      <ol className="space-y-1 text-sm text-fg-muted" data-session-turn-plan>
        {source.render.plan.map((entry, index) => (
          <li key={`${source.id}:plan:${index}`}>{entry.content}</li>
        ))}
      </ol>
    ) : null,
    renderAssistant: ({ item, prefixSkip }) => (
      <div className="min-w-0 text-sm leading-6">
        <Markdown>{item.text.slice(prefixSkip)}</Markdown>
      </div>
    ),
    renderThought: ({ item, prefixSkip }) => (
      <Markdown>{item.text.slice(prefixSkip)}</Markdown>
    ),
    renderTool: ({ tool }) => (
      <Tool defaultOpen={tool.status === "in_progress"}>
        <ToolHeader
          state={toolState(tool.status)}
          title={tool.title || tool.name || "Tool"}
          toolName={tool.name || tool.title || "tool"}
          type="dynamic-tool"
        />
        <ToolContent>
          {tool.rawInput !== undefined ? <ToolInput input={tool.rawInput} /> : null}
          {tool.rawOutput !== undefined ? (
            <ToolOutput
              errorText={tool.status === "failed" ? formatToolOutput(tool.rawOutput) : undefined}
              output={formatToolOutput(tool.rawOutput)}
            />
          ) : null}
        </ToolContent>
      </Tool>
    ),
    renderAfterAnswer: () => source.status !== "errored" ? source.render.notes.map((note, index) => (
      <p
        className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning"
        key={`${source.id}:note:${index}`}
        role="status"
      >
        {note}
      </p>
    )) : null,
  };
}

function canonicalTurnStatus(status: CanonicalChatTurn["status"]) {
  switch (status) {
    case "completed": return "complete" as const;
    case "errored": return "error" as const;
    case "terminated": return "cancelled" as const;
    default: return "running" as const;
  }
}

function toolState(status: string | undefined) {
  switch (status) {
    case "pending": return "input-available" as const;
    case "in_progress": return "input-streaming" as const;
    case "failed": return "output-error" as const;
    default: return "output-available" as const;
  }
}

function formatToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function formatElapsed(seconds: number) {
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
