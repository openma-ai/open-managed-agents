import { describe, expect, it } from "vitest";
import { NoopLogger, setRootLogger } from "@open-managed-agents/observability";
import type { LogBindings, Logger } from "@open-managed-agents/observability";
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
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts", import.meta.url).href;
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

  it("reportUsage emits session.usage for managed projection", async () => {
    const { ManagedNodeHarnessRuntime } = await import(
      "../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts"
    ) as { ManagedNodeHarnessRuntime: ManagedHarnessRuntimeConstructor };
    const output: unknown[] = [];
    const runtime = new ManagedNodeHarnessRuntime({
      initialEvents: [],
      events: [],
      sandbox: {} as SandboxExecutor,
      output: async (frame) => { output.push(frame); },
      clock: { now: () => new Date("2026-10-09T00:00:00.000Z") },
      ids: { nextEventId: () => "event_usage_01" },
    });
    await runtime.reportUsage(120, 15);
    await runtime.drain();
    expect(output).toEqual([
      expect.objectContaining({
        id: "event_usage_01",
        type: "session.usage",
        usage: {
          input_tokens: 120,
          output_tokens: 15,
        },
        processed_at: "2026-10-09T00:00:00.000Z",
      }),
    ]);
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
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts", import.meta.url).href;
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

  it("stamps events strictly increasing so same-millisecond events replay in order", async () => {
    const { ManagedNodeHarnessRuntime } = await import("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts") as unknown as
      { ManagedNodeHarnessRuntime: ManagedHarnessRuntimeConstructor };
    const output: Array<{ type: string; processed_at: string }> = [];
    let next = 0;
    const runtime = new ManagedNodeHarnessRuntime({
      initialEvents: [], events: [], sandbox: {} as SandboxExecutor,
      output: async (frame) => { output.push(frame as { type: string; processed_at: string }); },
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: { nextEventId: () => `event_${++next}` },
    });
    runtime.broadcast({ type: "agent.tool_use", id: "toolu_1", name: "bash", input: {} } as SessionEvent);
    runtime.broadcast({ type: "agent.tool_result", tool_use_id: "toolu_1", content: [] } as unknown as SessionEvent);
    await runtime.drain();
    expect(output.map((frame) => [frame.type, frame.processed_at])).toEqual([
      ["agent.tool_use", "2026-08-26T01:00:00.000Z"],
      ["agent.tool_result", "2026-08-26T01:00:00.001Z"],
    ]);
  });

  it("logs a rejected harness output instead of leaving an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    const logged: Array<{ bindings: LogBindings; message?: string }> = [];
    const capturing = {
      error(bindings: LogBindings, message?: string) { logged.push({ bindings, message }); },
      child() { return capturing; },
      trace() {}, debug() {}, info() {}, warn() {}, fatal() {},
    } as Logger;
    setRootLogger(capturing);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { ManagedNodeHarnessRuntime } = await import("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts") as unknown as
        { ManagedNodeHarnessRuntime: ManagedHarnessRuntimeConstructor };
      const runtime = new ManagedNodeHarnessRuntime({
        initialEvents: [], events: [], sandbox: {} as SandboxExecutor,
        output: async () => { throw new Error("Runtime projection event IDs collide"); },
        clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
        ids: { nextEventId: () => "event_tool_replay" },
      });
      runtime.broadcast({
        type: "agent.tool_use",
        id: "toolu_replay",
        name: "bash",
        input: { command: "echo hello" },
      } as SessionEvent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(logged).toEqual([{
        bindings: expect.objectContaining({
          op: "main-node.harness.output_failed",
          _tag: "HarnessOutputFailed",
          err: expect.objectContaining({ message: "Runtime projection event IDs collide" }),
        }),
        message: "Harness output failed",
      }]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      setRootLogger(new NoopLogger());
    }
  });

  it("keeps a final system.message as mid-conversation system context", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts", import.meta.url).href;
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
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.ts", import.meta.url).href;
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

  it("advertises steering only when wired and appends steered inputs to this turn's history", async () => {
    const { ManagedNodeHarnessRuntime } = await import("../../../packages/control-plane-node/src/lib/node-managed-harness-runtime");
    const base = {
      initialEvents: [], events: [], sandbox: {} as SandboxExecutor,
      output: async () => {}, clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: { nextEventId: () => "event_x" },
    };
    expect(new ManagedNodeHarnessRuntime(base).takeSteeringInputs).toBeUndefined();
    const steering = new ManagedNodeHarnessRuntime({
      ...base,
      takeSteeringInputs: async () => [{
        id: "u_mid", type: "user.message", content: [{ type: "text", text: "also" }], processedAt: null,
      } as unknown as SessionEventView],
    });
    const taken = await steering.takeSteeringInputs!();
    expect(taken).toEqual([expect.objectContaining({ id: "u_mid", type: "user.message" })]);
    expect(steering.history.getEvents().map((e) => (e as { id?: string }).id)).toContain("u_mid");
    expect(steering.getApplicationHistoryEvents().map((e) => e.id)).toContain("u_mid");
  });
});
