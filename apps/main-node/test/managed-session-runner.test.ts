import { describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import { createManagedSandboxBuilder } from "../../../packages/control-plane-node/src/lib/node-managed-sandbox-builder.js";
import { withReportedArtifactPublication } from "../../../packages/control-plane-node/src/openai-artifact-publication";
import { prepareSandboxEgress } from "../../../packages/sandbox-egress/src/install";
import { createEgressRelayPasses } from "../../../packages/managed-credential-resolver/src/relay";
import type { SandboxExecutor, SandboxLiveness } from "@open-managed-agents/sandbox";
import type { WorkspacePersistencePort } from "@open-managed-agents/runtime-resource-contract";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { NodeManagedWorkspaceCheckpoints } from "../../../packages/control-plane-node/src/lib/node-managed-workspace-checkpoints.js";
import { createSpritesSandbox, type SpritesClientPort, type SpriteSdkPort } from "../../../packages/managed-runtime-sprites/src/sprites.js";
import { DaytonaSandbox } from "../../../packages/sandbox-adapter-daytona/src/daytona.js";

// Seed only the optional SDK boundary; exec, destroy and egress stay real.
function allocatedDaytonaSandbox(state: {
  creates: number; deletes: number; commands: string[];
  beforeCommand?(command: string): Promise<void>;
}) {
  const sandbox = new DaytonaSandbox({ sessionId: session.id, apiKey: "fake-test-key", logger: { log() {}, warn() {} } });
  const sdk = {
    create: async () => {
      state.creates++;
      return {
        id: `sandbox_${state.creates}`,
        process: { executeCommand: async (command: string) => {
          state.commands.push(command);
          await state.beforeCommand?.(command);
          const stdout = command.includes("EGRESS_READY:")
            ? 'EGRESS_READY:{"pid":123,"port":4567,"caFile":"/workspace/ca.pem","caBundleFile":"/workspace/ca-bundle.pem"}'
            : command.includes("EGRESS_DIR:") ? "EGRESS_DIR:/workspace/.oma-egress" : "ok";
          return { exitCode: 0, result: "", artifacts: { stdout } };
        } },
        fs: {
          uploadFile: async () => {}, downloadFile: async () => Buffer.from(""), createFolder: async () => {},
        },
      };
    },
    delete: async () => { state.deletes++; },
  };
  const boundary = sandbox as unknown as { daytona: typeof sdk; sandboxPromise: ReturnType<typeof sdk.create> };
  boundary.daytona = sdk;
  boundary.sandboxPromise = sdk.create();
  return sandbox;
}
import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  Environment,
  Session,
  SessionEventView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import type {
  NodeManagedSessionRunner,
  NodeManagedSessionRunnerAcceptInput,
} from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

interface RunnerConstructor {
  new (dependencies: {
    buildSandbox(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      signal?: AbortSignal;
    }): Promise<SandboxExecutor>;
    prepareSandbox?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      signal?: AbortSignal;
    }): Promise<void>;
    refreshSandboxEnvironment?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
    }): Promise<void>;
    synchronizeSandbox?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      executionFence: NonNullable<NodeManagedSessionRunnerAcceptInput["executionFence"]>;
    }): Promise<void>;
    afterExecution?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      executionFence: NonNullable<NodeManagedSessionRunnerAcceptInput["executionFence"]>;
    }): Promise<void>;
    buildModel(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
    }): Promise<unknown>;
    buildTools(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
    }): Promise<unknown>;
    disposeTools?(tools: unknown): Promise<void>;
    buildHarness(): { run(context: unknown): Promise<void> };
    buildHarnessContext(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      acceptedEvents: NodeManagedSessionRunnerAcceptInput["events"];
      sandbox: SandboxExecutor;
      runtime: {
        broadcast(event: SessionEvent): void;
      };
      model: unknown;
      tools: unknown;
    }): Promise<unknown>;
    confirmedTools: {
      execute(input: {
        workspaceId: string;
        session: Session;
        environment: Environment;
        sandbox: SandboxExecutor;
        confirmation: Extract<
          NodeManagedSessionRunnerAcceptInput["events"][number],
          { type: "user.tool_confirmation" }
        >;
        toolUse: Extract<
          SessionEventView,
          { type: "agent.tool_use" | "agent.mcp_tool_use" }
        >;
        abortSignal: AbortSignal;
      }): Promise<{
        content?: ToolResultContentBlock[];
        isError?: boolean | null;
      }>;
    };
    outcomes: {
      evaluate(input: {
        workspaceId: string;
        session: Session;
        environment: Environment;
        outcome: Extract<
          NodeManagedSessionRunnerAcceptInput["events"][number],
          { type: "user.define_outcome" }
        >;
        historyEvents: SessionEventView[];
        iteration: number;
        abortSignal: AbortSignal;
      }): Promise<{
        result: "satisfied" | "needs_revision" | "failed";
        explanation: string;
        usage: {
          cacheCreationInputTokens: number;
          cacheReadInputTokens: number;
          inputTokens: number;
          outputTokens: number;
        };
      }>;
    };
    clock: { now(): Date };
    ids: { nextEventId(): string };
    runtimeGenerations?: { next(): string };
  }): NodeManagedSessionRunner & { connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null };
}

