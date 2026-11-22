import { describe, expect, it, vi } from "vitest";
import { toolsToPi } from "../src/pi-loop-tools";
import type { HarnessContext } from "../src/interface";

describe("Pi tool dispatcher boundary", () => {
  it("enqueues a tool call instead of executing it in the model loop", async () => {
    const execute = vi.fn(async () => "direct");
    const dispatch = vi.fn(async () => ({ status: "succeeded" as const, content: "worker-result", isError: false }));
    const tools = toolsToPi({
      tools: {
        read: { description: "read", inputSchema: { type: "object" }, execute },
      },
      runtime: {
        history: { getEvents: () => [] },
        broadcast: vi.fn(),
        toolDispatcher: { dispatch },
      },
    } as unknown as HarnessContext);

    const result = await tools[0].execute("call-1", { path: "/tmp/a" }, new AbortController().signal);
    expect(dispatch).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "/tmp/a" },
      concurrency: "parallel_safe",
    }, expect.any(AbortSignal));
    expect(execute).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: "worker-result" }]);
  });
});
