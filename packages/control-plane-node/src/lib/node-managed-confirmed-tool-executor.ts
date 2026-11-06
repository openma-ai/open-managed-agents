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
  disposeTools?(tools: Record<string, ExecutableTool>): Promise<void>;
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
    input.assertCanDispatch?.();
    const tools = await this.dependencies.buildExecutableTools({
      workspaceId: input.workspaceId,
      session: input.session,
      environment: input.environment,
      sandbox: input.sandbox,
    });
    try {
      input.abortSignal.throwIfAborted();
      input.assertCanDispatch?.();
      const tool = tools[input.toolUse.name];
      if (tool?.execute === undefined) return textResult(`Confirmed tool ${input.toolUse.name} is not executable`, true);
      const value = await tool.execute(input.toolUse.input, {
        abortSignal: input.abortSignal,
        messages: [],
        toolCallId: input.toolUse.id,
      });
      return successfulResult(value);
    } catch (error) {
      if (!(error instanceof Error && error.name === "ToolFailureError" &&
        "outcomeUnknown" in error && error.outcomeUnknown === false)) await input.onOutcomeUnknown?.(error);
      return textResult(
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      await this.dependencies.disposeTools?.(tools);
    }
  }
}