describe("DefaultNodeManagedSessionRunner", () => {
  it("prepares Session inputs after sandbox creation and before it becomes executable", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const order: string[] = [];
    const sandbox = {
      destroy: vi.fn(async () => { order.push("destroy"); }),
    } as unknown as SandboxExecutor;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => {
        order.push("build");
        return sandbox;
      },
      prepareSandbox: async (input) => {
        expect(input).toMatchObject({
          workspaceId: "workspace_01",
          session,
          environment,
          sandbox,
        });
        order.push("prepare");
      },
      buildModel: async () => {
        order.push("model");
        return {};
      },
      buildTools: async () => {
        order.push("tools");
        return {};
      },
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_inputs" },
    });

    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBeNull();
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    expect(order).toEqual(["build", "prepare"]);
    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBe(sandbox);
    expect(runner.connectedSandbox({ workspaceId: "workspace_other", sessionId: session.id })).toBeNull();
    await runner.stop({ workspaceId: "workspace_01", sessionId: session.id });
    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBeNull();
  });

  it("refreshes Vault egress on the same warm sandbox when Vaults are added, replaced and removed", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const { DefaultNodeManagedSessionRunner } = await import(/* @vite-ignore */ modulePath) as { DefaultNodeManagedSessionRunner: RunnerConstructor };
    const env: Record<string, string> = { USER_SETTING: "keep" };
    let builds = 0;
    let preparations = 0;
    let now = 1_000;
    let boundPass: string | undefined;
    const sandbox = {
      exec: async () => "",
      readFile: async () => "",
      destroy: async () => {},
      writeFile: async (path: string) => path,
      prepareCredentialEgress: async (binding: { pass: string }) => { boundPass = binding.pass; },
      clearCredentialEgress: async () => { boundPass = undefined; },
      setEnvVars: async (values: Record<string, string>) => { Object.assign(env, values); },
    };
    const runner = new DefaultNodeManagedSessionRunner({
      buildSandbox: async () => { builds++; return sandbox; },
      prepareSandbox: async () => { preparations++; },
      refreshSandboxEnvironment: async ({ workspaceId, session, sandbox }) => {
        await prepareSandboxEgress({
          sandbox,
          scope: { workspaceId, sessionId: session.id, vaultIds: session.vaultIds },
          placeholders: async (scope) => scope.vaultIds.includes("vlt_a")
            ? { GITHUB_TOKEN: "__cap_managed__" } : { GITLAB_TOKEN: "__cap_managed__" },
          relay: { endpoint: "https://control.example", pass: "" },
          issuePass: () => createEgressRelayPasses("root", () => now).issue({ workspaceId, sessionId: session.id, ttlMs: 60000 }),
        });
      },
      outcomes: { evaluate: async () => { throw new Error("unused"); } },
      confirmedTools: { execute: async () => { throw new Error("unused"); } },
      buildModel: async () => ({}), buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }), buildHarnessContext: async (input) => input,
      clock: { now: () => new Date(now) }, ids: { nextEventId: () => "event_egress" },
    });
    const start = (vaultIds: string[]) => runner.start({
      workspaceId: "workspace_01", sessionId: session.id,
      session: { ...session, vaultIds }, environment, initialEvents: [],
    });
    try {
      await start([]);
      expect(env.HTTPS_PROXY).toBeUndefined();
      await start(["vlt_a"]);
      expect(env.GITHUB_TOKEN).toBe("__cap_managed__");
      expect(boundPass).toBeDefined();
      const firstPass = boundPass;
      now += 1_000;
      await start(["vlt_a"]);
      expect(boundPass).not.toBe(firstPass);
      await start(["vlt_b"]);
      expect(env.GITHUB_TOKEN).toBe("");
      expect(env.GITLAB_TOKEN).toBe("__cap_managed__");
      expect(boundPass).toBeDefined();
      await start([]);
      expect(boundPass).toBeUndefined();
      for (const key of ["GITHUB_TOKEN", "GITLAB_TOKEN"]) expect(env[key], key).toBe("");
      expect(env.USER_SETTING).toBe("keep");
      expect(builds).toBe(1);
      expect(preparations).toBe(1);
      expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBe(sandbox);
    } finally {
      await runner.stop({ workspaceId: "workspace_01", sessionId: session.id });
    }
  });

  async function warmRefreshFixture(options: {
    liveness?: SandboxLiveness;
    destroy?: () => Promise<void>;
    releaseFails?: boolean;
  } = {}) {
    const fence = {
      workspaceId: "workspace_01", sessionId: session.id, executionId: "execution_01",
      attemptId: "attempt_01", ownerId: "worker_01", generation: 1,
      expiresAt: "2026-08-26T03:00:00.000Z",
    };
    const canonical = { id: "wsc_canonical", contentHash: `sha256:${"a".repeat(64)}`, revision: 1 };
    const bindings = new Map<string, Parameters<WorkspacePersistencePort["release"]>[0]>();
    const allocations: Array<{ sandbox: SandboxExecutor; bytes: string; destroyed: boolean }> = [];
    const released: string[] = [];
    const prepared: string[] = [];
    let refresh: () => Promise<void> = async () => {};
    const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql: {} as never, blobs: {} as never, intervalMs: 30_000 });
    vi.spyOn(checkpoints, "active").mockResolvedValue({ candidate: canonical, publishedAtMs: 1_000 });
    vi.spyOn(checkpoints, "port").mockImplementation((sandbox) => {
      const allocation = allocations.find((entry) => entry.sandbox === sandbox)!;
      const port: WorkspacePersistencePort = {
        capabilities: async () => ({ strategies: ["checkpoint_restore"] }),
        materialize: async ({ scope, fence, activeCheckpoint, idempotencyKey }) => {
          expect(activeCheckpoint).toEqual(canonical);
          const binding = { bindingId: idempotencyKey, mountPath: "/workspace" as const };
          bindings.set(binding.bindingId, { scope, fence, binding });
          return binding;
        },
        attach: async ({ binding }) => {
          expect(bindings.has(binding.bindingId)).toBe(true);
          allocation.bytes = "canonical workspace";
        },
        checkpoint: async () => { throw new Error("unexpected checkpoint publication"); },
        release: async (input) => {
          expect(input).toEqual(bindings.get(input.binding.bindingId));
          bindings.delete(input.binding.bindingId);
          released.push(input.binding.bindingId);
          if (options.releaseFails) throw new Error("binding release failed");
        },
      };
      return port;
    });
    const runner = new DefaultNodeManagedSessionRunner({
      workspaceCheckpoints: checkpoints,
      probeSandbox: async () => options.liveness ?? "alive",
      buildSandbox: async () => {
        const allocation = { sandbox: {} as SandboxExecutor, bytes: "", destroyed: false };
        allocation.sandbox = {
          destroy: async () => { allocation.destroyed = true; await options.destroy?.(); },
        } as SandboxExecutor;
        allocations.push(allocation);
        return allocation.sandbox;
      },
      prepareSandbox: async ({ sandbox }) => {
        prepared.push(allocations.find((entry) => entry.sandbox === sandbox)!.bytes);
      },
      refreshSandboxEnvironment: async () => refresh(),
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected tool execution"); } },
      buildModel: async () => { throw new Error("unexpected model build"); },
      buildTools: async () => { throw new Error("unexpected tool build"); },
      buildHarness: () => ({ run: async () => { throw new Error("unexpected harness run"); } }),
      buildHarnessContext: async () => { throw new Error("unexpected harness context"); },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_refresh" },
      runtimeGenerations: { next: () => `runtime_${allocations.length + 1}` },
    });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const start = (signal?: AbortSignal) => runner.start({
      ...scope, session, environment, initialEvents: [], signal,
      executionFence: { ...fence, attemptId: "attempt_02", generation: 2 },
    });
    await runner.start({ ...scope, session, environment, initialEvents: [], executionFence: fence });
    return { runner, scope, start, allocations, bindings, released, prepared,
      setRefresh: (next: () => Promise<void>) => { refresh = next; } };
  }

  it.each(["alive", "unknown"] as const)("cold-restores on the next start after a warm refresh fails despite %s liveness", async (liveness) => {
    const fixture = await warmRefreshFixture({ liveness });
    const failure = new Error("environment refresh failed");
    fixture.allocations[0]!.bytes = "uncommitted bytes";
    fixture.setRefresh(async () => { throw failure; });

    await expect(fixture.start()).rejects.toBe(failure);
    expect(fixture.runner.connectedSandbox(fixture.scope)).toBeNull();
    expect(fixture.bindings.size).toBe(0);
    expect(fixture.released).toEqual(["runtime_1"]);
    expect(fixture.allocations[0]!.destroyed).toBe(true);
    expect(fixture.allocations).toHaveLength(1);

    fixture.setRefresh(async () => {});
    await fixture.start();
    expect(fixture.allocations).toHaveLength(2);
    expect(fixture.runner.connectedSandbox(fixture.scope)).toBe(fixture.allocations[1]!.sandbox);
    expect(fixture.prepared).toEqual(["canonical workspace", "canonical workspace"]);
    expect([...fixture.bindings.keys()]).toEqual(["runtime_2"]);
    await fixture.runner.stop(fixture.scope);
    expect(fixture.bindings.size).toBe(0);
  });

  it("keeps a successfully refreshed warm sandbox and its workspace binding", async () => {
    const fixture = await warmRefreshFixture();
    let refreshes = 0;
    fixture.setRefresh(async () => { refreshes++; });
    await fixture.start();
    expect(refreshes).toBe(1);
    expect(fixture.allocations).toHaveLength(1);
    expect(fixture.runner.connectedSandbox(fixture.scope)).toBe(fixture.allocations[0]!.sandbox);
    expect([...fixture.bindings.keys()]).toEqual(["runtime_1"]);
    expect(fixture.released).toEqual([]);
    expect(fixture.prepared).toEqual(["canonical workspace"]);
    await fixture.runner.stop(fixture.scope);
  });

  it.each(["parent signal", "runner.cancel"])("discards the old binding when warm refresh is cancelled by %s", async (source) => {
    const fixture = await warmRefreshFixture();
    let finishRefresh!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    fixture.setRefresh(() => {
      markStarted();
      return new Promise<void>((resolve) => { finishRefresh = resolve; });
    });
    const controller = new AbortController();
    const pending = fixture.start(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "lease_lost" });
    await started;
    if (source === "parent signal") controller.abort(Object.assign(new Error("lease_lost"), { name: "AbortError" }));
    else fixture.runner.cancel({ ...fixture.scope, reason: "lease_lost" });
    finishRefresh();
    await rejected;
    expect(fixture.runner.connectedSandbox(fixture.scope)).toBeNull();
    expect(fixture.bindings.size).toBe(0);
    expect(fixture.allocations[0]!.destroyed).toBe(true);
    fixture.setRefresh(async () => {});
    await fixture.start();
    finishRefresh();
    await Promise.resolve();
    expect(fixture.allocations).toHaveLength(2);
    expect(fixture.runner.connectedSandbox(fixture.scope)).toBe(fixture.allocations[1]!.sandbox);
    expect([...fixture.bindings.keys()]).toEqual(["runtime_2"]);
    await fixture.runner.stop(fixture.scope);
  });

  it("preserves the refresh failure and destroys the sandbox even when binding release rejects", async () => {
    const fixture = await warmRefreshFixture({ releaseFails: true });
    const failure = new Error("environment refresh failed");
    fixture.setRefresh(async () => { throw failure; });
    await expect(fixture.start()).rejects.toBe(failure);
    expect(fixture.runner.connectedSandbox(fixture.scope)).toBeNull();
    expect(fixture.bindings.size).toBe(0);
    expect(fixture.allocations[0]!.destroyed).toBe(true);
    fixture.setRefresh(async () => {});
    await fixture.start();
    expect(fixture.allocations).toHaveLength(2);
    await fixture.runner.stop(fixture.scope).catch(() => {});
  });

  it("bounds failed warm refresh cleanup when sandbox destruction never settles", async () => {
    const fixture = await warmRefreshFixture({ destroy: () => new Promise<void>(() => {}) });
    const failure = new Error("environment refresh failed");
    fixture.setRefresh(async () => { throw failure; });
    vi.useFakeTimers();
    try {
      const pending = fixture.start();
      const rejected = expect(pending).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(fixture.runner.connectedSandbox(fixture.scope)).toBeNull();
      expect(fixture.bindings.size).toBe(0);
      expect(fixture.allocations[0]!.destroyed).toBe(true);
      fixture.setRefresh(async () => {});
      await expect(fixture.start()).rejects.toThrow(/cleanup/i);
      expect(fixture.allocations).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function adapterRefreshRunner(
    buildSandbox: () => Promise<SandboxExecutor>,
    refreshSandboxEnvironment: (input: { sandbox: SandboxExecutor; registerCleanup(cleanup: (sandbox: SandboxExecutor) => Promise<void>): void }) => Promise<void>,
  ) {
    return new DefaultNodeManagedSessionRunner({
      buildSandbox, refreshSandboxEnvironment, probeSandbox: async () => "alive",
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected tool"); } },
      buildModel: async () => { throw new Error("unexpected model"); },
      buildTools: async () => ({}), buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async () => { throw new Error("unexpected harness"); },
      clock: { now: () => new Date() }, ids: { nextEventId: () => "event_refresh" },
    });
  }

  it.each(["stop", "refresh failure"])("allows cold allocation after %s cleanup rejects but physical deletion succeeds", async (reason) => {
    let builds = 0; let destroys = 0; let failRefresh = false;
    const cleanupFailure = new Error("relay cleanup transport failed");
    const refreshFailure = new Error("original refresh failure");
    const runner = adapterRefreshRunner(async () => {
      builds++;
      return { destroy: async () => { destroys++; } } as SandboxExecutor;
    }, async ({ registerCleanup }) => {
      if (failRefresh) throw refreshFailure;
      registerCleanup(async () => { throw cleanupFailure; });
    });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const start = () => runner.start({ ...scope, session, environment, initialEvents: [] });
    await start();
    if (reason === "stop") await expect(runner.stop(scope)).rejects.toBe(cleanupFailure);
    else { failRefresh = true; await expect(start()).rejects.toBe(refreshFailure); }
    expect(destroys).toBe(1);
    expect(runner.connectedSandbox(scope)).toBeNull();
    failRefresh = false;
    await start();
    expect(builds).toBe(2);
    await expect(runner.stop(scope)).rejects.toBe(cleanupFailure);
    expect(destroys).toBe(2);
  });

  it("blocks Sprites reallocation until the timed-out physical deletion completes", async () => {
    const deletion = deferred();
    let current: SpriteSdkPort | undefined;
    let creates = 0;
    let lookups = 0;
    const client: SpritesClientPort = {
      getSprite: async () => {
        lookups++;
        if (!current) throw Object.assign(new Error("not found"), { statusCode: 404 });
        return current;
      },
      createSprite: async (name, options) => {
        creates++;
        const files = new Map<string, string>();
        const sprite = {
          name, labels: options?.labels ?? [],
          filesystem: () => ({
            readFile: async (path: string) => files.get(path),
            writeFile: async (path: string, data: string) => { files.set(path, data); },
            mkdir: async () => {},
          }),
          execFileHTTP: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          closeControlConnection: () => {},
          check: async () => ({ status: current === sprite ? "running" : "deleted" }),
          updateNetworkPolicy: async () => {},
          spawn: () => { throw new Error("unexpected process"); }, delete: async () => {},
        } as SpriteSdkPort;
        current = sprite;
        return sprite;
      },
      deleteSprite: async () => { await deletion.promise; current = undefined; },
    };
    let failRefresh = false;
    const runner = adapterRefreshRunner(
      () => createSpritesSandbox({ sessionId: session.id, workdir: "/workspace" }, {}, { client }),
      async () => { if (failRefresh) throw new Error("refresh failure"); },
    );
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const start = () => runner.start({ ...scope, session, environment, initialEvents: [] });
    await start();
    const old = runner.connectedSandbox(scope)!;
    await old.writeFile("/workspace/dirty.txt", "uncommitted");
    failRefresh = true;
    vi.useFakeTimers();
    try {
      const pending = start();
      const rejected = expect(pending).rejects.toThrow("refresh failure");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(runner.connectedSandbox(scope)).toBeNull();
      failRefresh = false;
      const previousLookups = lookups;
      await expect(start()).rejects.toThrow(/cleanup/i);
      expect(lookups).toBe(previousLookups);
      expect(creates).toBe(1);
      deletion.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await start();
      const fresh = runner.connectedSandbox(scope)!;
      expect(creates).toBe(2);
      expect(await fresh.readFile("/workspace/dirty.txt")).toBeUndefined();
      expect(await (fresh as SandboxExecutor & { status(): Promise<string> }).status()).toBe("running");
      await runner.stop(scope);
    } finally {
      deletion.resolve();
      vi.useRealTimers();
    }
  });

  it("revokes cancelled production egress refresh before it can resurrect a Daytona sandbox", async () => {
    const daytonaSdk = { creates: 0, deletes: 0, commands: [] as string[] };
    const lookup = deferred<Record<string, string>>();
    const resolving = deferred();
    const completed = deferred();
    let warm = false;
    let refreshError: unknown;
    const runner = adapterRefreshRunner(async () => {
      const sandbox = allocatedDaytonaSandbox(daytonaSdk);
      await sandbox.exec("allocate initial");
      return sandbox;
    }, async ({ sandbox }) => {
      if (!warm) return;
      try {
        await prepareSandboxEgress({
          sandbox, scope: { workspaceId: "workspace_01", sessionId: session.id, vaultIds: ["vault_test"] },
          relay: { endpoint: "https://example.test", pass: "" }, issuePass: async () => "fake-pass",
          placeholders: async () => { resolving.resolve(); return lookup.promise; },
        });
      } catch (error) { refreshError = error; throw error; }
      finally { completed.resolve(); }
    });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const start = () => runner.start({ ...scope, session, environment, initialEvents: [] });
    await start();
    warm = true;
    vi.useFakeTimers();
    try {
      const pending = start();
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "lease_lost" });
      await resolving.promise;
      runner.cancel({ ...scope, reason: "lease_lost" });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(runner.connectedSandbox(scope)).toBeNull();
      warm = false;
      await expect(start()).rejects.toThrow(/cleanup/i);
      lookup.resolve({ TOKEN: "placeholder" });
      await completed.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshError).toMatchObject({ name: "SandboxExecutionFencedError" });
      expect(daytonaSdk.creates).toBe(1);
      expect(daytonaSdk.deletes).toBe(1);
      expect(daytonaSdk.commands).toEqual(["allocate initial"]);
      await start();
      expect(daytonaSdk.creates).toBe(2);
      await runner.stop(scope);
      expect(daytonaSdk.deletes).toBe(2);
    } finally {
      lookup.resolve({ TOKEN: "placeholder" });
      vi.useRealTimers();
    }
  });

  it("drains an already-issued Daytona refresh command before deletion and reallocation", async () => {
    const command = deferred();
    const issued = deferred();
    const sdk = {
      creates: 0, deletes: 0, commands: [] as string[],
      beforeCommand: async () => { issued.resolve(); await command.promise; },
    };
    let warm = false;
    const runner = adapterRefreshRunner(async () => allocatedDaytonaSandbox(sdk), async ({ sandbox }) => {
      if (warm) await sandbox.exec("refresh command");
    });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const start = () => runner.start({ ...scope, session, environment, initialEvents: [] });
    await start();
    warm = true;
    vi.useFakeTimers();
    try {
      const pending = start();
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "lease_lost" });
      await issued.promise;
      runner.cancel({ ...scope, reason: "lease_lost" });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(sdk.deletes).toBe(0);
      warm = false;
      await expect(start()).rejects.toThrow(/cleanup/i);
      command.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(sdk.deletes).toBe(1);
      await start();
      expect(sdk.creates).toBe(2);
      await runner.stop(scope);
    } finally {
      command.resolve();
      vi.useRealTimers();
    }
  });

  it("deletes a real Daytona sandbox after production egress wraps its refresh-view destroy", async () => {
    const sdk = { creates: 0, deletes: 0, commands: [] as string[] };
    let failRefresh = false;
    const runner = adapterRefreshRunner(async () => allocatedDaytonaSandbox(sdk), async ({ sandbox, registerCleanup }) => {
      if (failRefresh) throw new Error("refresh failure");
      await prepareSandboxEgress({
        sandbox, registerCleanup, scope: { workspaceId: "workspace_01", sessionId: session.id, vaultIds: ["vault_test"] },
        relay: { endpoint: "https://example.test", pass: "" }, issuePass: async () => "fake-pass",
        placeholders: async () => ({ TOKEN: "placeholder" }),
      });
    });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const start = () => runner.start({ ...scope, session, environment, initialEvents: [] });
    await start();
    await start();
    expect(sdk.creates).toBe(1);
    failRefresh = true;
    await expect(start()).rejects.toThrow("refresh failure");
    expect(sdk.deletes).toBe(1);
    failRefresh = false;
    await start();
    expect(sdk.creates).toBe(2);
    await runner.stop(scope);
    expect(sdk.deletes).toBe(2);
  });

  it("keeps a new SQL lease owner's Sprite alive after the old owner's delayed cleanup", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    const coordinator = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    const now = Date.parse("2026-10-31T00:00:00Z");
    await coordinator.admit({ execution: { ...scope, id: "execution_handoff", admittedAt: new Date(now).toISOString(),
      events: [{ id: "event_handoff", type: "user.message", content: [{ type: "text", text: "hello" }] }] as never } });
    const first = await coordinator.claim({ ...scope, ownerId: "replica_a", attemptId: "attempt_a", claimedAt: new Date(now + 1).toISOString(), leaseTtlMs: 1_000 });
    if (first.type !== "claimed") throw new Error("expected first claim");
    const physical = new Map<string, SpriteSdkPort>();
    const files = new Map<string, Map<string, string>>();
    const client: SpritesClientPort = {
      getSprite: async (name) => {
        if (!physical.has(name)) throw Object.assign(new Error("not found"), { statusCode: 404 });
        return physical.get(name)!;
      },
      createSprite: async (name, options) => {
        const bytes = new Map<string, string>(); files.set(name, bytes);
        const sprite = {
          name, labels: options?.labels ?? [],
          filesystem: () => ({ readFile: async (path: string) => bytes.get(path), writeFile: async (path: string, data: string) => { bytes.set(path, data); }, mkdir: async () => {} }),
          execFileHTTP: async () => ({ stdout: "", stderr: "", exitCode: 0 }), closeControlConnection() {},
          check: async () => ({ status: physical.has(name) ? "running" : "deleted" }), updateNetworkPolicy: async () => {},
        } as SpriteSdkPort;
        physical.set(name, sprite); return sprite;
      },
      deleteSprite: async (name) => { physical.delete(name); },
    };
    const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql, blobs: {} as never, intervalMs: 30_000 });
    vi.spyOn(checkpoints, "active").mockResolvedValue({ candidate: { id: "wsc_canonical", contentHash: `sha256:${"a".repeat(64)}`, revision: 1 }, publishedAtMs: now });
    vi.spyOn(checkpoints, "port").mockImplementation((sandbox) => ({
      materialize: async ({ activeCheckpoint }) => { expect(activeCheckpoint?.id).toBe("wsc_canonical"); return { bindingId: crypto.randomUUID(), mountPath: "/workspace" }; },
      attach: async () => { await sandbox.writeFile("/workspace/canonical.txt", "canonical"); }, release: async () => {},
    } as WorkspacePersistencePort));
    const buildSandbox = createManagedSandboxBuilder({
      capabilities: { allocationIsolation: true }, workdir: () => "/workspace",
      build: (sessionId, workdir, ctx) => createSpritesSandbox({ ...ctx, sessionId, workdir }, {}, { client }),
    } as Parameters<typeof createManagedSandboxBuilder>[0]);
    const gate = deferred(); const began = deferred(); let warm = false;
    const base = { workspaceCheckpoints: checkpoints, buildSandbox, probeSandbox: async () => "alive" as const,
      outcomes: {} as never, confirmedTools: {} as never, buildModel: async () => ({} as never), buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }), buildHarnessContext: async () => ({} as never), clock: { now: () => new Date(now) }, ids: { nextEventId: () => "event_test" } };
    const a = new DefaultNodeManagedSessionRunner({ ...base, refreshSandboxEnvironment: async () => { if (warm) { began.resolve(); await gate.promise; } } });
    const b = new DefaultNodeManagedSessionRunner(base);
    await a.start({ ...scope, session, environment, initialEvents: [], executionFence: first.fence });
    const old = a.connectedSandbox(scope)!;
    await old.writeFile("/workspace/dirty.txt", "uncommitted"); warm = true;
    vi.useFakeTimers();
    try {
      const pending = a.start({ ...scope, session, environment, initialEvents: [], executionFence: first.fence });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "lease_lost" });
      await began.promise;
      const second = await coordinator.claim({ ...scope, ownerId: "replica_b", attemptId: "attempt_b", claimedAt: new Date(now + 1002).toISOString(), leaseTtlMs: 30_000 });
      if (second.type !== "claimed") throw new Error("expected second claim");
      a.cancel({ ...scope, reason: "lease_lost" }); await vi.advanceTimersByTimeAsync(5_000); await rejected;
      await b.start({ ...scope, session, environment, initialEvents: [], executionFence: second.fence });
      const fresh = b.connectedSandbox(scope)!;
      expect(physical.size).toBe(2);
      expect(await fresh.readFile("/workspace/canonical.txt")).toBe("canonical");
      expect(await fresh.readFile("/workspace/dirty.txt")).toBeUndefined();
      gate.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(physical.size).toBe(1);
      expect(await (fresh as SandboxExecutor & { status(): Promise<string> }).status()).toBe("running");
      expect((await coordinator.renew({ fence: second.fence, renewedAt: new Date(now + 1004).toISOString(), leaseTtlMs: 30_000 })).type).toBe("renewed");
      await b.stop(scope);
    } finally { gate.resolve(); vi.useRealTimers(); await sql.close?.(); }
  });

  it("runs registered lifecycle cleanup before destroying a sandbox replaced during execution", async () => {
    const order: string[] = []; let builds = 0; let lost = false;
    const runner = new DefaultNodeManagedSessionRunner({
      buildSandbox: async () => {
        const id = ++builds;
        return { exec: async () => { if (id === 1) { lost = true; throw new Error("command unavailable"); } return "ok"; },
          destroy: async () => { order.push(`destroy_${id}`); } } as SandboxExecutor;
      },
      probeSandbox: async () => lost ? "lost" : "alive",
      refreshSandboxEnvironment: async ({ registerCleanup }) => {
        const id = builds;
        registerCleanup(async () => { order.push(`cleanup_${id}`); });
      },
      outcomes: {} as never, confirmedTools: {} as never, buildModel: async () => ({} as never), buildTools: async () => ({}),
      buildHarnessContext: async input => input as never,
      buildHarness: () => ({ run: async context => { await (context as unknown as { sandbox: SandboxExecutor }).sandbox.exec("first command"); } }),
      harnessRetry: { attempts: 1, delayMs: () => 0 },
      clock: { now: () => new Date() }, ids: { nextEventId: () => crypto.randomUUID() },
    });
    const scope = { workspaceId: "workspace_01", sessionId: session.id };
    await runner.start({ ...scope, session, environment, initialEvents: [] });
    const event = { id: "event_message", type: "user.message", content: [{ type: "text", text: "go" }], processedAt: new Date().toISOString() } as const;
    await runner.accept({ ...scope, session, environment, initialEvents: [], events: [event], historyEvents: [event], output: async () => {} }).catch(() => {});
    expect(builds).toBe(2);
    expect(order.slice(0, 2)).toEqual(["cleanup_1", "destroy_1"]);
    await runner.stop(scope);
  });

  it("destroys a new sandbox when Session input preparation fails", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const destroy = vi.fn(async () => undefined);
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({ destroy } as unknown as SandboxExecutor),
      prepareSandbox: async () => { throw new Error("input staging failed"); },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_inputs" },
    });

    await expect(runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    })).rejects.toThrow("input staging failed");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("replaces a prepared sandbox when the Session resource snapshot changes", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const destroyed: number[] = [];
    const preparedResourceCounts: number[] = [];
    let generation = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => {
        generation += 1;
        const current = generation;
        return {
          destroy: async () => { destroyed.push(current); },
        } as SandboxExecutor;
      },
      prepareSandbox: async ({ session }) => {
        preparedResourceCounts.push(session.resources.length);
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_resource_refresh" },
    });
    const changedSession: Session = {
      ...session,
      resources: [{
        id: "sesrsc_file_01",
        type: "file",
        createdAt: "2026-08-26T03:00:00.000Z",
        fileId: "file_01",
        mountPath: "/mnt/session/uploads/file_01",
        updatedAt: "2026-08-26T03:00:00.000Z",
      }],
    };

    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: changedSession,
      environment,
      initialEvents: [],
    });

    expect(preparedResourceCounts).toEqual([0, 1]);
    expect(destroyed).toEqual([1]);
  });

  it("runs a user message between official lifecycle events", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath).catch(
      () => ({}),
    ) as { DefaultNodeManagedSessionRunner?: RunnerConstructor };
    const Runner = runnerModule.DefaultNodeManagedSessionRunner ?? class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async accept(): Promise<void> {}
      async archiveThread(): Promise<void> {}
    } as RunnerConstructor;
    const sandbox = {} as SandboxExecutor;
    const contexts: unknown[] = [];
    const lifecycle: string[] = [];
    const builtTools = { bash: { type: "tool" } };
    let nextId = 0;
    const runner = new Runner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({ type: "model" }),
      buildTools: async () => builtTools,
      disposeTools: async (tools) => {
        expect(tools).toBe(builtTools);
        lifecycle.push("dispose");
      },
      synchronizeSandbox: async (input) => {
        expect(input).toMatchObject({
          workspaceId: "workspace_01",
          session,
          environment,
          sandbox,
          runtimeGeneration: "runtime_generation_01",
          executionFence: {
            executionId: "event_user_01",
            attemptId: "attempt_01",
            ownerId: "worker_01",
            generation: 1,
          },
        });
        lifecycle.push("synchronize");
      },
      afterExecution: withReportedArtifactPublication(async input => {
        expect(input.executionFence.executionId).toBe("event_user_01");
        expect(lifecycle.at(-1)).toBe("idle");
        lifecycle.push("afterExecution");
        throw new Error("Output copy failed after completion");
      }, (error, input) => {
        expect(error).toMatchObject({ message: "Output copy failed after completion" });
        expect(input.session.id).toBe(session.id);
        lifecycle.push("publicationReported");
      }),
      buildHarness: () => ({
        run: async (context) => {
          lifecycle.push("run");
          const runtime = (context as {
            runtime: { broadcast(event: SessionEvent): void };
          }).runtime;
          runtime.broadcast({
            type: "agent.message",
            content: [{ type: "text", text: "Hello" }],
          } as SessionEvent);
        },
      }),
      buildHarnessContext: async (input) => {
        contexts.push(input);
        return input;
      },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => `event_runtime_0${++nextId}` },
      runtimeGenerations: { next: () => "runtime_generation_01" },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_01",
      type: "user.message",
      content: [{ type: "text", text: "Continue" }],
      processedAt: "2026-08-26T01:00:00.000Z",
    };
    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [event],
      historyEvents: [event],
      executionFence: {
        workspaceId: "workspace_01",
        sessionId: session.id,
        executionId: "event_user_01",
        attemptId: "attempt_01",
        ownerId: "worker_01",
        generation: 1,
        expiresAt: "2026-08-26T02:01:00.000Z",
      },
      output: async (frame) => {
        output.push(frame);
        if ((frame as { type?: string }).type === "session.status_idle") {
          lifecycle.push("idle");
        }
      },
    });

    expect(contexts).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        session,
        environment,
        acceptedEvents: [event],
        sandbox,
        model: { type: "model" },
        tools: { bash: { type: "tool" } },
        runtime: expect.any(Object),
      }),
    ]);
    expect(output).toEqual([
      {
        id: "event_runtime_01",
        type: "session.status_running",
        processed_at: "2026-08-26T02:00:00.000Z",
      },
      {
        id: "event_runtime_02",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
        processed_at: "2026-08-26T02:00:00.001Z",
      },
      {
        id: "event_runtime_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T02:00:00.002Z",
      },
    ]);
    expect(lifecycle).toEqual(["run", "dispose", "synchronize", "idle", "afterExecution", "publicationReported"]);
  });

  async function failingHarnessTurn(run: (context: { runtime: { broadcast(event: unknown): void } }) => Promise<void>) {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let nextId = 0;
    let runs = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async (context) => { runs += 1; await run(context as never); } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
      ids: { nextEventId: () => `event_error_0${++nextId}` },
      harnessRetry: { attempts: 3, delayMs: () => 0 },
    } as never);
    await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
    const output: Array<Record<string, unknown>> = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_02", type: "user.message",
      content: [{ type: "text", text: "Retry" }], processedAt: "2026-08-26T02:30:00.000Z",
    };
    const result = await runner.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [],
      events: [event], historyEvents: [event],
      output: async (frame) => { output.push(frame as Record<string, unknown>); },
    }).then(() => undefined, (error: unknown) => error);
    const summary = output.map((frame) => frame.type === "session.error"
      ? `error:${(frame.error as { retry_status: string }).retry_status}`
      : frame.type === "session.status_idle"
        ? `idle:${(frame.stop_reason as { type: string }).type}`
        : String(frame.type));
    return { result, runs, summary };
  }

  it("reports a failed turn as exhausted without retry once the agent produced side effects", async () => {
    const { result, runs, summary } = await failingHarnessTurn(async ({ runtime }) => {
      runtime.broadcast({ type: "agent.tool_use", id: "tool_01", name: "bash", input: { command: "touch x" } });
      throw new Error("model unavailable");
    });
    expect((result as Error).message).toBe("model unavailable");
    expect(runs).toBe(1);
    expect(summary).toEqual(["session.status_running", "agent.tool_use", "error:exhausted", "idle:retries_exhausted"]);
  });

  it("retries a harness failure in place while the turn has no agent side effects", async () => {
    let failures = 2;
    const { result, runs, summary } = await failingHarnessTurn(async () => {
      if (failures-- > 0) throw new Error("No output generated. Check the stream for errors.");
    });
    expect(result).toBeUndefined();
    expect(runs).toBe(3);
    expect(summary).toEqual([
      "session.status_running",
      "error:retrying", "session.status_rescheduled",
      "error:retrying", "session.status_rescheduled",
      "idle:end_turn",
    ]);
  });

  it("reports exhausted after the side-effect-free retries run out", async () => {
    const { result, runs, summary } = await failingHarnessTurn(async () => { throw new Error("model unavailable"); });
    expect((result as Error).message).toBe("model unavailable");
    expect(runs).toBe(3);
    expect(summary).toEqual([
      "session.status_running",
      "error:retrying", "session.status_rescheduled",
      "error:retrying", "session.status_rescheduled",
      "error:exhausted", "idle:retries_exhausted",
    ]);
  });

  it("reports a failed fenced final collection as exhausted and goes idle", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      synchronizeSandbox: async () => { throw new Error("final collect failed"); },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:15:00.000Z") },
      ids: { nextEventId: () => `event_collect_failure_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_collect_failure",
      type: "user.message",
      content: [{ type: "text", text: "Collect" }],
      processedAt: "2026-08-26T03:14:00.000Z",
    };

    await expect(runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [event],
      historyEvents: [event],
      executionFence: {
        executionId: "execution_collect_failure",
        workspaceId: "workspace_01",
        sessionId: session.id,
        attemptId: "attempt_collect_failure",
        ownerId: "node_01",
        generation: 1,
        expiresAt: "2026-08-26T03:16:00.000Z",
      },
      output: async (frame) => { output.push(frame); },
    })).rejects.toThrow("final collect failed");

    expect(output).toEqual([
      {
        id: "event_collect_failure_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:15:00.000Z",
      },
      {
        id: "event_collect_failure_02",
        type: "session.error",
        error: {
          type: "unknown_error",
          message: "final collect failed",
          retry_status: "exhausted",
        },
        processed_at: "2026-08-26T03:15:00.001Z",
      },
      {
        id: "event_collect_failure_03",
        type: "session.status_idle",
        stop_reason: { type: "retries_exhausted" },
        processed_at: "2026-08-26T03:15:00.002Z",
      },
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
  ])("resumes one turn for $type", async (result) => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const contexts: Array<{ acceptedEvents: unknown[] }> = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async () => { runs += 1; },
      }),
      buildHarnessContext: async (input) => {
        contexts.push(input);
        return input;
      },
      clock: { now: () => new Date("2026-08-26T03:30:00.000Z") },
      ids: { nextEventId: () => `event_resume_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_result_01",
      ...result,
      content: [{ type: "text", text: "Sunny" }],
      isError: false,
      processedAt: "2026-08-26T03:15:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [event],
      initialEvents: [],
      historyEvents: [
        {
          id: "event_custom_tool_01",
          type: "agent.custom_tool_use",
          name: "weather",
          input: { city: "Shanghai" },
          processedAt: "2026-08-26T03:00:00.000Z",
        },
        event,
      ],
      output: async (frame) => { output.push(frame); },
    });

    expect(runs).toBe(1);
    expect(contexts).toEqual([
      expect.objectContaining({ acceptedEvents: [event] }),
    ]);
    expect(output).toEqual([
      {
        id: "event_resume_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:30:00.000Z",
      },
      {
        id: "event_resume_02",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:30:00.001Z",
      },
    ]);
  });

  it.each([
    {
      result: "allow" as const,
      expectedContent: [{ type: "text" as const, text: "command completed" }],
      expectedIsError: false,
      expectedExecutions: 1,
    },
    {
      result: "deny" as const,
      denyMessage: "Do not run destructive commands",
      expectedContent: [{
        type: "text" as const,
        text: "Denied: Do not run destructive commands",
      }],
      expectedIsError: true,
      expectedExecutions: 0,
    },
  ])("handles a $result tool confirmation before resuming", async (verdict) => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    const executions: object[] = [];
    let runs = 0;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: {
        execute: async (input) => {
          executions.push(input);
          return {
            content: [{ type: "text", text: "command completed" }],
            isError: false,
          };
        },
      },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => { runs += 1; } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:45:00.000Z") },
      ids: { nextEventId: () => `event_confirmation_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const toolUse: Extract<
      SessionEventView,
      { type: "agent.tool_use" }
    > = {
      id: "event_tool_use_01",
      type: "agent.tool_use",
      name: "bash",
      input: { command: "pwd" },
      evaluatedPermission: "ask",
      processedAt: "2026-08-26T03:35:00.000Z",
    };
    const confirmation: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_confirmation_01",
      type: "user.tool_confirmation",
      result: verdict.result,
      toolUseId: toolUse.id,
      ...(verdict.denyMessage !== undefined && {
        denyMessage: verdict.denyMessage,
      }),
      processedAt: "2026-08-26T03:40:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [confirmation],
      initialEvents: [],
      historyEvents: [toolUse, confirmation],
      output: async (frame) => { output.push(frame); },
    });

    expect(executions).toHaveLength(verdict.expectedExecutions);
    if (verdict.result === "allow") {
      expect(executions[0]).toEqual({
        workspaceId: "workspace_01",
        session,
        environment,
        sandbox,
        confirmation,
        toolUse,
        abortSignal: expect.any(AbortSignal),
      });
    }
    expect(runs).toBe(1);
    expect(output).toEqual([
      {
        id: "event_confirmation_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:45:00.000Z",
      },
      {
        id: "event_confirmation_02",
        type: "agent.tool_result",
        tool_use_id: toolUse.id,
        content: verdict.expectedContent,
        is_error: verdict.expectedIsError,
        processed_at: "2026-08-26T03:45:00.001Z",
      },
      {
        id: "event_confirmation_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:45:00.002Z",
      },
    ]);
  });

  it("runs and evaluates a defined outcome through official spans", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const evaluations: object[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: {
        evaluate: async (input) => {
          evaluations.push(input);
          return {
            result: "satisfied",
            explanation: "All contract checks pass",
            usage: {
              cacheCreationInputTokens: 1,
              cacheReadInputTokens: 2,
              inputTokens: 30,
              outputTokens: 4,
            },
          };
        },
      },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => { runs += 1; } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T05:30:00.000Z") },
      ids: { nextEventId: () => `event_outcome_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_01",
      type: "user.define_outcome",
      description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" },
      maxIterations: 3,
      outcomeId: "outc_01",
      processedAt: "2026-08-26T05:00:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [outcome],
      initialEvents: [],
      historyEvents: [outcome],
      output: async (frame) => { output.push(frame); },
    });

    expect(runs).toBe(1);
    expect(evaluations).toEqual([{
      workspaceId: "workspace_01",
      session,
      environment,
      outcome,
      historyEvents: [
        outcome,
        {
          id: "event_outcome_01",
          type: "session.status_running",
          processedAt: "2026-08-26T05:30:00.000Z",
        },
      ],
      iteration: 0,
      abortSignal: expect.any(AbortSignal),
    }]);
    expect(output).toEqual([
      {
        id: "event_outcome_01",
        type: "session.status_running",
        processed_at: "2026-08-26T05:30:00.000Z",
      },
      {
        id: "event_outcome_02",
        type: "span.outcome_evaluation_start",
        iteration: 0,
        outcome_id: "outc_01",
        processed_at: "2026-08-26T05:30:00.001Z",
      },
      {
        id: "event_outcome_03",
        type: "span.outcome_evaluation_ongoing",
        iteration: 0,
        outcome_id: "outc_01",
        processed_at: "2026-08-26T05:30:00.002Z",
      },
      {
        id: "event_outcome_04",
        type: "span.outcome_evaluation_end",
        explanation: "All contract checks pass",
        iteration: 0,
        outcome_evaluation_start_id: "event_outcome_02",
        outcome_id: "outc_01",
        result: "satisfied",
        usage: {
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
          input_tokens: 30,
          output_tokens: 4,
        },
        processed_at: "2026-08-26T05:30:00.003Z",
      },
      {
        id: "event_outcome_05",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T05:30:00.004Z",
      },
    ]);
  });

  it("revises an outcome until max_iterations_reached", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const iterations: number[] = [];
    const contexts: unknown[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: {
        evaluate: async (input) => {
          iterations.push(input.iteration);
          return {
            result: "needs_revision",
            explanation: `revision ${input.iteration} required`,
            usage: {
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              inputTokens: 1,
              outputTokens: 1,
            },
          };
        },
      },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          runs += 1;
          contexts.push(context);
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T06:00:00.000Z") },
      ids: { nextEventId: () => `event_revision_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_02",
      type: "user.define_outcome",
      description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" },
      maxIterations: 2,
      outcomeId: "outc_02",
      processedAt: "2026-08-26T05:45:00.000Z",
    };
    const output: Array<{ type?: string; result?: string }> = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [outcome],
      initialEvents: [],
      historyEvents: [outcome],
      output: async (frame) => {
        output.push(frame as { type?: string; result?: string });
      },
    });

    expect(runs).toBe(2);
    expect(iterations).toEqual([0, 1]);
    expect(output
      .filter((event) => event.type === "span.outcome_evaluation_end")
      .map((event) => event.result)).toEqual([
        "needs_revision",
        "max_iterations_reached",
      ]);
    const revisionContext = contexts[1] as {
      runtime: { history: { getMessages(): Array<{ role: string; content: unknown }> } };
    };
    expect(revisionContext.runtime.history.getMessages().at(-1)).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: [
          '<outcome_feedback iteration="0">',
          "revision 0 required",
          "",
          "Address the feedback and try again.",
          "</outcome_feedback>",
        ].join("\n"),
      }],
    });
  });

  it("interrupts the active turn without starting another harness run", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let aborted = false;
    let runs = 0;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          runs += 1;
          const signal = (context as {
            runtime: { abortSignal?: AbortSignal };
          }).runtime.abortSignal;
          markStarted?.();
          if (signal === undefined) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }, { once: true });
          });
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => `event_interrupt_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_03",
      type: "user.message",
      content: [{ type: "text", text: "Long task" }],
      processedAt: "2026-08-26T03:30:00.000Z",
    };
    const turn = runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [message],
      historyEvents: [message],
      output: async (frame) => { output.push(frame); },
    });
    await started;
    const interrupt: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_interrupt_input_01",
      type: "user.interrupt",
      processedAt: "2026-08-26T03:31:00.000Z",
    };

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [interrupt],
      historyEvents: [message, interrupt],
      output: async (frame) => { output.push(frame); },
    });
    await turn;

    expect(runs).toBe(1);
    expect(aborted).toBe(true);
    expect(output).toEqual([
      {
        id: "event_interrupt_01",
        type: "session.status_running",
        processed_at: "2026-08-26T04:00:00.000Z",
      },
      {
        id: "event_interrupt_02",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T04:00:00.001Z",
      },
    ]);
  });

  it("does not report a failed turn when the execution lease was lost (another owner takes over)", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          const signal = (context as { runtime: { abortSignal?: AbortSignal } }).runtime.abortSignal!;
          markStarted?.();
          // A model request rejects when its signal aborts.
          await new Promise<void>((_, reject) => signal.addEventListener("abort",
            () => reject(new Error("This operation was aborted")), { once: true }));
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => `event_lease_0${++nextId}` },
    });
    await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
    const output: Array<{ type: string }> = [];
    const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_lease", type: "user.message",
      content: [{ type: "text", text: "Long task" }], processedAt: "2026-08-26T03:30:00.000Z",
    };
    const turn = runner.accept({ workspaceId: "workspace_01", sessionId: session.id, session, environment,
      initialEvents: [], events: [message], historyEvents: [message],
      output: async (frame) => { output.push(frame as { type: string }); } });
    await started;
    runner.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "lease_lost" });
    await expect(turn).rejects.toThrow("aborted");
    expect(output.map((frame) => frame.type)).toEqual(["session.status_running"]);
  });

  it("owns and destroys sandboxes by workspace and session scope", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const built: string[] = [];
    const destroyed: string[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async ({ workspaceId }) => {
        built.push(workspaceId);
        return {
          destroy: async () => { destroyed.push(workspaceId); },
        } as SandboxExecutor;
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_scope" },
    });
    const start = (workspaceId: string) => runner.start({
      workspaceId,
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await start("workspace_a");
    await start("workspace_b");
    expect(built).toEqual(["workspace_a", "workspace_b"]);

    await runner.stop({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    expect(destroyed).toEqual(["workspace_a"]);
    await runner.stop({
      workspaceId: "workspace_b",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    expect(destroyed).toEqual(["workspace_a", "workspace_b"]);
  });

  it("aborts sandbox acquisition when startup is cancelled and destroys a late sandbox", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishCreate: ((sandbox: SandboxExecutor) => void) | undefined;
    let destroyed = false;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: () => {
        markStarted?.();
        return new Promise<SandboxExecutor>((resolve) => { finishCreate = resolve; });
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_cancel_start" },
    });
    const controller = new AbortController();
    const pending = runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      signal: controller.signal,
    });
    await started;
    const startedAt = Date.now();
    controller.abort(Object.assign(new Error("interrupt_requested"), { name: "AbortError" }));
    await expect(pending).rejects.toThrow("interrupt_requested");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    finishCreate?.({
      destroy: async () => { destroyed = true; },
    } as SandboxExecutor);
    await vi.waitFor(() => { expect(destroyed).toBe(true); });
  });

  it("cancels an in-flight sandbox acquisition through runner.cancel", async () => {
    const modulePath = new URL("../../../packages/control-plane-node/src/lib/node-managed-session-runner.ts", import.meta.url).href;
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: ({ signal }) => {
        markStarted?.();
        return new Promise<SandboxExecutor>((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("session_stopped"), { name: "AbortError" }));
          if (signal?.aborted) { fail(); return; }
          signal?.addEventListener("abort", fail, { once: true });
        });
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_cancel_runner" },
    });
    const pending = runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await started;
    runner.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "session_stopped" });
    await expect(pending).rejects.toThrow("session_stopped");
  });
});
