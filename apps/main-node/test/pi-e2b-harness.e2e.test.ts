import { describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { createE2BSandbox } from "@open-managed-agents/sandbox/adapters/e2b";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { PiHarness } from "@open-managed-agents/agent/harness/pi-loop";
import type {
  HarnessContext,
  HarnessRuntime,
} from "@open-managed-agents/agent/harness/interface";

const apiUrl = process.env.OMA_E2B_E2E_API_URL;
const sandboxUrl = process.env.OMA_E2B_E2E_SANDBOX_URL;
const apiKey = process.env.OMA_E2B_E2E_API_KEY;

describe.runIf(Boolean(apiUrl && sandboxUrl && apiKey))(
  "PiHarness over an E2B-compatible SandboxPort",
  () => {
    it("executes an actual sandbox tool while only the LLM provider is mocked", async () => {
      const sandbox = await createE2BSandbox({
        apiUrl,
        sandboxUrl,
        apiKey,
        templateId: process.env.OMA_E2B_E2E_TEMPLATE ?? "base",
      });

      try {
        const agent: AgentConfig = {
          id: "agent_pi_e2b",
          name: "Pi E2B agent",
          model: "faux-model",
          system: "Use the provided write tool.",
          tools: [
            {
              type: "agent_toolset_20260401",
              default_config: { enabled: false },
              configs: [{ name: "write", enabled: true }],
            },
          ],
          harness: "pi",
          version: 1,
          created_at: "2026-08-30T00:00:00.000Z",
        };
        const userMessage = {
          type: "user.message",
          content: [{ type: "text", text: "Write the sandbox marker." }],
        } as UserMessageEvent;
        const events: SessionEvent[] = [userMessage];

        const faux = fauxProvider({ tokensPerSecond: 100_000 });
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              "write",
              {
                file_path: "/tmp/openma-pi-e2b.txt",
                content: "pi-harness-sandbox-port-ok",
              },
              { id: "tool-write-e2b" },
            ),
            { stopReason: "toolUse", responseId: "response-write" },
          ),
          fauxAssistantMessage("Sandbox marker written.", {
            responseId: "response-final",
          }),
        ]);
        const models = createModels();
        models.setProvider(faux.provider);

        const runtime = {
          history: {
            getEvents: () => events,
            getMessages: () => [],
            append: (event: SessionEvent) => events.push(event),
          },
          sandbox,
          broadcast: (event: SessionEvent) => events.push(event),
          broadcastStreamStart: vi.fn(async () => {}),
          broadcastChunk: vi.fn(async () => {}),
          broadcastStreamEnd: vi.fn(async () => {}),
          broadcastThinkingStart: vi.fn(async () => {}),
          broadcastThinkingChunk: vi.fn(async () => {}),
          broadcastThinkingEnd: vi.fn(async () => {}),
          broadcastToolInputStart: vi.fn(async () => {}),
          broadcastToolInputChunk: vi.fn(async () => {}),
          broadcastToolInputEnd: vi.fn(async () => {}),
          reportUsage: vi.fn(async () => {}),
          pendingConfirmations: [],
        } as unknown as HarnessRuntime;

        const tools = await buildTools(agent, sandbox);
        const context = {
          agent,
          userMessage,
          session_id: "session_pi_e2b",
          tools,
          model: {} as HarnessContext["model"],
          pi: { models, model: faux.getModel() },
          systemPrompt: agent.system,
          env: { ANTHROPIC_API_KEY: "mocked-by-faux-provider" },
          runtime,
        } satisfies HarnessContext;

        await new PiHarness().run(context);

        expect(await sandbox.readFile("/tmp/openma-pi-e2b.txt")).toBe(
          "pi-harness-sandbox-port-ok",
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.tool_use",
            id: "tool-write-e2b",
            name: "write",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.tool_result",
            tool_use_id: "tool-write-e2b",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.message",
            content: [{ type: "text", text: "Sandbox marker written." }],
          }),
        );
      } finally {
        await sandbox.destroy();
      }
    });
  },
);
