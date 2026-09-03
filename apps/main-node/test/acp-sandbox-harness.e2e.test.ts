import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { E2BSandboxExecutor } from "@open-managed-agents/sandbox/adapters/e2b";
import type { SandboxPort } from "@open-managed-agents/sandbox";
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
import { SessionStateMachine } from "@open-managed-agents/session-runtime";
import type { RuntimeAdapter } from "@open-managed-agents/session-runtime";
import { describe, expect, it, vi } from "vitest";

describe("ACP sandbox harness", () => {
  it("reuses one real ACP process across turns through SessionStateMachine", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-machine-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const agent = {
      id: "agent_acp_machine",
      name: "Machine-owned ACP sandbox agent",
      model: "unused-by-acp",
      system: "",
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
    const adapter = {
      beginTurn: async () => {},
      endTurn: async () => {},
      listOrphanTurns: async () => [],
    } as unknown as RuntimeAdapter;
    let checkpointBeforeDestroy: string | undefined;
    const machine = new SessionStateMachine({
      sessionId: "session_acp_machine",
      tenantId: "tenant_acp_machine",
      adapter,
      sandbox,
      loadAgent: async () => agent,
      buildModel: () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarness: () => {
        const harness = resolveHarness("acp-sandbox");
        return {
          run: (ctx) => harness.run(ctx as HarnessContext),
          dispose: (reason) => harness.dispose?.(reason) ?? Promise.resolve(),
        };
      },
      buildHarnessContext: async ({ userMessage }) => ({
        ...createContext(agent, runtime, ""),
        userMessage,
      }),
      beforeSandboxDestroy: async () => {
        checkpointBeforeDestroy = await sandbox.readFile(
          "/workspace/.openma/acp-session-checkpoint.json",
        );
      },
      publish: () => {},
    });

    try {
      await machine.runHarnessTurn(
        agent.id,
        createUserMessage("first"),
      );
      await machine.runHarnessTurn(
        agent.id,
        createUserMessage("second"),
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
      await machine.shutdown();
    }
    expect(JSON.parse(checkpointBeforeDestroy ?? "null")).toEqual(
      expect.objectContaining({ acpSessionId: "sandbox-acp-session" }),
    );
  });

  it("keeps one ACP process across turns and projects its events", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-harness-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    let leaseRenewals = 0;
    Object.assign(sandbox, {
      runtimeHandle: () => ({ provider: "local-test", runtimeId: "runtime-acp" }),
      runtimeCapabilities: () => ({ lease: true, suspend: [], checkpoint: [] }),
      status: async () => "running",
      renewLease: async () => { leaseRenewals += 1; },
      suspend: async () => { throw new Error("unexpected suspend"); },
      resume: async () => { throw new Error("unexpected resume"); },
      checkpoint: async () => { throw new Error("unexpected checkpoint"); },
    });
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
      expect(leaseRenewals).toBe(2);
    } finally {
      await (harness as { dispose?: () => Promise<void> }).dispose?.();
      await sandbox.destroy();
    }
  });

  it("runs the same stateful ACP harness through the E2B adapter", async () => {
    const service = new ScriptedE2BService();
    const sandbox = new E2BSandboxExecutor(service.sandbox as never, {});
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const agent = {
      id: "agent_acp_e2b",
      name: "E2B ACP sandbox agent",
      model: "unused-by-acp",
      system: "Keep the ACP process alive across E2B turns.",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          command: "acp-agent",
          args: ["--stdio"],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-09-02T00:00:00.000Z",
    } as unknown as AgentConfig;
    const adapter = {
      beginTurn: async () => {},
      endTurn: async () => {},
      listOrphanTurns: async () => [],
    } as unknown as RuntimeAdapter;
    let checkpointBeforeDestroy: string | undefined;
    const machine = new SessionStateMachine({
      sessionId: "session_acp_e2b",
      tenantId: "tenant_acp_e2b",
      adapter,
      sandbox,
      loadAgent: async () => agent,
      buildModel: () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarness: () => {
        const harness = resolveHarness("acp-sandbox");
        return {
          run: (ctx) => harness.run(ctx as HarnessContext),
          dispose: (reason) => harness.dispose?.(reason) ?? Promise.resolve(),
        };
      },
      buildHarnessContext: async ({ userMessage }) => ({
        ...createContext(agent, runtime, ""),
        userMessage,
      }),
      beforeSandboxDestroy: async () => {
        checkpointBeforeDestroy = await sandbox.readFile(
          "/workspace/.openma/acp-session-checkpoint.json",
        );
      },
      publish: () => {},
    });

    await machine.runHarnessTurn(agent.id, createUserMessage("first"));
    await machine.runHarnessTurn(agent.id, createUserMessage("second"));
    await machine.shutdown();

    expect(events.filter((event) => event.type === "agent.message")).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "e2b-acp:1:first" }],
      }),
      expect.objectContaining({
        content: [{ type: "text", text: "e2b-acp:2:second" }],
      }),
    ]);
    expect(service.processStarts).toBe(1);
    expect(service.leaseTtls).toEqual([90_000, 90_000]);
    expect(JSON.parse(checkpointBeforeDestroy ?? "null")).toEqual(
      expect.objectContaining({ acpSessionId: "e2b-acp-session" }),
    );
    expect(service.lifecycle.indexOf("session/close")).toBeGreaterThanOrEqual(0);
    expect(service.lifecycle.indexOf("process/kill")).toBeGreaterThan(
      service.lifecycle.indexOf("session/close"),
    );
    expect(service.lifecycle.at(-1)).toBe("sandbox/kill");
  });

  it("recovers a crashed sandbox ACP child through its native session id", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-harness-recovery-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const firstHarness = resolveHarness("acp-sandbox");
    let recoveredHarness: ReturnType<typeof resolveHarness> | undefined;
    const agent = {
      id: "agent_acp_sandbox_recovery",
      name: "Recovering ACP sandbox agent",
      model: "unused-by-acp",
      system: "Recover the native ACP session after a child crash.",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          command: process.execPath,
          args: ["-e", recoveringAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
    } as unknown as AgentConfig;

    try {
      const first = createContext(agent, runtime, "first");
      await firstHarness.onSessionInit?.(first, runtime);
      await firstHarness.run(first);
      await expect.poll(
        () => sandbox.exec("test -f first-child-exited && echo yes || echo no"),
      ).toBe("yes");
      // The marker is written immediately before process.exit(); wait for
      // the OS exit notification to reach the placement liveness wrapper.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // A fresh harness instance models a Worker/DO isolate restart. The old
      // in-memory #resumeAcpSessionId is gone; recovery must come from the
      // sandbox-persisted logical checkpoint.
      recoveredHarness = resolveHarness("acp-sandbox");
      await recoveredHarness.run(createContext(agent, runtime, "second"));

      expect(events.filter((event) => event.type === "agent.message")).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "new:first" }],
        }),
        expect.objectContaining({
          content: [{
            type: "text",
            text: "resume:sandbox-acp-recovery:second",
          }],
        }),
      ]);
    } finally {
      await (recoveredHarness as { dispose?: () => Promise<void> } | undefined)
        ?.dispose?.();
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

function createUserMessage(text: string): UserMessageEvent {
  return {
    type: "user.message",
    content: [{ type: "text", text }],
  } as UserMessageEvent;
}

function createRuntime(
  sandbox: SandboxPort,
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

class ScriptedE2BService {
  readonly files = new Map<string, string>();
  readonly leaseTtls: number[] = [];
  readonly lifecycle: string[] = [];
  processStarts = 0;
  #promptCount = 0;
  #activeProcess: { finish(): void } | null = null;

  readonly sandbox = {
    sandboxId: "e2b-runtime-acp-01",
    commands: {
      run: async (
        _command: string,
        options?: {
          background?: boolean;
          stdin?: boolean;
          onStdout?(data: string): void | Promise<void>;
        },
      ) => {
        if (!options?.background || !options.stdin) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        this.processStarts += 1;
        let input = "";
        let settled = false;
        let resolveWait!: (result: {
          stdout: string;
          stderr: string;
          exitCode: number;
        }) => void;
        const wait = new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => { resolveWait = resolve; });
        const finish = () => {
          if (settled) return;
          settled = true;
          resolveWait({ stdout: "", stderr: "", exitCode: 0 });
        };
        this.#activeProcess = { finish };
        const send = async (message: unknown) => {
          const line = `${JSON.stringify(message)}\n`;
          // Exercise the real ACP stream parser rather than handing it one
          // conveniently framed JSON object per callback.
          const split = Math.max(1, Math.floor(line.length / 2));
          await options.onStdout?.(line.slice(0, split));
          await options.onStdout?.(line.slice(split));
        };
        const dispatch = async (line: string) => {
          const request = JSON.parse(line) as {
            id: string | number;
            method: string;
            params?: {
              prompt?: Array<{ text?: string }>;
            };
          };
          const result = (value: unknown) => send({
            jsonrpc: "2.0",
            id: request.id,
            result: value,
          });
          switch (request.method) {
            case "initialize":
              await result({
                protocolVersion: 1,
                agentCapabilities: {
                  sessionCapabilities: { close: {} },
                },
              });
              break;
            case "session/new":
              await result({ sessionId: "e2b-acp-session" });
              break;
            case "session/prompt": {
              this.#promptCount += 1;
              const text = (request.params?.prompt ?? [])
                .map((block) => block.text ?? "")
                .join("");
              await send({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "e2b-acp-session",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: `e2b-acp:${this.#promptCount}:${text}`,
                    },
                  },
                },
              });
              await result({ stopReason: "end_turn" });
              break;
            }
            case "session/close":
              this.lifecycle.push("session/close");
              await result({});
              break;
            case "session/cancel":
              await result({});
              break;
            default:
              await send({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: "Method not found" },
              });
          }
        };
        return {
          pid: 91,
          sendStdin: async (data: string | Uint8Array) => {
            input += typeof data === "string"
              ? data
              : new TextDecoder().decode(data);
            const lines = input.split("\n");
            input = lines.pop() ?? "";
            for (const line of lines) {
              if (line) await dispatch(line);
            }
          },
          closeStdin: async () => {},
          kill: async () => {
            this.lifecycle.push("process/kill");
            finish();
            return true;
          },
          wait: () => wait,
        };
      },
    },
    files: {
      read: async (path: string) => {
        const value = this.files.get(path);
        if (value === undefined) throw new Error(`file not found: ${path}`);
        return value;
      },
      write: async (path: string, data: string | Uint8Array) => {
        this.files.set(
          path,
          typeof data === "string" ? data : new TextDecoder().decode(data),
        );
      },
    },
    kill: async () => {
      this.lifecycle.push("sandbox/kill");
      this.#activeProcess?.finish();
    },
    getInfo: async () => ({ state: "running" }),
    setTimeout: async (ttlMs: number) => {
      this.leaseTtls.push(ttlMs);
    },
    pause: async () => true,
    connect: async () => this.sandbox,
    createSnapshot: async () => ({
      snapshotId: "e2b-snapshot-acp-01",
      names: ["e2b-snapshot-acp-01"],
    }),
  };
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

const recoveringAcpAgentSource = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let mode = "uninitialized";
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      });
      break;
    case "session/new":
      mode = "new";
      result({ sessionId: "sandbox-acp-recovery" });
      break;
    case "session/resume":
      mode = "resume:" + request.params.sessionId;
      result({});
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
            content: { type: "text", text: mode + ":" + text },
          },
        },
      });
      result({ stopReason: "end_turn" });
      if (mode === "new") {
        setTimeout(() => {
          fs.writeFileSync("first-child-exited", "yes");
          process.exit(17);
        }, 10);
      }
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
