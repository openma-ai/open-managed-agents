import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import { SessionTurnFrame } from "@openma/common/session-ui";
import { Markdown } from "../Markdown";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";

export function CanonicalSessionTurn({ turn }: { turn: CanonicalChatTurn }) {
  const isStreaming = turn.status === "running";
  const errorMessage = turn.status === "errored"
    ? turn.render.notes.join("\n") || undefined
    : undefined;

  return (
    <SessionTurnFrame
      turnId={turn.id}
      promptText={turn.userText}
      status={turn.status}
      errorMessage={errorMessage}
    >
      {turn.render.plan.length > 0 ? (
        <ol className="space-y-1 text-sm text-fg-muted" data-session-turn-plan>
          {turn.render.plan.map((entry, index) => (
            <li key={`${turn.id}:plan:${index}`}>{entry.content}</li>
          ))}
        </ol>
      ) : null}

      {turn.render.thoughtText ? (
        <Reasoning isStreaming={isStreaming} defaultOpen>
          <ReasoningTrigger />
          <ReasoningContent>{turn.render.thoughtText}</ReasoningContent>
        </Reasoning>
      ) : null}

      {turn.render.tools.map((tool) => (
        <Tool key={tool.toolCallId} defaultOpen={tool.status === "in_progress"}>
          <ToolHeader
            type="dynamic-tool"
            toolName={tool.toolName || tool.title || "tool"}
            title={tool.title || tool.toolName || "Tool"}
            state={toolState(tool.status)}
          />
          <ToolContent>
            {tool.rawInput !== undefined ? <ToolInput input={tool.rawInput} /> : null}
            {tool.rawOutput !== undefined ? (
              <ToolOutput
                output={formatToolOutput(tool.rawOutput)}
                errorText={tool.status === "failed" ? formatToolOutput(tool.rawOutput) : undefined}
              />
            ) : null}
          </ToolContent>
        </Tool>
      ))}

      {turn.render.assistantText ? (
        <div className="min-w-0 text-sm leading-6" data-session-turn-answer>
          <Markdown>{turn.render.assistantText}</Markdown>
        </div>
      ) : null}

      {turn.status !== "errored" && turn.render.notes.map((note, index) => (
        <p
          key={`${turn.id}:note:${index}`}
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning"
          role="status"
        >
          {note}
        </p>
      ))}
    </SessionTurnFrame>
  );
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
