import { describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema } from "@open-managed-agents/session-runtime-sql";
import { ensureSessionSandboxBindingSchema, SqlSessionSandboxBindingStore } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { NodeManagedConfirmedToolExecutor } from "../../../packages/control-plane-node/src/lib/node-managed-confirmed-tool-executor";
import { DefaultNodeManagedSessionRunner, type DefaultNodeManagedSessionRunnerDependencies } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner";
import { NodeSessionSandboxLifecycle } from "../../../packages/control-plane-node/src/lib/node-session-sandbox-lifecycle";
import { NodeSessionExecutionDispatches } from "../../../packages/control-plane-node/src/lib/node-session-execution-dispatches";

const now = new Date("2026-11-05T00:00:00Z");
const scope = { workspaceId: "workspace-a", sessionId: "session-a" };
const session: Session = {
  id: scope.sessionId, agent: { id: "agent-a", name: "Agent", description: null,
    model: "test", mcpServers: [], multiagent: null, skills: [], system: null, tools: [], version: 1 },
  archivedAt: null, budget: null, createdAt: now.toISOString(), environmentId: "environment-a",
  metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null,
  updatedAt: now.toISOString(), usage: {}, vaultIds: [],
};
const environment: Environment = { id: "environment-a", archivedAt: null, config: { type: "self_hosted" },
  createdAt: now.toISOString(), updatedAt: now.toISOString(), description: null, metadata: {}, name: "Test" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  await ensureSessionSandboxBindingSchema(sql);
  const store = new SqlSessionSandboxBindingStore(sql);
  const dispatches = new NodeSessionExecutionDispatches(sql, () => now);
  await dispatches.ensureSchema("sqlite");
  const files = new Map<string, string>();
  const exec = vi.fn(async (_command: string) => "ok");
  const destroy = vi.fn(async () => undefined);
  const creates: string[] = [];
  const resumes: string[] = [];
  const clients = new WeakMap<SandboxExecutor, string>();
  const client = (id: string): SandboxExecutor => {
    const sandbox = { exec, readFile: async (path: string) => files.get(path) ?? "",
      writeFile: async (path: string, contents: string) => { files.set(path, contents); return "ok"; }, destroy };
    clients.set(sandbox, id);
    return sandbox;
  };
  const prepare = vi.fn(async () => undefined);
  const run = vi.fn(async (_context: HarnessContext) => undefined);
  const tools = deferred<HarnessContext["tools"]>();
  const disposed = vi.fn(async () => undefined);
  function runner(owner = "node-a", options: { workspaceCheckpoints?: DefaultNodeManagedSessionRunnerDependencies["workspaceCheckpoints"]; background?: boolean; lateTools?: boolean; tools?: HarnessContext["tools"]; confirmedTools?: DefaultNodeManagedSessionRunnerDependencies["confirmedTools"]; afterExecution?: DefaultNodeManagedSessionRunnerDependencies["afterExecution"]; publishArtifacts?: DefaultNodeManagedSessionRunnerDependencies["publishArtifacts"] } = {}) {
    const lifecycle = new NodeSessionSandboxLifecycle({ store, provider: "test", ownerId: owner,
      allocationIsolation: true, runtimeBindingSupported: true, now: () => now });
    return new DefaultNodeManagedSessionRunner({
      sandboxLifecycle: lifecycle, executionDispatches: dispatches, backgroundPiSandbox: options.background,
      workspaceCheckpoints: options.workspaceCheckpoints,
      buildSandbox: async ({ allocationId }) => { creates.push(allocationId!); return client(allocationId!); },
      resumeSandbox: async (_input, handle) => { resumes.push(handle.runtimeId); return client(handle.runtimeId); },
      sandboxHandle: sandbox => ({ provider: "test", runtimeId: clients.get(sandbox)! }),
      prepareSandbox: prepare,
      buildModel: async () => { if (options.lateTools) throw new Error("model unavailable"); return {} as HarnessContext["model"]; },
      buildTools: async () => options.lateTools ? tools.promise : options.tools ?? {}, disposeTools: disposed,
      buildHarness: () => ({ run }),
      buildHarnessContext: async input => input as unknown as HarnessContext,
      afterExecution: options.afterExecution,
      publishArtifacts: options.publishArtifacts,
      confirmedTools: options.confirmedTools ?? { execute: async () => { throw new Error("unexpected confirmation"); } },
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome"); } },
      harnessRetry: { attempts: 3, delayMs: () => 0 },
      clock: { now: () => now }, ids: { nextEventId: () => crypto.randomUUID() },
    });
  }
  async function input(suffix = "a", background = false) {
    const fence: SessionExecutionFence = { ...scope, executionId: `execution-${suffix}`, attemptId: `attempt-${suffix}`,
      ownerId: `node-${suffix}`, generation: 1, expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    await sql.prepare(`INSERT INTO managed_session_executions (workspace_id,session_id,lane_id,id,
      admitted_at_ms,events_json,events_fingerprint,state,attempt_id,owner_id,generation,deadline_at_ms,lease_expires_at_ms,revision)
      VALUES (?,?,'primary',?,?,'[]','test','running',?,?,1,?,?,1)`).bind(
      scope.workspaceId, scope.sessionId, fence.executionId, now.getTime(), fence.attemptId,
      fence.ownerId, now.getTime() + 600_000, Date.parse(fence.expiresAt)).run();
    const event = { id: `message-${suffix}`, type: "user.message" as const,
      content: [{ type: "text" as const, text: "hello" }], processedAt: now.toISOString() };
    return { ...scope, session: background ? { ...session, agent: { ...session.agent, openma: { harness: "pi" as const } } } : session,
      environment, executionFence: fence, initialEvents: [], historyEvents: [event], events: [event], output: async () => {} };
  }
  return { sql, store, dispatches, exec, destroy, creates, resumes, prepare, run, tools, disposed, runner, input };
}

describe("Node runner with durable Session sandbox ownership", () => {
  it.each(["archived", "deleted"] as const)("releases the Session handle on %s without destroying the resource", async reason => {
    const f = await fixture(); const runner = f.runner(); const input = await f.input();
    await runner.start(input);
    expect(runner.connectedSandbox(scope)).not.toBeNull();
    await runner.stop({ ...scope, reason });
    expect(runner.connectedSandbox(scope)).toBeNull();
    expect(await runner.sandboxAvailable(scope)).toBe(false);
    expect(f.destroy).not.toHaveBeenCalled();
    await expect(runner.start(input)).rejects.toThrow();
    expect(runner.connectedSandbox(scope)).toBeNull();
    expect(f.creates).toHaveLength(1);
  });

  it("refuses dispatch if archive wins while execution workspace preparation is pending", async () => {
    const f = await fixture(); const input = await f.input();
    const entered = deferred<void>(); const finish = deferred<void>();
    const binding = { bindingId: "workspace", mountPath: "/workspace" };
    const port = {
      materialize: vi.fn(async () => binding), attach: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const checkpoints = {
      active: async () => null, port: () => port,
      runtimeFence: (fence: SessionExecutionFence) => ({ ...fence, token: "test", environmentId: environment.id, workId: fence.executionId }),
    } as unknown as NonNullable<DefaultNodeManagedSessionRunnerDependencies["workspaceCheckpoints"]>;
    const runner = f.runner("node-a", { workspaceCheckpoints: checkpoints });
    await runner.start(input);
    port.materialize.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return binding; });
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.exec("must-not-run"); });
    const outcome = runner.accept(input).catch(error => error);
    await entered.promise;
    await runner.stop({ ...scope, reason: "archived" });
    finish.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(runner.connectedSandbox(scope)).toBeNull();
    expect(port.release).toHaveBeenCalledTimes(2);
  });

  it("cannot reinstall a handle when preparation finishes after Session close", async () => {
    const f = await fixture(); const runner = f.runner(); const input = await f.input();
    const entered = deferred<void>(); const finish = deferred<void>();
    f.prepare.mockImplementation(async () => { entered.resolve(); await finish.promise; });
    const started = runner.start(input);
    const outcome = started.catch(error => error);
    await entered.promise;
    await runner.stop({ ...scope, reason: "deleted" });
    finish.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(runner.connectedSandbox(scope)).toBeNull();
    expect(f.destroy).not.toHaveBeenCalled();
    expect(f.creates).toHaveLength(1);
  });

  it("retains the execution error when resource release also fails and leaves unknown evidence", async () => {
    const f = await fixture(); const runner = f.runner(); const first = await f.input();
    const original = new Error("harness invariant failed"); const cleanup = new Error("release response lost");
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.exec("one-effect"); throw original; });
    await runner.start(first);
    const release = vi.spyOn(NodeSessionSandboxLifecycle.prototype, "release").mockRejectedValue(cleanup);
    try {
      const error = await runner.accept(first).catch(error => error);
      expect(error.message).toBe(original.message);
      const causes: unknown[] = [];
      const visit = (value: unknown) => {
        causes.push(value);
        if (value instanceof AggregateError) value.errors.forEach(visit);
        if (value instanceof Error && value.cause !== undefined) visit(value.cause);
      };
      visit(error); expect(causes).toContain(original); expect(causes).toContain(cleanup);
      expect(f.exec).toHaveBeenCalledOnce();
      expect(await f.sql.prepare("SELECT phase FROM managed_session_execution_dispatches").first()).toEqual({ phase: "unknown" });
      expect((await f.store.getCurrent(scope))?.resource?.use).not.toBeNull();
    } finally { release.mockRestore(); }
  });

  it("rebinds the same files in a fresh runner and stopping an attempt never destroys the Session resource", async () => {
    const f = await fixture();
    const a = f.runner(); const first = await f.input();
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.writeFile("/workspace/result", "persistent"); });
    await a.start(first); await a.accept(first); await a.stop(scope);
    expect(f.destroy).not.toHaveBeenCalled();
    expect((await f.store.getCurrent(scope))?.resource?.use).toBeNull();
    const b = f.runner("node-b"); const second = await f.input("b");
    f.run.mockImplementation(async ctx => { expect(await ctx.runtime.sandbox.readFile("/workspace/result")).toBe("persistent"); });
    await b.start(second); await b.accept(second);
    expect(f.creates).toHaveLength(1);
    expect(f.resumes).toEqual(f.creates);
    expect(f.prepare.mock.calls.map(call => (call[0] as any)?.reattach)).toEqual([false, true]);
  });

  it("exposes execution access without any sandbox lifecycle authority", async () => {
    const f = await fixture(); const a = f.runner(); const first = await f.input();
    f.run.mockImplementation(async ctx => {
      for (const name of ["destroy", "renewLease", "suspend", "resume", "checkpoint", "runtimeCapabilities"]) {
        expect((ctx.runtime.sandbox as any)[name]).toBeUndefined();
      }
      await ctx.runtime.sandbox.exec("echo available");
    });
    await a.start(first); await a.accept(first); expect(f.exec).toHaveBeenCalledOnce();
  });

  it("quarantines a remotely pending command after lease loss, preventing a new owner's dispatch", async () => {
    const f = await fixture(); const remote = deferred<string>();
    f.exec.mockImplementation(() => remote.promise);
    const a = f.runner(); const first = await f.input();
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.exec("send-payment"); });
    await a.start(first);
    const turn = a.accept(first);
    const outcome = turn.catch(error => error);
    await vi.waitFor(() => expect(f.exec).toHaveBeenCalledOnce());
    a.cancel({ ...scope, attemptId: first.executionFence.attemptId, reason: "lease_lost" });
    expect(await outcome).toBeInstanceOf(Error);
    expect((await f.store.getCurrent(scope))?.resource).toMatchObject({ useOutcome: "unknown", use: { attemptId: "attempt-a" } });
    const b = f.runner("node-b");
    await expect(b.start(await f.input("b"))).rejects.toMatchObject({ code: "use_conflict" });
    expect(f.exec).toHaveBeenCalledOnce();
    remote.resolve("paid");
    await remote.promise;
    expect((await f.store.getCurrent(scope))?.resource?.useOutcome).toBe("unknown");
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it("blocks retries inside the same harness after an unknown provider result", async () => {
    const f = await fixture(); f.exec.mockRejectedValue(new Error("response lost after remote write"));
    const a = f.runner(); const first = await f.input();
    f.run.mockImplementation(async ctx => {
      await ctx.runtime.sandbox.exec("send-payment").catch(() => undefined);
      await ctx.runtime.sandbox.exec("send-payment").catch(() => undefined);
    });
    await a.start(first); await a.accept(first).catch(() => undefined);
    expect(f.exec).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
    expect((await f.store.getCurrent(scope))?.resource?.useOutcome).toBe("unknown");
  });

  it("keeps Session provisioning independent of a text-only attempt's cancellation", async () => {
    const f = await fixture(); const preparation = deferred<void>();
    f.prepare.mockImplementation(() => preparation.promise);
    const a = f.runner("node-a", { background: true }); const first = await f.input("a", true);
    await a.start(first); await a.accept(first);
    a.cancel({ ...scope, attemptId: first.executionFence.attemptId, reason: "lease_lost" });
    await a.stop(scope);
    preparation.resolve();
    await vi.waitFor(async () => expect((await f.store.getCurrent(scope))?.resource?.observedState).toBe("ready"));
    expect(f.exec).not.toHaveBeenCalled(); expect(f.destroy).not.toHaveBeenCalled();
    expect((await f.store.getCurrent(scope))?.resource?.use).toBeNull();
  });

  it("does not let a delayed cancellation from A revoke B's access", async () => {
    const f = await fixture(); const a = f.runner();
    const first = await f.input(); await a.start(first); await a.accept(first);
    const second = await f.input("b"); await a.start(second);
    f.run.mockImplementation(async ctx => {
      a.cancel({ ...scope, attemptId: first.executionFence.attemptId, reason: "lease_lost" });
      await ctx.runtime.sandbox.exec("echo current");
    });
    await a.accept(second); expect(f.exec).toHaveBeenCalledOnce();
  });

  it("disposes tools that finish acquiring after model initialization failed", async () => {
    const f = await fixture(); const a = f.runner("node-a", { lateTools: true }); const first = await f.input();
    await a.start(first); const outcome = a.accept(first).catch(error => error);
    f.tools.resolve({}); expect(await outcome).toBeInstanceOf(Error);
    expect(f.disposed).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled();
    expect((await f.store.getCurrent(scope))?.resource?.use).toBeNull();
  });

  it("blocks opaque redelivery without relying on any tool or agent output event", async () => {
    const f = await fixture(); const first = await f.input();
    expect(await f.dispatches.begin(first.executionFence)).toBe(true);
    // Simulate crash after dispatch, before recording any output. Only the
    // execution coordinator's new owner/generation changes; the evidence survives.
    await f.sql.prepare(`UPDATE managed_session_executions SET attempt_id = 'attempt-recovery',
      owner_id = 'node-recovery', generation = 2 WHERE id = ?`).bind(first.executionFence.executionId).run();
    const recovered = { ...first, executionFence: { ...first.executionFence,
      attemptId: "attempt-recovery", ownerId: "node-recovery", generation: 2 } };
    const b = f.runner("node-recovery"); await b.start(recovered);
    await expect(b.accept(recovered)).rejects.toThrow("earlier execution may have dispatched effects");
    expect(f.run).not.toHaveBeenCalled(); expect(f.exec).not.toHaveBeenCalled();
    // Ordinary new input also cannot erase the unresolved earlier execution.
    const next = await f.input("next");
    expect(await f.dispatches.begin(next.executionFence)).toBe(false);
  });

  it("persists an unknown MCP result before the harness can dispatch a second call", async () => {
    const f = await fixture(); const charge = vi.fn(async () => { throw new Error("response lost after charge"); });
    const a = f.runner("node-a", { tools: { charge: { execute: charge } } as any });
    const first = await f.input();
    f.run.mockImplementation(async ctx => {
      await (ctx.tools as any).charge.execute({}, {}).catch(() => undefined);
      await (ctx.tools as any).charge.execute({}, {}).catch(() => undefined);
    });
    await a.start(first);
    await expect(a.accept(first)).rejects.toThrow("outcome is unknown");
    expect(charge).toHaveBeenCalledOnce();
    await f.dispatches.finish(first.executionFence, false);
    expect(await f.dispatches.begin((await f.input("next")).executionFence)).toBe(false);
    expect(await f.sql.prepare("SELECT phase FROM managed_session_execution_dispatches").first()).toEqual({ phase: "unknown" });
  });
  it("does not treat a terminal idle as proof that started or unknown work drained", async () => {
    const f = await fixture(); const first = await f.input();
    expect(await f.dispatches.begin(first.executionFence)).toBe(true);
    const publish = vi.fn(async () => {});
    const runner = f.runner("node-recovery", { afterExecution: publish });
    await runner.start(first);
    await expect(runner.accept({ ...first, committedTerminal: { id: "idle", type: "session.status_idle", stopReason: { type: "end_turn" } } }))
      .rejects.toThrow("no durable evidence");
    expect(f.run).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });

  it("recovers only post-terminal work under a new owner and then admits new input", async () => {
    const f = await fixture(); const first = await f.input();
    const original = f.runner(); await original.start(first);
    expect(await f.dispatches.begin(first.executionFence)).toBe(true);
    await f.dispatches.drained(first.executionFence);
    await f.sql.prepare("UPDATE managed_session_executions SET attempt_id = 'replacement', owner_id = 'replacement', generation = 2 WHERE id = ?")
      .bind(first.executionFence.executionId).run();
    const fence = { ...first.executionFence, attemptId: "replacement", ownerId: "replacement", generation: 2 };
    const publish = vi.fn(async ({ sandbox }: { sandbox: SandboxExecutor }) => { await sandbox.readFile("/workspace/result"); });
    const recovered = f.runner("replacement", { afterExecution: publish });
    await recovered.start({ ...first, executionFence: fence });
    await recovered.accept({ ...first, executionFence: fence, committedTerminal: { id: "idle", type: "session.status_idle", stopReason: { type: "end_turn" } } });
    expect(publish).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled();
    expect((await f.store.getCurrent(scope))?.resource?.use).toBeNull();
    await f.dispatches.finish(first.executionFence, true);
    expect(await f.sql.prepare("SELECT phase FROM managed_session_execution_dispatches").first()).toEqual({ phase: "finished" });
    expect(await f.dispatches.begin((await f.input("next")).executionFence)).toBe(true);
  });

  it("records drained evidence and releases use before terminal publication", async () => {
    const f = await fixture(); const first = await f.input();
    f.run.mockImplementation(async ctx => { await ctx.runtime.sandbox.exec("completed-write"); });
    const publish = vi.fn(async ({ sandbox }: { sandbox: SandboxExecutor }) => { await sandbox.readFile("/workspace/result"); });
    const a = f.runner("node-a", { afterExecution: publish });
    let terminalObserved = false;
    await a.start(first);
    await a.accept({ ...first, output: async frame => {
      if ((frame as { type?: string }).type !== "session.status_idle") return;
      terminalObserved = true;
      expect(await f.sql.prepare("SELECT phase FROM managed_session_execution_dispatches").first()).toEqual({ phase: "drained" });
      expect((await f.store.getCurrent(scope))?.resource?.use).toBeNull();
    } });
    expect(terminalObserved).toBe(true); expect(publish).toHaveBeenCalledOnce();
    expect(await f.sql.prepare("SELECT phase FROM managed_session_execution_dispatches").first()).toEqual({ phase: "finished" });
  });

  it("keeps a swallowed artifact write failure unknown and gives publication no mutable sandbox capability", async () => {
    const f = await fixture(); const first = await f.input();
    const failure = new Error("Files commit response lost");
    const write = vi.fn(async () => { throw failure; });
    const publishArtifacts = vi.fn(async (input: Parameters<NonNullable<DefaultNodeManagedSessionRunnerDependencies["publishArtifacts"]>>[0]) => {
      expect(input).not.toHaveProperty("sandbox");
      expect(Object.keys(input.outputs).sort()).toEqual(["listPaths", "read"]);
      expect((await f.store.getCurrent(scope))?.resource?.use).toBeNull();
      await input.write(write).catch(() => undefined);
      await expect(input.write(write)).rejects.toThrow("requires reconciliation");
    });
    const runner = f.runner("node-a", { publishArtifacts });
    await runner.start(first);
    await expect(runner.accept(first)).rejects.toThrow("Artifact write outcome requires reconciliation");
    expect(write).toHaveBeenCalledOnce();
    expect(await f.sql.prepare("SELECT phase FROM managed_session_execution_dispatches").first()).toEqual({ phase: "unknown" });
    expect(await f.dispatches.recoverTerminal(first.executionFence, true)).toBe(false);
    expect(await f.dispatches.begin((await f.input("later")).executionFence)).toBe(false);
  });

  it("does not dispatch a second confirmed tool after the first outcome becomes unknown", async () => {
    const f = await fixture(); const charge = vi.fn(async () => { throw new Error("response lost after charge"); });
    const confirmations = new NodeManagedConfirmedToolExecutor({ buildExecutableTools: async () => ({ charge: { execute: charge } }) });
    const first = await f.input();
    const uses = ["one", "two"].map(id => ({ id, type: "agent.mcp_tool_use" as const, name: "charge", input: {}, mcpServerName: "payments" }));
    const events = uses.map((use, i) => ({ id: `confirm-${i}`, type: "user.tool_confirmation" as const, toolUseId: use.id, result: "allow" as const }));
    const a = f.runner("node-a", { confirmedTools: confirmations });
    await a.start(first);
    await expect(a.accept({ ...first, events, historyEvents: [...uses, ...events] })).rejects.toThrow("outcome is unknown");
    expect(charge).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled();
  });

  it("rechecks authority after confirmed tools finish acquiring", async () => {
    const acquired = deferred<Record<string, { execute: () => Promise<string> }>>();
    const charge = vi.fn(async () => "charged"); const dispose = vi.fn(async () => {});
    const executor = new NodeManagedConfirmedToolExecutor({ buildExecutableTools: () => acquired.promise, disposeTools: dispose });
    const controller = new AbortController();
    const result = executor.execute({ workspaceId: scope.workspaceId, session, environment,
      sandbox: {} as SandboxExecutor, abortSignal: controller.signal,
      confirmation: { id: "confirm", type: "user.tool_confirmation", toolUseId: "charge", result: "allow" },
      toolUse: { id: "charge", type: "agent.tool_use", name: "charge", input: {} } });
    controller.abort("lease_lost"); acquired.resolve({ charge: { execute: charge } });
    await result;
    expect(charge).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  });

});
