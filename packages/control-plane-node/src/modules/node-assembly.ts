/** Ownership and lifecycle of a composed Node control plane. */
import { Hono } from "hono";
import type { ApiKeyResolution } from "@open-managed-agents/auth";
import type { Logger } from "@open-managed-agents/observability";
import type { NodeComponents } from "../components.js";
import type { NodeProcessMode } from "../config.js";
import { setDbBoundaryLogger } from "@open-managed-agents/sql-client";
import { Disposables } from "../lifecycle.js";
import { installDbUnhandledRejectionNet } from "../lib/db-unhandled-rejection.js";
import { buildNodeScheduler } from "../lib/node-scheduler-jobs.js";
import { createNodeRuntime } from "./node-runtime.js";
import { mountNodeHttp } from "./node-http.js";

export type { NodeEnvironment } from "../config.js";

/** A fully assembled Node control plane. Nothing listens or polls until start(). */
export type NodeControlPlaneApp = Hono<{
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
  };
}>;

export interface NodeControlPlane {
  /** Hono application: mount it, or serve it with @hono/node-server. */
  readonly app: NodeControlPlaneApp;
  readonly processMode: NodeProcessMode;
  /** Human-readable database backend, e.g. "mysql host:3306/oma". */
  readonly backendDescription: string;
  /** What this control plane was assembled from. */
  readonly components: NodeComponents;
  readonly logger: Logger;
  fetch(request: Request): Response | Promise<Response>;
  /** Start background work owned by a standalone process (execution poller, scheduler). */
  start(): Promise<void>;
  /** Stop everything this control plane created. Idempotent. */
  stop(signal?: string): Promise<void>;
}

/**
 * Assemble the Node control plane from explicit components. Every store,
 * worker and route is created here and owned by the returned handle — the
 * components too, which are stopped with it — so two control planes can
 * coexist in one process (tests, embedding) and the entrypoint decides when
 * to listen and how to handle signals.
 */
export async function assembleNodeControlPlane(
  components: NodeComponents,
): Promise<NodeControlPlane> {
  const log: { current: Logger | null } = { current: null };
  const disposables = new Disposables({
    onError: (name, err) => {
      const message = `${name} stop failed`;
      if (log.current) log.current.warn({ err, op: `main-node.shutdown.${name}_stop_failed` }, message);
      else console.warn(`[main-node] ${message}`, err);
    },
  });
  return disposables.guard(() => buildNodeControlPlane(components, disposables, log));
}

async function buildNodeControlPlane(
  components: NodeComponents,
  disposables: Disposables,
  log: { current: Logger | null },
): Promise<NodeControlPlane> {
  const runtime = await createNodeRuntime(components, disposables, log);
  const {
    config, processMode, logger, metrics, backendDescription, platformRootSecret, sql,
    agentStore, environmentsService, sessionsService, evalsService, kv,
    memoryService, managedSessionExecutionWorker, sharedSessionOutputs,
  } = runtime;
  setDbBoundaryLogger((record) => {
    const level = record.outcome === "error" ? "error" : record.retryCount > 0 ? "warn" : "info";
    logger[level]({ ...record, op: record.op }, "db boundary");
  });

  const app = await mountNodeHttp(runtime, disposables);

  // Cron — eval-tick + memory retention sweep + (when integrations schema is
  // applied) webhook-events retention. Linear dispatch is left un-wired here
  // because main-node doesn't construct a LinearProvider; pass `linearSweeper`
  // when an in-process gateway lands.
  const scheduler = buildNodeScheduler({
    evalServices: {
      agents: agentStore,
      environments: environmentsService,
      sessions: sessionsService,
      evals: evalsService,
      kv,
    },
    memory: memoryService,
    integrationsSql: platformRootSecret ? sql : null,
    sessionOutputGarbageCollection: sharedSessionOutputs
      ? () => sharedSessionOutputs.collectGarbage() : null,
    cron: config.cron,
  });
  disposables.add("scheduler", () => scheduler.stop());
  // Registered last so it stops first: it drives the Session compositions above.
  disposables.add("managed_session_execution_worker", () => managedSessionExecutionWorker.stop());

  const shutdownNodeApp = async (signal = "dispose") => {
    logger.info({ op: "main-node.shutdown", signal }, `received ${signal}, shutting down`);
    await disposables.dispose();
  };

  let started = false;
  let removeRejectionNet: (() => void) | null = null;
  return {
    app,
    processMode,
    backendDescription,
    logger,
    fetch: (request) => app.fetch(request),
    async start() {
      if (started) return;
      started = true;
      // Vitest sets NODE_ENV=test. Installing the handler there would mark
      // every later rejection handled. Production standalone still installs it.
      if (processMode === "standalone" && process.env.NODE_ENV !== "test") {
        removeRejectionNet = installDbUnhandledRejectionNet({ logger, metrics });
      }
      // Start the execution poller only after every runtime dependency above
      // (Managed Memory/Skill applications included) has initialized.
      managedSessionExecutionWorker.start();
      await scheduler.start();
      logger.info({ op: "main-node.scheduler.started" }, "scheduler started");
    },
    components,
    stop: async (signal) => {
      removeRejectionNet?.();
      removeRejectionNet = null;
      await shutdownNodeApp(signal);
    },
  };
}
