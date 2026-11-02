import { describe, expect, it } from "vitest";
import { AcpProxyHarness } from "../../apps/agent/src/harness/acp-proxy-loop";
import type { HarnessContext } from "../../apps/agent/src/harness/interface";
import {
  augmentAcpUserPrompt,
  parseSessionReadyFrame,
  resolveRepositoryLocalPath,
} from "../../apps/agent/src/harness/acp-proxy-delivery";

class Socket {
  listeners = new Map<string, Array<(event: unknown) => void>>();
  sent: Array<Record<string, unknown>> = [];
  onSend: (frame: Record<string, unknown>) => void = () => {};
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  receive(frame: unknown) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(frame) });
    }
  }
  close() {
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(frame);
    queueMicrotask(() => this.onSend(frame));
  }
}

describe("resolveRepositoryLocalPath", () => {
  it("returns explicit local_path", () => {
    expect(
      resolveRepositoryLocalPath([
        {
          type: "github_repository",
          resource: {
            local_path: "/home/user/project",
            mount_path: "/workspace/project",
          },
        },
      ]),
    ).toBe("/home/user/project");
  });

  it("ignores mount_path when local_path is absent", () => {
    expect(
      resolveRepositoryLocalPath([
        {
          type: "github_repository",
          resource: { mount_path: "/Users/alice/repo" },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("parseSessionReadyFrame", () => {
  it("reads bundle_dir and fresh from session.ready", () => {
    expect(
      parseSessionReadyFrame({
        type: "session.ready",
        bundle_dir: "/home/user/.oma/bridge/sessions/abc",
        fresh: true,
      }),
    ).toEqual({
      bundleDir: "/home/user/.oma/bridge/sessions/abc",
      freshSpawn: true,
    });
  });

  it("tolerates old daemons without bundle_dir", () => {
    expect(parseSessionReadyFrame({ type: "session.ready", acp_session_id: "x" })).toEqual({
      freshSpawn: false,
    });
  });
});

describe("augmentAcpUserPrompt", () => {
  it("includes platform context only on a fresh spawn with project cwd", () => {
    const prompt = augmentAcpUserPrompt("do work", {
      systemPrompt: "You are the OMA agent.",
      projectCwd: "/home/user/project",
      bundleDir: "/scratch/bundle",
      freshSpawn: true,
    });
    expect(prompt).toContain("/scratch/bundle");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("You are the OMA agent.");
    expect(prompt).toContain("do work");
    expect(prompt).not.toContain("/home/user/project/AGENTS.md");
  });

  it("does not repeat platform context on turn 2", () => {
    expect(
      augmentAcpUserPrompt("turn two", {
        systemPrompt: "You are the OMA agent.",
        projectCwd: "/home/user/project",
        bundleDir: "/scratch/bundle",
        freshSpawn: false,
      }),
    ).toBe("turn two");
  });

  it("skips path hints when bundle_dir is absent (old daemon)", () => {
    const prompt = augmentAcpUserPrompt("do work", {
      systemPrompt: "System.",
      projectCwd: "/home/user/project",
      freshSpawn: true,
    });
    expect(prompt).toContain("<openma-acp-platform>");
    expect(prompt).not.toContain("Read `");
  });
});

function harnessContext(overrides: {
  sessionReady?: Record<string, unknown>;
  userText?: string;
}): HarnessContext {
  const events: Array<Record<string, unknown>> = [];
  let socket: Socket | undefined;
  const userText = overrides.userText ?? "go";
  const context = {
    agent: {
      model: "test-model",
      runtime_binding: { runtime_id: "runner", acp_agent_id: "codex-acp" },
    },
    session_id: "remote-session",
    tenant_id: "team",
    acpSessionStartCwd: "/data/myproject",
    systemPrompt: "System from OMA.",
    userMessage: { type: "user.message", content: [{ type: "text", text: userText }] },
    env: {
      RUNTIME_ROOM: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async () => {
            socket = new Socket();
            socket.onSend = (frame) => {
              if (frame.type === "session.start") {
                socket!.receive(
                  overrides.sessionReady ?? {
                    type: "session.ready",
                    acp_session_id: "native",
                    bundle_dir: "/daemon/scratch/remote-session",
                    fresh: true,
                  },
                );
              }
              if (frame.type === "session.prompt") {
                socket!.receive({
                  type: "session.complete",
                  turn_id: frame.turn_id,
                });
              }
            };
            const ws = socket as Socket & { accept: () => void };
            ws.accept = () => {
              socket!.receive({ type: "attached", daemon_online: true });
            };
            return { status: 101, webSocket: ws };
          },
        }),
      },
    },
    runtime: {
      history: { getEvents: () => events },
      broadcast: (event: Record<string, unknown>) => events.push(event),
      pendingConfirmations: [],
      broadcastStreamStart: async () => {},
      broadcastChunk: async () => {},
      broadcastStreamEnd: async () => {},
      broadcastThinkingStart: async () => {},
      broadcastThinkingChunk: async () => {},
      broadcastThinkingEnd: async () => {},
    },
  } as unknown as HarnessContext;
  return Object.assign(context, { _socket: () => socket });
}

describe("AcpProxyHarness session.start cwd", () => {
  it("forwards repository local path on session.start and delivers platform context on turn 1", async () => {
    const context = harnessContext({});
    await new AcpProxyHarness().run(context);
    const socket = (context as { _socket: () => Socket })._socket();

    const start = socket!.sent.find((frame) => frame.type === "session.start");
    expect(start).toMatchObject({
      type: "session.start",
      agent_id: "codex-acp",
      cwd: "/data/myproject",
    });

    const prompt = socket!.sent.find((frame) => frame.type === "session.prompt");
    expect(String(prompt?.text)).toContain("<openma-acp-platform>");
    expect(String(prompt?.text)).toContain("System from OMA.");
    expect(String(prompt?.text)).toContain("/daemon/scratch/remote-session");
    expect(String(prompt?.text)).toContain("go");
  });

  it("does not prepend platform context when session.ready lacks fresh", async () => {
    const context = harnessContext({
      sessionReady: { type: "session.ready", acp_session_id: "native" },
    });
    await new AcpProxyHarness().run(context);
    const socket = (context as { _socket: () => Socket })._socket();
    const prompt = socket!.sent.find((frame) => frame.type === "session.prompt");
    expect(prompt?.text).toBe("go");
  });
});
