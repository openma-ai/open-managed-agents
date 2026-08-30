import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import type {
  HarnessContext,
  HarnessRuntime,
} from "@open-managed-agents/agent/harness/interface";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { describe, expect, it, vi } from "vitest";

describe("ACP sandbox harness", () => {
  it("keeps one ACP process across turns and projects its events", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-harness-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const harness = resolveHarness("acp-sandbox");
    const agent = {
      id: "agent_acp_sandbox",
      name: "ACP sandbox agent",
      model: "unused-by-acp",
      system: "Always answer from the sandbox ACP process.",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          command: process.execPath,
          args: ["-e", fakeAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
    } as unknown as AgentConfig;

    try {
      const first = createContext(agent, runtime, "first");
      await harness.onSessionInit?.(first, runtime);
      await harness.run(first);
      await harness.run(createContext(agent, runtime, "second"));

      await expect(sandbox.readFile("/workspace/AGENTS.md")).resolves.toBe(
        "Always answer from the sandbox ACP process.\n",
      );
      expect(events.filter((event) => event.type === "agent.message")).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "sandbox-acp:1:first" }],
        }),
        expect.objectContaining({
          content: [{ type: "text", text: "sandbox-acp:2:second" }],
        }),
      ]);
    } finally {
      await (harness as { dispose?: () => Promise<void> }).dispose?.();
      await sandbox.destroy();
    }
  });
});

function createContext(
  agent: AgentConfig,
  runtime: HarnessRuntime,
  text: string,
): HarnessContext {
  return {
    agent,
    userMessage: {
      type: "user.message",
      content: [{ type: "text", text }],
    } as UserMessageEvent,
    session_id: "session_acp_sandbox",
    tools: {},
    model: {} as HarnessContext["model"],
    systemPrompt: agent.system,
    env: {},
    runtime,
  } as HarnessContext;
}

function createRuntime(
  sandbox: LocalSubprocessSandbox,
  events: SessionEvent[],
): HarnessRuntime {
  return {
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
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;
}

const fakeAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptCount = 0;
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      result({ sessionId: "sandbox-acp-session" });
      break;
    case "session/prompt": {
      promptCount += 1;
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "sandbox-acp:" + promptCount + ":" + text },
          },
        },
      });
      result({ stopReason: "end_turn" });
      break;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;
