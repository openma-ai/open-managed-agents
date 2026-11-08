// Node wiring for OMA evals: the managed-Session runtime port, the benchmark
// store and the Files API reader, shared by /v1/oma/evals and the scheduler.

import {
  createManagedEvalRuntime,
  EvalBenchmarkStore,
  EvalRuntimeError,
  type EvalSessionRuntime,
} from "@open-managed-agents/evals-runner";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import { EMPTY_SANDBOX_IMAGE_CATALOG, isNoEnvironmentSandbox } from "@open-managed-agents/sandbox";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import type { NodeRuntime } from "../modules/node-runtime.js";
import { execManagedSandbox } from "./managed-sandbox-exec.js";

export interface NodeEvalDeps {
  runtimeFor(tenantId: string): EvalSessionRuntime;
  benchmarksFor(tenantId: string): EvalBenchmarkStore;
  readUpload(tenantId: string, fileId: string): Promise<{ bytes: Uint8Array; filename?: string } | null>;
}

const cache = new WeakMap<object, NodeEvalDeps>();

export function nodeEvalDeps(runtime: NodeRuntime): NodeEvalDeps {
  const cached = cache.get(runtime);
  if (cached) return cached;
  const { config, managedPlatform, managedSessionsComposition, managedRuntimeRunner, drizzleDb } = runtime;
  const images = (config.sandbox.images ?? EMPTY_SANDBOX_IMAGE_CATALOG).entries;
  const checkpoints = config.workspace.strategy === "checkpoint_restore";
  const runtimes = new Map<string, EvalSessionRuntime>();

  const runtimeFor = (workspaceId: string): EvalSessionRuntime => {
    let existing = runtimes.get(workspaceId);
    if (existing) return existing;
    const app = managedPlatform.app({ workspaceId });
    const ports = managedSessionsComposition.portsFor(workspaceId);
    const environments = app.port(managedAgentsPortTokens.environments);
    const connected = (sessionId: string) => {
      const sandbox = managedRuntimeRunner.connectedSandbox({ workspaceId, sessionId });
      return sandbox === null || isNoEnvironmentSandbox(sandbox) ? null : sandbox;
    };
    const loadSession = async (sessionId: string) => {
      const found = await ports.sessions.retrieveSession({ sessionId });
      if (found.type !== "found") throw new EvalRuntimeError(`Session ${sessionId} not found`);
      return found.session;
    };
    existing = createManagedEvalRuntime({
      agents: app.port(managedAgentsPortTokens.agents),
      environments,
      sessions: ports.sessions,
      sessionEvents: ports.sessionEvents,
      images,
      async exec(sessionId, command, timeoutMs) {
        const sandbox = connected(sessionId);
        // The runner keeps sandboxes in process memory: a restart loses them.
        if (sandbox === null) throw new EvalRuntimeError(`Session ${sessionId} has no connected sandbox (was the control plane restarted?)`);
        return execManagedSandbox(sandbox, command, timeoutMs);
      },
      async ensureSandbox(sessionId) {
        if (connected(sessionId) !== null) return true;
        if (checkpoints) {
          throw new EvalRuntimeError("Starting a sandbox without a turn is not supported with WORKSPACE_STRATEGY=checkpoint_restore (oracle mode, setup files)");
        }
        const session = await loadSession(sessionId);
        const environment = await environments.retrieveEnvironment({ environmentId: session.environmentId });
        if (environment.type !== "found") throw new EvalRuntimeError(`Environment ${session.environmentId} not found`);
        await managedRuntimeRunner.start({
          workspaceId,
          sessionId,
          session: session as never,
          environment: environment.environment as never,
          initialEvents: [],
        });
        return connected(sessionId) !== null;
      },
      async releaseSandbox(sessionId) {
        if (connected(sessionId) === null) return;
        const session = await loadSession(sessionId);
        await managedRuntimeRunner.stop({ workspaceId, sessionId, session: session as never, reason: "archived" });
      },
    });
    runtimes.set(workspaceId, existing);
    return existing;
  };

  const deps: NodeEvalDeps = {
    runtimeFor,
    benchmarksFor: (tenantId) => new EvalBenchmarkStore(new SqlKvStore({ db: drizzleDb, tenantId }), tenantId),
    async readUpload(tenantId, fileId) {
      const files = managedPlatform.app({ workspaceId: tenantId }).port(managedAgentsPortTokens.files);
      const found = await files.downloadFile({ fileId });
      if (found.type !== "found") return null;
      return { bytes: found.file.content, ...(found.file.filename ? { filename: found.file.filename } : {}) };
    },
  };
  cache.set(runtime, deps);
  return deps;
}
