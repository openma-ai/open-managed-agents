import { describe, expect, it } from "vitest";
import { OFFICIAL_RUNTIME_EVENT_TYPES } from "@open-managed-agents/managed-agents-adapters-runtime";
import { toSessionEventResponse } from "../src/mappers/session-events";
import type { SessionEventView } from "../src/index";

const processedAt = "2026-08-26T07:00:00.000Z";

function minimalEvent(type: string): SessionEventView {
  const base = { id: `event_${type}`, processedAt };
  switch (type) {
    case "user.message":
      return { ...base, type, content: [{ type: "text", text: "hi" }] };
    case "user.interrupt":
      return { ...base, type };
    case "user.tool_confirmation":
      return { ...base, type, result: "allow", toolUseId: "tool_1" };
    case "user.custom_tool_result":
      return { ...base, type, customToolUseId: "tool_1" };
    case "user.define_outcome":
      return {
        ...base,
        type,
        description: "pass",
        rubric: { type: "text", content: "1" },
        maxIterations: 1,
        outcomeId: "out_1",
      };
    case "user.tool_result":
      return { ...base, type, toolUseId: "tool_1" };
    case "system.message":
      return { ...base, type, content: [{ type: "text", text: "sys" }] };
    case "session.warning":
      return { ...base, type, source: "test", message: "warn" };
    case "session.error":
      return {
        ...base,
        type,
        error: { type: "unknown_error", message: "x", retryStatus: "terminal" },
      };
    case "session.status_idle":
      return { ...base, type, stopReason: { type: "end_turn" } };
    case "session.usage":
      return {
        ...base,
        type,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreation: { ephemeralOneHourInputTokens: 0, ephemeralFiveMinuteInputTokens: 0 },
        },
      };
    case "span.model_request_end":
      return {
        ...base,
        type,
        isError: false,
        modelRequestStartId: "span_start",
        modelUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    case "span.outcome_evaluation_end":
      return {
        ...base,
        type,
        explanation: "ok",
        iteration: 1,
        outcomeEvaluationStartId: "eval_start",
        outcomeId: "out_1",
        result: "satisfied",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    case "agent.custom_tool_use":
      return { ...base, type, input: {}, name: "custom" };
    case "agent.mcp_tool_use":
      return {
        ...base,
        type,
        input: {},
        mcpServerName: "srv",
        name: "mcp_tool",
      };
    case "agent.mcp_tool_result":
      return { ...base, type, mcpToolUseId: "mcp_1" };
    case "agent.message":
      return { ...base, type, content: [{ type: "text", text: "hi" }] };
    case "agent.tool_use":
      return { ...base, type, input: {}, name: "bash" };
    case "agent.tool_result":
      return { ...base, type, toolUseId: "tool_1" };
    case "agent.thread_message_received":
      return {
        ...base,
        type,
        content: [{ type: "text", text: "hi" }],
        fromSessionThreadId: "sthr_1",
      };
    case "agent.thread_message_sent":
      return {
        ...base,
        type,
        content: [{ type: "text", text: "hi" }],
        toSessionThreadId: "sthr_1",
      };
    case "session.thread_created":
      return {
        ...base,
        type,
        agentName: "sub",
        sessionThreadId: "sthr_1",
      };
    case "session.thread_status_idle":
      return {
        ...base,
        type,
        agentName: "sub",
        sessionThreadId: "sthr_1",
        stopReason: { type: "end_turn" },
      };
    case "session.thread_status_rescheduled":
    case "session.thread_status_running":
    case "session.thread_status_terminated":
      return { ...base, type, agentName: "sub", sessionThreadId: "sthr_1" };
    case "session.updated":
      return { ...base, type };
    case "span.outcome_evaluation_start":
    case "span.outcome_evaluation_ongoing":
      return { ...base, type, iteration: 1, outcomeId: "out_1" };
    default:
      return { ...base, type } as SessionEventView;
  }
}

describe("runtime persistence allow-list maps to session event API", () => {
  it("maps every official runtime-produced event type", () => {
    for (const type of OFFICIAL_RUNTIME_EVENT_TYPES) {
      if (
        type === "user.message"
        || type === "user.interrupt"
        || type === "user.tool_confirmation"
        || type === "user.custom_tool_result"
        || type === "user.define_outcome"
        || type === "user.tool_result"
        || type === "system.message"
      ) {
        continue;
      }
      const event = minimalEvent(type);
      expect(() => toSessionEventResponse(event)).not.toThrow();
      const wire = toSessionEventResponse(event) as { type: string };
      expect(wire.type).toBe(type);
    }
  });
});
