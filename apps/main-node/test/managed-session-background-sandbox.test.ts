import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import {
  DefaultNodeManagedSessionRunner,
} from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import type { NodeManagedSessionRunnerAcceptInput } from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const now = "2026-10-26T08:00:00.000Z";
const session: Session = {
  id: "session_background", agent: {
    id: "agent_pi", name: "Pi", description: null, model: { id: "deepseek-flash" },
    mcpServers: [], multiagent: null, skills: [], system: null, tools: [], version: 1,
    openma: { harness: "pi" },
  },
  archivedAt: null, budget: null, createdAt: now, environmentId: "env_01",
  metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: "running",
  title: null, updatedAt: now, usage: {}, vaultIds: [],
};
const environment: Environment = {
  id: "env_01", archivedAt: null, config: { type: "cloud", networking: { type: "unrestricted" },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
  createdAt: now, updatedAt: now, description: null, metadata: {}, name: "OpenSandbox",
};
const scope = { workspaceId: "workspace_01", sessionId: session.id };
const runners: DefaultNodeManagedSessionRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.stop(scope)));
  vi.restoreAllMocks();
});

function fixture() {
  const creation = deferred<void>();
  const order: string[] = [];
  const sandbox = {
    exec: vi.fn(async () => { order.push("exec"); return "sandbox result"; }),
    readFile: vi.fn(async () => "file contents"),
    writeFile: vi.fn(async () => "written"),
    destroy: vi.fn(async () => undefined),
    runtimeHandle: () => ({ provider: "test", runtimeId: "runtime_01" }),
    runtimeCapabilities: () => ({ lease: true, suspend: [], checkpoint: [] }),
    status: vi.fn(async () => "running" as const),
    renewLease: vi.fn(async () => undefined),
    suspend: async () => { throw new Error("unsupported"); },
    resume: async () => undefined,
    checkpoint: async () => { throw new Error("unsupported"); },
  };
  const run = vi.fn(async (ctx: HarnessContext) => {
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "你好" }] });
  });
  const buildSandbox = vi.fn(async () => {
    order.push("create");
    await creation.promise;
    return sandbox;
  });
  const prepareSandbox = vi.fn(async () => { order.push("prepare"); });
  const synchronizeSandbox = vi.fn(async () => undefined);
  const afterExecution = vi.fn(async () => undefined);
  const runner = new DefaultNodeManagedSessionRunner({
    backgroundPiSandbox: true,
    buildSandbox, prepareSandbox, synchronizeSandbox, afterExecution,
    sandboxLease: { ttlMs: 9_000, intervalMs: 3_000 },
    buildModel: async () => { order.push("model"); return {} as HarnessContext["model"]; },
    buildTools: async () => ({}),
    buildHarness: () => ({ run }),
    buildHarnessContext: async input => ({ ...input } as unknown as HarnessContext),
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmation"); } },
    outcomes: { evaluate: async () => { throw new Error("unexpected evaluation"); } },
    clock: { now: () => new Date(now) },
    ids: { nextEventId: () => crypto.randomUUID() },
  });
  runners.push(runner);
  const output: unknown[] = [];
  const event = { id: "message_01", type: "user.message" as const,
    content: [{ type: "text" as const, text: "你好" }], processedAt: now };
  const input: NodeManagedSessionRunnerAcceptInput = {
    ...scope, session, environment, initialEvents: [], events: [event], historyEvents: [event],
    executionFence: { ...scope, executionId: "execution_01", attemptId: "attempt_01",
      ownerId: "worker_01", generation: 1, expiresAt: "2026-10-26T09:00:00.000Z" },
    output: async frame => { output.push(frame); },
  };
  return { runner, input, creation, sandbox, run, buildSandbox, prepareSandbox,
    synchronizeSandbox, afterExecution, output, order };
}

