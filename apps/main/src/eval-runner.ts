// CF entry shim for OMA evals: builds the EvalRunnerContext from the worker
// `env` and forwards to @open-managed-agents/evals-runner.
//
// The managed-Session ports are composed in apps/main/src/index.ts (they
// share its per-request factories). index.ts registers a factory here at
// module load so this file, the cron and routes/evals.ts can use it without
// importing index.ts (which imports them: a cycle).

import type { Env } from "@open-managed-agents/shared";
import {
  forEachShardServices,
  getCfServicesForTenant,
  type Services,
} from "@open-managed-agents/services";
import {
  tickEvalRuns as tickRunsImpl,
  type EvalBenchmarkStore,
  type EvalRunnerContext,
  type EvalSessionRuntime,
} from "@open-managed-agents/evals-runner";

export interface CfEvalDeps {
  runtime: EvalSessionRuntime;
  benchmarks: EvalBenchmarkStore;
  readUpload(fileId: string): Promise<{ bytes: Uint8Array; filename?: string } | null>;
}

/** The request being served, when there is one (a cron tick has none). */
export interface CfEvalRequestScope {
  origin: string;
  waitUntil(task: Promise<unknown>): void;
}

type CfEvalDepsFactory = (env: Env, tenantId: string, request?: CfEvalRequestScope) => Promise<CfEvalDeps>;

let factory: CfEvalDepsFactory | null = null;

export function registerCfEvalDeps(build: CfEvalDepsFactory): void {
  factory = build;
}

export function cfEvalDeps(env: Env, tenantId: string, request?: CfEvalRequestScope): Promise<CfEvalDeps> {
  if (factory === null) throw new Error("CF eval dependencies are not registered (apps/main/src/index.ts)");
  return factory(env, tenantId, request);
}

export function buildCfEvalRunnerContext(env: Env): EvalRunnerContext {
  const services = new Map<string, Promise<Services>>();
  const deps = new Map<string, Promise<CfEvalDeps>>();
  const servicesFor = (tenantId: string) => {
    let pending = services.get(tenantId);
    if (!pending) { pending = getCfServicesForTenant(env, tenantId); services.set(tenantId, pending); }
    return pending;
  };
  const depsFor = (tenantId: string) => {
    let pending = deps.get(tenantId);
    if (!pending) { pending = cfEvalDeps(env, tenantId); deps.set(tenantId, pending); }
    return pending;
  };
  return {
    forEachShard: (fn) => forEachShardServices(env, (s) => fn(s)),
    getServicesForTenant: (tenantId) => servicesFor(tenantId),
    runtimeFor: async (tenantId) => (await depsFor(tenantId)).runtime,
    benchmarksFor: async (tenantId) => (await depsFor(tenantId)).benchmarks,
  };
}

/** Kept for test/integration/evals-route.test.ts, which imports this path. */
export async function tickEvalRuns(env: Env): Promise<{ advanced: number; total: number }> {
  return tickRunsImpl(buildCfEvalRunnerContext(env));
}
