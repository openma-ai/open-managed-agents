import { describe, expect, it } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import { NodeManagedConfirmedToolExecutor } from "../src/lib/node-managed-confirmed-tool-executor.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("NodeManagedConfirmedToolExecutor", () => {
  it("executes the confirmed tool with its original input and abort signal", async () => {
    const calls: unknown[] = [];
    const executor = new NodeManagedConfirmedToolExecutor({
      buildExecutableTools: async () => ({
        bash: {
          execute: async (input, options) => {
            calls.push({ input, options });
            return "exit=0\nready";
          },
        },
      }),
    });
    const abortController = new AbortController();

    const result = await executor.execute({
      workspaceId: "workspace_01",
      session,
      environment,
      sandbox: {} as SandboxExecutor,
      confirmation: {
        id: "event_confirmation_01",
        type: "user.tool_confirmation",
        result: "allow",
        toolUseId: "toolu_01",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
      toolUse: {
        id: "toolu_01",
        type: "agent.tool_use",
        name: "bash",
        input: { command: "echo ready" },
        evaluatedPermission: "ask",
        processedAt: "2026-08-26T00:59:00.000Z",
      },
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "exit=0\nready" }],
      isError: false,
    });
    expect(calls).toEqual([
      {
        input: { command: "echo ready" },
        options: {
          abortSignal: abortController.signal,
          messages: [],
          toolCallId: "toolu_01",
        },
      },
    ]);
  });

  it("returns a typed tool error instead of throwing through the runtime Port", async () => {
    const executor = new NodeManagedConfirmedToolExecutor({
      buildExecutableTools: async () => ({
        bash: {
          execute: async () => {
            throw new Error("sandbox unavailable");
          },
        },
      }),
    });

    await expect(
      executor.execute({
        workspaceId: "workspace_01",
        session,
        environment,
        sandbox: {} as SandboxExecutor,
        confirmation: {
          id: "event_confirmation_02",
          type: "user.tool_confirmation",
          result: "allow",
          toolUseId: "toolu_02",
          processedAt: "2026-08-26T01:00:00.000Z",
        },
        toolUse: {
          id: "toolu_02",
          type: "agent.tool_use",
          name: "bash",
          input: { command: "false" },
          evaluatedPermission: "ask",
          processedAt: "2026-08-26T00:59:00.000Z",
        },
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "sandbox unavailable" }],
      isError: true,
    });
  });
});
