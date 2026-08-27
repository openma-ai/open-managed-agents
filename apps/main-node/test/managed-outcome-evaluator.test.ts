import { describe, expect, it } from "vitest";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import { NodeManagedOutcomeEvaluator } from "../src/lib/node-managed-outcome-evaluator.js";

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

describe("NodeManagedOutcomeEvaluator", () => {
  it("judges the defined outcome from application history and returns typed usage", async () => {
    const judgeCalls: unknown[] = [];
    const model = { provider: "test", modelId: "judge" };
    const evaluator = new NodeManagedOutcomeEvaluator({
      buildModel: async () => model,
      judge: async (input) => {
        judgeCalls.push(input);
        return {
          text: JSON.stringify({
            result: "needs_revision",
            explanation: "The release note is missing.",
          }),
          usage: { inputTokens: 21, outputTokens: 8 },
        };
      },
    });
    const abortController = new AbortController();

    const result = await evaluator.evaluate({
      workspaceId: "workspace_01",
      session,
      environment,
      outcome: {
        id: "event_outcome_01",
        type: "user.define_outcome",
        description: "The migration is complete",
        rubric: { type: "text", content: "Tests pass and release notes exist" },
        maxIterations: 3,
        outcomeId: "outc_01",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
      historyEvents: [
        {
          id: "event_message_01",
          type: "agent.message",
          content: [{ type: "text", text: "All tests pass." }],
          processedAt: "2026-08-26T01:01:00.000Z",
        },
      ],
      iteration: 1,
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({
      result: "needs_revision",
      explanation: "The release note is missing.",
      usage: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: 21,
        outputTokens: 8,
      },
    });
    expect(judgeCalls).toEqual([
      expect.objectContaining({
        model,
        abortSignal: abortController.signal,
        prompt: expect.stringContaining("The migration is complete"),
      }),
    ]);
    expect(judgeCalls).toEqual([
      expect.objectContaining({
        prompt: expect.stringContaining("Tests pass and release notes exist"),
      }),
    ]);
    expect(judgeCalls).toEqual([
      expect.objectContaining({
        prompt: expect.stringContaining("All tests pass."),
      }),
    ]);
  });

  it("rejects an untyped judge response instead of leaking it across the Port", async () => {
    const evaluator = new NodeManagedOutcomeEvaluator({
      buildModel: async () => ({ provider: "test", modelId: "judge" }),
      judge: async () => ({
        text: "looks good",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });

    await expect(
      evaluator.evaluate({
        workspaceId: "workspace_01",
        session,
        environment,
        outcome: {
          id: "event_outcome_02",
          type: "user.define_outcome",
          description: "Complete",
          rubric: { type: "text", content: "Done" },
          maxIterations: 1,
          outcomeId: "outc_02",
          processedAt: "2026-08-26T01:00:00.000Z",
        },
        historyEvents: [],
        iteration: 0,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("Outcome judge returned invalid JSON");
  });
});
