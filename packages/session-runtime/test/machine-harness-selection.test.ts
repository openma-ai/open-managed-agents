import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import type { AgentConfig, UserMessageEvent } from "@open-managed-agents/shared";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { SessionStateMachine } from "../src/machine";
import type { RuntimeAdapter } from "../src/ports";

const agent: AgentConfig = {
  id: "agent_pi",
  name: "Pi agent",
  model: "model_pi",
  system: "",
  tools: [],
  harness: "pi",
  version: 1,
  created_at: "2026-08-30T00:00:00.000Z",
};

const userMessage = {
  type: "user.message",
  content: [{ type: "text", text: "run the sandbox tool" }],
} as UserMessageEvent;

describe("SessionStateMachine harness selection", () => {
  it("passes the loaded agent to the harness resolver", async () => {
    let selectedAgent: AgentConfig | undefined;
    let contextAgent: AgentConfig | undefined;
    let ran = false;

    const adapter = {
      beginTurn: async () => {},
      endTurn: async () => {},
      listOrphanTurns: async () => [],
    } as unknown as RuntimeAdapter;
    const sandbox = {
      exec: async () => "",
      readFile: async () => "",
      writeFile: async (path: string) => path,
    } satisfies SandboxPort;

    const machine = new SessionStateMachine({
      sessionId: "session_pi",
      tenantId: "tenant_pi",
      adapter,
      sandbox,
      loadAgent: async () => agent,
      buildModel: () => ({}) as LanguageModel,
      buildTools: async () => ({}),
      buildHarness: (resolvedAgent: AgentConfig) => {
        selectedAgent = resolvedAgent;
        return {
          run: async (ctx: unknown) => {
            ran = true;
            contextAgent = (ctx as { agent: AgentConfig }).agent;
          },
        };
      },
      buildHarnessContext: async (input) => input,
      publish: () => {},
    });

    await machine.runHarnessTurn(agent.id, userMessage);

    expect(selectedAgent).toBe(agent);
    expect(contextAgent).toBe(agent);
    expect(ran).toBe(true);
  });

  it("owns one stateful harness across turns and disposes it on agent revision", async () => {
    let currentAgent = agent;
    let builds = 0;
    const runs: number[] = [];
    const disposed: string[] = [];
    const shutdownOrder: string[] = [];
    const adapter = {
      beginTurn: async () => {},
      endTurn: async () => {},
      listOrphanTurns: async () => [],
    } as unknown as RuntimeAdapter;
    const sandbox = {
      exec: async () => "",
      readFile: async () => "",
      writeFile: async (path: string) => path,
      destroy: async () => { shutdownOrder.push("sandbox.destroy"); },
    } satisfies SandboxPort;
    const machine = new SessionStateMachine({
      sessionId: "session_stateful_harness",
      tenantId: "tenant_pi",
      adapter,
      sandbox,
      loadAgent: async () => currentAgent,
      buildModel: () => ({}) as LanguageModel,
      buildTools: async () => ({}),
      buildHarness: () => {
        const id = ++builds;
        return {
          run: async () => { runs.push(id); },
          dispose: async (reason) => { disposed.push(`${id}:${reason}`); },
        };
      },
      buildHarnessContext: async (input) => input,
      beforeSandboxDestroy: async () => {
        shutdownOrder.push("sandbox.checkpoint");
      },
      publish: () => {},
    });

    await machine.runHarnessTurn(agent.id, userMessage);
    await machine.runHarnessTurn(agent.id, userMessage);
    currentAgent = { ...agent, version: 2 };
    await machine.runHarnessTurn(agent.id, userMessage);

    expect(builds).toBe(2);
    expect(runs).toEqual([1, 1, 2]);
    expect(disposed).toEqual(["1:replace"]);

    await machine.shutdown();
    expect(disposed).toEqual(["1:replace", "2:shutdown"]);
    expect(shutdownOrder).toEqual([
      "sandbox.checkpoint",
      "sandbox.destroy",
    ]);
  });
});
