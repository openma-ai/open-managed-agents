import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { SessionEventView } from "../src/index";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { sessionView, sessionWire } from "./session-fixtures";
import { buildSessionEventsTestApi } from "./test-api";

const processedAt = "2026-08-26T07:00:00.000Z";

describe("Managed Agents API — exhaustive session event history", () => {
  it("maps every latest official history-only event variant", async () => {
    const port = makeSessionEventsPort({
      listSessionEvents: async () => ({
        type: "page",
        page: {
          events: ([
            {
              id: "event_01",
              type: "agent.custom_tool_use",
              input: { city: "Shanghai" },
              name: "weather",
              processedAt,
              sessionThreadId: "sthr_01",
            },
            {
              id: "event_02",
              type: "agent.mcp_tool_result",
              mcpToolUseId: "event_mcp_use_01",
              processedAt,
              content: [{ type: "text", text: "done" }],
              isError: false,
            },
            {
              id: "event_03",
              type: "agent.mcp_tool_use",
              input: { path: "/tmp" },
              mcpServerName: "filesystem",
              name: "list_files",
              processedAt,
              evaluatedPermission: "ask",
              sessionThreadId: null,
            },
            {
              id: "event_04",
              type: "agent.message",
              content: [
                { type: "text", text: "Working" },
                { type: "redacted" },
              ],
              processedAt,
            },
            { id: "event_05", type: "agent.thinking", processedAt },
            {
              id: "event_06",
              type: "agent.thread_context_compacted",
              processedAt,
            },
            {
              id: "event_07",
              type: "agent.thread_message_received",
              content: [{ type: "text", text: "Review this" }],
              fromSessionThreadId: "sthr_02",
              fromAgentName: "reviewer",
              processedAt,
            },
            {
              id: "event_08",
              type: "agent.thread_message_sent",
              content: [{ type: "text", text: "Please review" }],
              toSessionThreadId: "sthr_02",
              toAgentName: "reviewer",
              processedAt,
            },
            {
              id: "event_09",
              type: "agent.tool_result",
              toolUseId: "event_tool_use_01",
              processedAt,
              content: [{ type: "text", text: "ok" }],
              isError: null,
            },
            {
              id: "event_10",
              type: "agent.tool_use",
              input: { command: "pwd" },
              name: "bash",
              processedAt,
              evaluatedPermission: "allow",
              sessionThreadId: "sthr_01",
            },
            {
              id: "event_11",
              type: "session.error",
              processedAt,
              error: {
                type: "credential_host_unreachable_error",
                credentialId: "cred_01",
                message: "Host blocked",
                retryStatus: "terminal",
                vaultId: "vlt_01",
              },
            },
            {
              id: "event_12",
              type: "session.status_idle",
              processedAt,
              stopReason: {
                type: "requires_action",
                eventIds: ["event_tool_use_01"],
              },
            },
            { id: "event_13", type: "session.status_rescheduled", processedAt },
            { id: "event_14", type: "session.status_running", processedAt },
            { id: "event_15", type: "session.status_terminated", processedAt },
            {
              id: "event_16",
              type: "session.thread_created",
              agentName: "reviewer",
              processedAt,
              sessionThreadId: "sthr_02",
            },
            {
              id: "event_17",
              type: "session.thread_status_idle",
              agentName: "reviewer",
              processedAt,
              sessionThreadId: "sthr_02",
              stopReason: { type: "budget_reached" },
            },
            {
              id: "event_18",
              type: "session.thread_status_rescheduled",
              agentName: "reviewer",
              processedAt,
              sessionThreadId: "sthr_02",
            },
            {
              id: "event_19",
              type: "session.thread_status_running",
              agentName: "reviewer",
              processedAt,
              sessionThreadId: "sthr_02",
            },
            {
              id: "event_20",
              type: "session.thread_status_terminated",
              agentName: "reviewer",
              processedAt,
              sessionThreadId: "sthr_02",
            },
            {
              id: "event_21",
              type: "span.model_request_start",
              processedAt,
            },
            {
              id: "event_22",
              type: "span.model_request_end",
              isError: false,
              modelRequestStartId: "event_21",
              modelUsage: {
                cacheCreationInputTokens: 1,
                cacheReadInputTokens: 2,
                inputTokens: 3,
                outputTokens: 4,
                speed: "fast",
              },
              processedAt,
            },
            {
              id: "event_23",
              type: "span.outcome_evaluation_start",
              iteration: 0,
              outcomeId: "outc_01",
              processedAt,
            },
            {
              id: "event_24",
              type: "span.outcome_evaluation_ongoing",
              iteration: 0,
              outcomeId: "outc_01",
              processedAt,
            },
            {
              id: "event_25",
              type: "span.outcome_evaluation_end",
              explanation: "Meets the rubric",
              iteration: 0,
              outcomeEvaluationStartId: "event_23",
              outcomeId: "outc_01",
              processedAt,
              result: "satisfied",
              usage: {
                cacheCreationInputTokens: 5,
                cacheReadInputTokens: 6,
                inputTokens: 7,
                outputTokens: 8,
              },
            },
            { id: "event_26", type: "session.deleted", processedAt },
            {
              id: "event_27",
              type: "session.updated",
              processedAt,
              agent: sessionView.agent,
              budget: { amountMinor: "3000", currency: "USD" },
              metadata: { phase: "api" },
              title: "Updated title",
            },
          ] satisfies SessionEventView[]) as SessionEventView[],
          nextCursor: null,
        },
      }),
    });
    const api = buildSessionEventsTestApi(port);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const page = await client.beta.sessions.events.list(sessionWire.id);

    expect(page.data.map((event) => event.type)).toEqual([
      "agent.custom_tool_use",
      "agent.mcp_tool_result",
      "agent.mcp_tool_use",
      "agent.message",
      "agent.thinking",
      "agent.thread_context_compacted",
      "agent.thread_message_received",
      "agent.thread_message_sent",
      "agent.tool_result",
      "agent.tool_use",
      "session.error",
      "session.status_idle",
      "session.status_rescheduled",
      "session.status_running",
      "session.status_terminated",
      "session.thread_created",
      "session.thread_status_idle",
      "session.thread_status_rescheduled",
      "session.thread_status_running",
      "session.thread_status_terminated",
      "span.model_request_start",
      "span.model_request_end",
      "span.outcome_evaluation_start",
      "span.outcome_evaluation_ongoing",
      "span.outcome_evaluation_end",
      "session.deleted",
      "session.updated",
    ]);
    expect(page.data[10]).toMatchObject({
      type: "session.error",
      error: {
        type: "credential_host_unreachable_error",
        credential_id: "cred_01",
        retry_status: { type: "terminal" },
        vault_id: "vlt_01",
      },
    });
    expect(page.data[21]).toMatchObject({
      type: "span.model_request_end",
      model_request_start_id: "event_21",
      model_usage: {
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2,
        input_tokens: 3,
        output_tokens: 4,
        speed: "fast",
      },
    });
    expect(page.data[26]).toMatchObject({
      type: "session.updated",
      budget: {
        type: "limit",
        max_list_cost: { amount: "3000", currency: "USD" },
      },
      metadata: { phase: "api" },
      title: "Updated title",
    });
  });
});
