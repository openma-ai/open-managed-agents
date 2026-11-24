import { describe, expect, it } from "vitest";
import { createNodeCodemodeRuntime } from "../src/codemode-node";
import { createCodemodeTool } from "../src/codemode";

type AiTool = {
  execute: (input: unknown, options?: { abortSignal?: AbortSignal; toolCallId?: string }) => Promise<unknown>;
};

describe("codemode tool", () => {
  it("runs QuickJS in the Node worker-thread adapter and batches parallel tools", async () => {
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    const hostTools = {
      read: {
        description: "Read a value",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (input: { name: string }) => {
          const current = (active.get("read") ?? 0) + 1;
          active.set("read", current);
          peak.set("read", Math.max(peak.get("read") ?? 0, current));
          await new Promise((resolve) => setTimeout(resolve, 20));
          active.set("read", current - 1);
          return `value:${input.name}`;
        },
      },
      write: {
        description: "Write a value",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (input: { name: string }) => {
          const current = (active.get("write") ?? 0) + 1;
          active.set("write", current);
          peak.set("write", Math.max(peak.get("write") ?? 0, current));
          await new Promise((resolve) => setTimeout(resolve, 10));
          active.set("write", current - 1);
          return `written:${input.name}`;
        },
      },
    };
    const runtime = await createNodeCodemodeRuntime({ timeoutMs: 10_000 });
    const codemode = createCodemodeTool(hostTools, runtime) as unknown as AiTool;

    await expect(codemode.execute({
      code: "const values = await Promise.all([tools.read({name: 'a'}), tools.read({name: 'b'})]); text(values.join('|'));",
    })).resolves.toContain("value:a|value:b");
    await expect(codemode.execute({
      code: "const values = await Promise.all([tools.write({name: 'a'}), tools.write({name: 'b'})]); text(values.join('|'));",
    })).resolves.toContain("written:a|written:b");

    expect(peak.get("read")).toBe(2);
    expect(peak.get("write")).toBe(1);
  });

  it("propagates an abort into the local QuickJS runtime", async () => {
    const runtime = await createNodeCodemodeRuntime({ timeoutMs: 10_000 });
    const codemode = createCodemodeTool({
      read: {
        description: "Read a value",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "done",
      },
    }, runtime) as unknown as AiTool;
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expect(codemode.execute({ code: "await tools.read({});" }, { abortSignal: controller.signal }))
      .resolves.toContain("cancelled by test");
  });

  it("keeps a checkpoint and resumes an interrupted nested call", async () => {
    const calls: string[] = [];
    const checkpoints = new Map<string, unknown>();
    const baseRuntime = await createNodeCodemodeRuntime({ timeoutMs: 10_000 });
    const runtime = {
      ...baseRuntime,
      checkpointStore: {
        load: async (key: string) => (checkpoints.get(key) as never) ?? null,
        save: async (key: string, checkpoint: unknown) => {
          checkpoints.set(key, checkpoint);
        },
        clear: async (key: string) => {
          checkpoints.delete(key);
        },
      },
      checkpointKey: (toolCallId: string) => toolCallId,
    };
    const codemode = createCodemodeTool({
      read: {
        description: "Read a value",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          calls.push("read");
          await new Promise((resolve) => setTimeout(resolve, 25));
          return "resumed";
        },
      },
    }, runtime) as unknown as AiTool;

    const controller = new AbortController();
    const first = codemode.execute(
      { code: "const value = await tools.read({}); text(value);" },
      { abortSignal: controller.signal, toolCallId: "run-1" },
    );
    setTimeout(() => controller.abort(new Error("pause")), 10);
    const firstResult = await first;
    expect(firstResult).toContain("pause");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checkpoints.has("run-1")).toBe(true);

    const secondResult = await codemode.execute(
      { code: "const value = await tools.read({}); text(value);" },
      { toolCallId: "run-1" },
    );
    expect(secondResult).toContain("resumed");
    expect(calls).toEqual(["read"]);
    expect(checkpoints.has("run-1")).toBe(false);
  });
});
