import { SessionExecutionLostError } from "@open-managed-agents/session-runtime-contract/coordination";
import type { JsonObject } from "@open-managed-agents/managed-agents-application";
import type {
  ManagedNodeConfirmedToolExecutionPort,
  ManagedNodeConfirmedToolExecutionResult,
  ExecuteManagedNodeConfirmedTool,
} from "./node-managed-session-runner.js";

interface ExecutableToolOptions {
  abortSignal: AbortSignal;
  messages: [];
  toolCallId: string;
}

interface ExecutableTool {
  execute?: (
    input: JsonObject,
    options: ExecutableToolOptions,
  ) => unknown | Promise<unknown>;
}

export interface NodeManagedConfirmedToolExecutorDependencies {
  buildExecutableTools(
    input: Omit<ExecuteManagedNodeConfirmedTool, "confirmation" | "toolUse" | "abortSignal">,
  ): Promise<Record<string, ExecutableTool>>;
}

function textResult(
  text: string,
  isError: boolean,
): ManagedNodeConfirmedToolExecutionResult {
  return { content: [{ type: "text", text }], isError };
}

function successfulResult(value: unknown): ManagedNodeConfirmedToolExecutionResult {
  if (typeof value === "string") return textResult(value, false);
  if (value === undefined) return textResult("", false);
  try {
    return textResult(JSON.stringify(value), false);
  } catch {
    return textResult(String(value), false);
  }
}

export class NodeManagedConfirmedToolExecutor
  implements ManagedNodeConfirmedToolExecutionPort
{
  constructor(
    private readonly dependencies: NodeManagedConfirmedToolExecutorDependencies,
  ) {}

  async execute(
    input: ExecuteManagedNodeConfirmedTool,
  ): Promise<ManagedNodeConfirmedToolExecutionResult> {
    input.abortSignal.throwIfAborted();
    const tools = await this.dependencies.buildExecutableTools({
      workspaceId: input.workspaceId,
      session: input.session,
      environment: input.environment,
      sandbox: input.sandbox,
    });
    const tool = tools[input.toolUse.name];
    if (tool?.execute === undefined) {
      return textResult(
        `Confirmed tool ${input.toolUse.name} is not executable`,
        true,
      );
    }
    input.abortSignal.throwIfAborted();
    try {
      const value = await tool.execute(input.toolUse.input, {
        abortSignal: input.abortSignal,
        messages: [],
        toolCallId: input.toolUse.id,
      });
      return successfulResult(value);
    } catch (error) {
      if (error instanceof SessionExecutionLostError || input.abortSignal.aborted) throw error;
      if (error !== null && typeof error === "object" && "outcome" in error && error.outcome === "dispatched_unknown") {
        return {...textResult("Tool outcome unknown: operation may have committed; another attempt requires explicit authorization.",true),outcome:"dispatched_unknown"};
      }
      return textResult(
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }
}
