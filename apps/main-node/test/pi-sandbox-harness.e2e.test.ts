import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { PiHarness } from "@open-managed-agents/agent/harness/pi-loop";
import type {
  HarnessContext,
  HarnessRuntime,
} from "@open-managed-agents/agent/harness/interface";

describe(
  "PiHarness over SandboxPort",
  () => {
    it("executes a real local sandbox tool while only the LLM provider is mocked", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "oma-pi-harness-"));
      const sandbox = new LocalSubprocessSandbox({ workdir });

      try {
        const agent: AgentConfig = {
          id: "agent_pi_sandbox",
          name: "Pi sandbox agent",
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
                file_path: "/workspace/openma-pi-harness.txt",
                content: "pi-harness-sandbox-port-ok",
              },
              { id: "tool-write-sandbox" },
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
          session_id: "session_pi_sandbox",
          tools,
          model: {} as HarnessContext["model"],
          pi: { models, model: faux.getModel() },
          systemPrompt: agent.system,
          env: { ANTHROPIC_API_KEY: "mocked-by-faux-provider" },
          runtime,
        } satisfies HarnessContext;

        await new PiHarness().run(context);

        expect(await sandbox.readFile("/workspace/openma-pi-harness.txt")).toBe(
          "pi-harness-sandbox-port-ok",
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.tool_use",
            id: "tool-write-sandbox",
            name: "write",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.tool_result",
            tool_use_id: "tool-write-sandbox",
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
