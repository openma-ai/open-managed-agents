import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { AcpRuntimeImpl } from "./runtime";
import { NodeSpawner } from "./spawners/node";
import { SandboxSpawner } from "./spawners/sandbox";
import { createAcpRuntime } from "./placement";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("sandbox ACP runtime", () => {
  it("runs the shared ACP session loop over a sandbox duplex process", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-sandbox-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const runtime = new AcpRuntimeImpl(
      new SandboxSpawner(sandbox),
    );
    const session = await runtime.start({
      agent: {
        command: process.execPath,
        args: ["-e", fakeAcpAgentSource],
        cwd: "/workspace",
      },
    });

    expect(session.acpSessionId).toBe("sandbox-acp-session");
    const events: unknown[] = [];
    for await (const event of session.prompt("hello from host")) {
      events.push(event);
    }
    expect(events).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "sandbox:hello from host" },
    });

    await session.dispose();
    expect(session.isAlive()).toBe(false);
  });

  it("selects local or sandbox placement without changing the ACP session contract", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-placement-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const localRuntime = createAcpRuntime({
      type: "local",
      spawner: new NodeSpawner(),
    });
    const sandboxRuntime = createAcpRuntime({
      type: "sandbox",
      sandbox,
    });

    const localResult = await runFakeAgent(localRuntime, workdir);
    const sandboxResult = await runFakeAgent(sandboxRuntime, "/workspace");

    expect(localResult).toEqual({
      acpSessionId: "sandbox-acp-session",
      updates: [{
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "sandbox:hello from host" },
      }],
    });
    expect(sandboxResult).toEqual(localResult);
  });
});

async function runFakeAgent(
  runtime: {
    start(options: {
      agent: { command: string; args: string[]; cwd: string };
    }): Promise<{
      acpSessionId: string;
      prompt(text: string): AsyncIterable<unknown>;
      dispose(): Promise<void>;
    }>;
  },
  cwd: string,
): Promise<{ acpSessionId: string; updates: unknown[] }> {
  const session = await runtime.start({
    agent: {
      command: process.execPath,
      args: ["-e", fakeAcpAgentSource],
      cwd,
    },
  });
  const updates: unknown[] = [];
  for await (const event of session.prompt("hello from host")) {
    if (
      event !== null &&
      typeof event === "object" &&
      "sessionUpdate" in event
    ) updates.push(event);
  }
  await session.dispose();
  return { acpSessionId: session.acpSessionId, updates };
}

const fakeAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
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
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "sandbox:" + text },
          },
        },
      });
      result({ stopReason: "end_turn" });
      break;
    }
    case "session/close":
      result({});
      break;
    case "session/cancel":
      result({});
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;
