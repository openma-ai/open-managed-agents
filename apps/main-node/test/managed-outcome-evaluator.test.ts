import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import { NodeManagedOutcomeEvaluator } from "../../../packages/control-plane-node/src/lib/node-managed-outcome-evaluator.js";

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

  afterEach(() => {
    vi.useRealTimers();
  });

  // #545 §0.7: the judge is session-outcomes' shared LLM judge (kept from
  // Cloudflare): an unparseable reply is retried, then becomes a typed
  // needs_revision verdict instead of an untyped value crossing the Port.
  it("retries an untyped judge response and returns a typed needs_revision verdict", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const evaluator = new NodeManagedOutcomeEvaluator({
      buildModel: async () => ({ provider: "test", modelId: "judge" }),
      judge: async () => {
        calls += 1;
        return {
          text: "looks good",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const evaluation = evaluator.evaluate({
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
      });
    await vi.runAllTimersAsync();

    await expect(evaluation).resolves.toEqual({
      result: "needs_revision",
      explanation: expect.stringContaining("llm judge exhausted retries"),
      usage: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: 4,
        outputTokens: 4,
      },
    });
    expect(calls).toBe(4);
  });

  it("resolves a file rubric through the workspace files Port", async () => {
    const prompts: string[] = [];
    const reads: string[] = [];
    const evaluator = new NodeManagedOutcomeEvaluator({
      buildModel: async () => ({ provider: "test", modelId: "judge" }),
      judge: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text: JSON.stringify({ result: "satisfied", explanation: "ok" }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      rubricFiles: (workspaceId) => ({
        read: async ({ fileId }) => {
          reads.push(`${workspaceId}/${fileId}`);
          return { type: "found", text: "Rubric from the file" };
        },
      }),
    });

    const result = await evaluator.evaluate({
      workspaceId: "workspace_01",
      session,
      environment,
      outcome: {
        id: "event_outcome_03",
        type: "user.define_outcome",
        description: "Complete",
        rubric: { type: "file", fileId: "file_01" },
        maxIterations: 1,
        outcomeId: "outc_03",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
      historyEvents: [],
      iteration: 0,
      abortSignal: new AbortController().signal,
    });

    expect(result.result).toBe("satisfied");
    expect(reads).toEqual(["workspace_01/file_01"]);
    expect(prompts[0]).toContain("Rubric from the file");
  });
});
