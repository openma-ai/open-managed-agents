import { describe, expect, it } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import { NodeManagedConfirmedToolExecutor } from "../../../packages/control-plane-node/src/lib/node-managed-confirmed-tool-executor.js";

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
  it("preserves dispatched-unknown on an explicitly authorized retry result", async () => {
    const executor=new NodeManagedConfirmedToolExecutor({buildExecutableTools:async()=>({bash:{execute:async()=>{throw Object.assign(new Error("transport lost"),{outcome:"dispatched_unknown"});}}})});
    const result=await executor.execute({workspaceId:"ws",session,environment,sandbox:{} as SandboxExecutor,
      confirmation:{id:"allow",type:"user.tool_confirmation",result:"allow",toolUseId:"retry:original",processedAt:"2026-08-26T01:00:00Z"},
      toolUse:{id:"retry:original",type:"agent.tool_use",name:"bash",input:{command:"effect"},processedAt:"2026-08-26T00:00:00Z"},abortSignal:new AbortController().signal});
    expect(result).toMatchObject({isError:true,outcome:"dispatched_unknown"});
  });
  it("never turns an old execution fence loss into a settled ordinary failure", async () => {
    const {SessionExecutionLostError}=await import("@open-managed-agents/session-runtime-contract/coordination");
    const lost=new SessionExecutionLostError("old fence");
    const executor=new NodeManagedConfirmedToolExecutor({buildExecutableTools:async()=>({bash:{execute:async()=>{throw lost;}}})});
    await expect(executor.execute({workspaceId:"ws",session,environment,sandbox:{} as SandboxExecutor,
      confirmation:{id:"allow",type:"user.tool_confirmation",result:"allow",toolUseId:"retry:original",processedAt:"2026-08-26T01:00:00Z"},
      toolUse:{id:"retry:original",type:"agent.tool_use",name:"bash",input:{command:"effect"},processedAt:"2026-08-26T00:00:00Z"},abortSignal:new AbortController().signal})).rejects.toBe(lost);
  });
  it("does not dispatch a confirmed retry after interrupt has already aborted its execution", async () => {
    let effects=0;const abort=new AbortController();abort.abort("interrupt");
    const executor=new NodeManagedConfirmedToolExecutor({buildExecutableTools:async()=>({bash:{execute:async()=>{effects++;return "ok";}}})});
    await executor.execute({workspaceId:"ws",session,environment,sandbox:{} as SandboxExecutor,
      confirmation:{id:"allow",type:"user.tool_confirmation",result:"allow",toolUseId:"retry:original",processedAt:"2026-08-26T01:00:00Z"},
      toolUse:{id:"retry:original",type:"agent.tool_use",name:"bash",input:{command:"effect"},processedAt:"2026-08-26T00:00:00Z"},abortSignal:abort.signal}).catch(()=>undefined);
    expect(effects).toBe(0);
  });
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