describe("Pi background sandbox startup", () => {
  it("starts provisioning immediately but completes a text response before the sandbox is ready", async () => {
    const f = fixture();
    await f.runner.start(f.input);
    await vi.waitFor(() => expect(f.buildSandbox).toHaveBeenCalledOnce());
    await f.runner.accept(f.input);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.output).toContainEqual(expect.objectContaining({ type: "agent.message" }));
    expect(f.output).toContainEqual(expect.objectContaining({ type: "session.status_idle" }));
    expect(f.runner.connectedSandbox(scope)).toBeNull();
    expect(f.prepareSandbox).not.toHaveBeenCalled();
    expect(f.sandbox.renewLease).not.toHaveBeenCalled();
    expect(f.synchronizeSandbox).not.toHaveBeenCalled();
    expect(f.afterExecution).not.toHaveBeenCalled();

    // The session's provisioning continues after the response has completed.
    f.creation.resolve();
    await vi.waitFor(() => expect(f.runner.connectedSandbox(scope)).toBe(f.sandbox));
    expect(f.prepareSandbox).toHaveBeenCalledOnce();
  });

  it("waits at the first sandbox operation, prepares once, and shares startup across concurrent tools", async () => {
    const f = fixture();
    f.run.mockImplementation(async ctx => {
      await Promise.all([
        ctx.runtime.sandbox.exec("echo hello"),
        ctx.runtime.sandbox.writeFile("/workspace/test.txt", "hello"),
      ]);
    });
    await f.runner.start(f.input);
    const turn = f.runner.accept(f.input);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
    expect(f.sandbox.renewLease).not.toHaveBeenCalled();
    f.creation.resolve();
    await turn;
    expect(f.buildSandbox).toHaveBeenCalledOnce();
    expect(f.prepareSandbox).toHaveBeenCalledOnce();
    expect(f.order.indexOf("model")).toBeLessThan(f.order.indexOf("prepare"));
    expect(f.order.indexOf("prepare")).toBeLessThan(f.order.indexOf("exec"));
    expect(f.sandbox.exec).toHaveBeenCalledWith("echo hello");
    expect(f.sandbox.writeFile).toHaveBeenCalledWith("/workspace/test.txt", "hello");
    expect(f.synchronizeSandbox).toHaveBeenCalledOnce();
    expect(f.afterExecution).toHaveBeenCalledOnce();

    await f.runner.start(f.input);
    await f.runner.accept(f.input);
    expect(f.buildSandbox).toHaveBeenCalledOnce();
    expect(f.prepareSandbox).toHaveBeenCalledOnce();
    expect(f.sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it("does not fail a text response when background provisioning fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fixture();
    await f.runner.start(f.input);
    f.creation.reject(new Error("sandbox provider unavailable"));
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    await f.runner.accept(f.input);
    expect(f.output).toContainEqual(expect.objectContaining({ type: "agent.message" }));
    expect(f.output).not.toContainEqual(expect.objectContaining({ type: "session.error" }));
  });

  it.each(["packages", "sandbox image"])("reprepares changed %s before a tool uses a prior turn's pending sandbox", async (change) => {
    const f = fixture();
    await f.runner.start(f.input);
    await f.runner.accept(f.input);
    const changedEnvironment: Environment = change === "sandbox image"
      ? { ...environment, openma: { sandboxImage: "analytics" } }
      : {
        ...environment, config: { type: "cloud" as const, networking: { type: "unrestricted" as const },
          packages: { apt: [], cargo: [], gem: [], go: [], npm: ["typescript"], pip: [] } },
      };
    const changed = { ...f.input, environment: changedEnvironment };
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.exec("tsc --version"); });
    await f.runner.start(changed);
    const turn = f.runner.accept(changed);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    f.creation.resolve();
    await turn;
    expect(f.buildSandbox).toHaveBeenCalledTimes(2);
    expect(f.prepareSandbox).toHaveBeenCalledTimes(2);
    expect(f.prepareSandbox).toHaveBeenLastCalledWith(expect.objectContaining({ environment: changed.environment }));
    expect(f.sandbox.exec).toHaveBeenCalledOnce();
  });

  it("stops provisioning after a text-only session is stopped and cleans up late allocations", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fixture();
    await f.runner.start(f.input);
    await f.runner.accept(f.input);
    await f.runner.stop(scope);
    f.creation.resolve();
    await vi.waitFor(() => expect(f.sandbox.destroy).toHaveBeenCalledOnce());
    expect(f.prepareSandbox).not.toHaveBeenCalled();
    expect(f.runner.connectedSandbox(scope)).toBeNull();
  });

  it("cancels a tool waiting for startup and destroys an allocation that arrives after cancellation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fixture();
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.exec("echo hello"); });
    await f.runner.start(f.input);
    const turn = f.runner.accept(f.input);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    const rejected = expect(turn).rejects.toThrow();
    f.runner.cancel({ ...scope, reason: "lease_lost" });
    await rejected;
    f.creation.resolve();
    await vi.waitFor(() => expect(f.sandbox.destroy).toHaveBeenCalledOnce());
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.runner.connectedSandbox(scope)).toBeNull();
  });
});
