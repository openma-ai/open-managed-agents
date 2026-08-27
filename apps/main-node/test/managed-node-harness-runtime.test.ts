import { describe, expect, it } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  InitialSessionEvent,
  SessionEventView,
} from "@open-managed-agents/managed-agents-application";

interface ManagedHarnessRuntime {
  history: {
    getEvents(): SessionEvent[];
    getMessages(): unknown[];
  };
  broadcast(event: SessionEvent): void;
  broadcastChunk(messageId: string, delta: string): Promise<void>;
  drain(): Promise<void>;
}

interface ManagedHarnessRuntimeConstructor {
  new (input: {
    initialEvents: InitialSessionEvent[];
    events: SessionEventView[];
    sandbox: SandboxExecutor;
    output(frame: unknown): Promise<void>;
    clock: { now(): Date };
    ids: { nextEventId(): string };
  }): ManagedHarnessRuntime;
}

describe("ManagedNodeHarnessRuntime", () => {
  it("encodes history and serializes stamped harness output", async () => {
    const modulePath = "../src/lib/node-managed-harness-runtime.ts";
    const runtimeModule = await import(/* @vite-ignore */ modulePath).catch(
      () => ({}),
    ) as { ManagedNodeHarnessRuntime?: ManagedHarnessRuntimeConstructor };
    const Runtime = runtimeModule.ManagedNodeHarnessRuntime ?? class {
      history = { getEvents: () => [] as SessionEvent[] };
      broadcast(): void {}
      async broadcastChunk(): Promise<void> {}
      async drain(): Promise<void> {}
    } as ManagedHarnessRuntimeConstructor;
    const initialEvents: InitialSessionEvent[] = [
      {
        type: "user.message",
        content: [{ type: "text", text: "Initial brief" }],
      },
    ];
    const events: SessionEventView[] = [
      {
        id: "event_status_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
    ];
    const output: unknown[] = [];
    const runtime = new Runtime({
      initialEvents,
      events,
      sandbox: {} as SandboxExecutor,
      output: async (frame) => { output.push(frame); },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_message_01" },
    });

    expect(runtime.history.getEvents()).toEqual([
      {
        type: "user.message",
        content: [{ type: "text", text: "Initial brief" }],
      },
      {
        id: "event_status_01",
        type: "session.status_running",
        processed_at: "2026-08-26T01:00:00.000Z",
      },
    ]);
    runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Hello" }],
    } as SessionEvent);
    await runtime.broadcastChunk("event_message_01", " world");
    await runtime.drain();

    expect(output).toEqual([
      {
        id: "event_message_01",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
        processed_at: "2026-08-26T02:00:00.000Z",
      },
      {
        type: "agent.message_chunk",
        message_id: "event_message_01",
        delta: " world",
      },
    ]);
    expect(runtime.history.getEvents()).toHaveLength(3);
  });

  it.each([
    {
      type: "user.custom_tool_result" as const,
      customToolUseId: "event_custom_tool_01",
    },
    {
      type: "user.tool_result" as const,
      toolUseId: "event_custom_tool_01",
    },
  ])("projects $type into harness tool history without emitting a new official event", async (result) => {
    const modulePath = "../src/lib/node-managed-harness-runtime.ts";
    const runtimeModule = await import(/* @vite-ignore */ modulePath) as {
      ManagedNodeHarnessRuntime: ManagedHarnessRuntimeConstructor;
    };
    const runtime = new runtimeModule.ManagedNodeHarnessRuntime({
      initialEvents: [],
      events: [
        {
          id: "event_custom_tool_01",
          type: "agent.custom_tool_use",
          name: "weather",
          input: { city: "Shanghai" },
          processedAt: "2026-08-26T03:00:00.000Z",
        },
        {
          id: "event_user_result_01",
          ...result,
          content: [{ type: "text", text: "Sunny" }],
          isError: false,
          processedAt: "2026-08-26T03:01:00.000Z",
        },
      ],
      sandbox: {} as SandboxExecutor,
      output: async () => {},
      clock: { now: () => new Date("2026-08-26T03:02:00.000Z") },
      ids: { nextEventId: () => "event_unused" },
    });

    expect(runtime.history.getMessages()).toEqual([
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "event_custom_tool_01",
          toolName: "weather",
          input: { city: "Shanghai" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "event_custom_tool_01",
          toolName: "weather",
          output: {
            type: "content",
            value: [{ type: "text", text: "Sunny" }],
          },
        }],
      },
    ]);
    expect(runtime.history.getEvents()).toHaveLength(2);
  });

  it("keeps a final system.message as mid-conversation system context", async () => {
    const modulePath = "../src/lib/node-managed-harness-runtime.ts";
    const runtimeModule = await import(/* @vite-ignore */ modulePath) as {
      ManagedNodeHarnessRuntime: ManagedHarnessRuntimeConstructor;
    };
    const runtime = new runtimeModule.ManagedNodeHarnessRuntime({
      initialEvents: [],
      events: [
        {
          id: "event_user_01",
          type: "user.message",
          content: [{ type: "text", text: "Migrate the API" }],
          processedAt: "2026-08-26T04:00:00.000Z",
        },
        {
          id: "event_system_01",
          type: "system.message",
          content: [{ type: "text", text: "Never weaken a Port" }],
          processedAt: "2026-08-26T04:00:00.000Z",
        },
      ],
      sandbox: {} as SandboxExecutor,
      output: async () => {},
      clock: { now: () => new Date("2026-08-26T04:01:00.000Z") },
      ids: { nextEventId: () => "event_unused" },
    });

    expect(runtime.history.getMessages()).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Migrate the API" }],
      },
      {
        role: "system",
        content: "Never weaken a Port",
      },
    ]);
  });

  it("projects user.define_outcome into a deterministic harness task message", async () => {
    const modulePath = "../src/lib/node-managed-harness-runtime.ts";
    const runtimeModule = await import(/* @vite-ignore */ modulePath) as {
      ManagedNodeHarnessRuntime: ManagedHarnessRuntimeConstructor;
    };
    const runtime = new runtimeModule.ManagedNodeHarnessRuntime({
      initialEvents: [],
      events: [{
        id: "event_outcome_01",
        type: "user.define_outcome",
        description: "Ship the managed API migration",
        rubric: { type: "text", content: "All SDK contracts pass" },
        maxIterations: 3,
        outcomeId: "outc_01",
        processedAt: "2026-08-26T05:00:00.000Z",
      }],
      sandbox: {} as SandboxExecutor,
      output: async () => {},
      clock: { now: () => new Date("2026-08-26T05:01:00.000Z") },
      ids: { nextEventId: () => "event_unused" },
    });

    expect(runtime.history.getMessages()).toEqual([{
      role: "user",
      content: [{
        type: "text",
        text: [
          '<outcome id="outc_01">',
          "Ship the managed API migration",
          "",
          "Rubric:",
          "All SDK contracts pass",
          "</outcome>",
        ].join("\n"),
      }],
    }]);
  });
});
