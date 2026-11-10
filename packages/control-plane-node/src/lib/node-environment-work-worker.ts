import { createDispatchedManagedEnvironmentWorker, type ManagedEnvironmentWorker } from "@open-managed-agents/managed-runtime-host";
import type { SandboxManagedProcessHandle } from "@open-managed-agents/sandbox";
import { toEnvironmentWorkResponse } from "@open-managed-agents/managed-agents-api";
import type { EnvironmentWorkApplicationPort } from "@open-managed-agents/managed-agents-application";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { sessionExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import { parseInstalledHarnesses } from "@open-managed-agents/acp-runtime/installed-harnesses";
import { parseAcpRegistryRef } from "@open-managed-agents/acp-runtime/registry-pins";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";
import { environmentWorkSandboxTokenRef } from "@open-managed-agents/sandbox-gateway-sql";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { NodeConfig } from "../config.js";
import type { NodeSessionSandboxes } from "./node-session-sandbox.js";
import type { createNodeManagedAcpCapabilities } from "./node-managed-acp-capability.js";

/** Node installs the existing unacknowledged-Work dispatcher. SQL discovers
 * environments only; the application's atomic claim remains the sole scheduler
 * authority. Native launch owns no heartbeat and never ACKs on the host. */
export function createNodeEnvironmentWorkWorker(input: {
  sql: SqlClient;
  config: NodeConfig;
  work: EnvironmentWorkStore;
  application(workspaceId: string): EnvironmentWorkApplicationPort;
  sandboxes: NodeSessionSandboxes;
  capabilities: ReturnType<typeof createNodeManagedAcpCapabilities>;
  onError(): void;
}) {
  const env = input.config.sandbox.environment;
  const command = env.OPENMA_WORK_RUNNER_COMMAND;
  const inventory = parseInstalledHarnesses(env.OPENMA_ACP_HARNESSES);
  const args: unknown = JSON.parse(env.OPENMA_WORK_RUNNER_ARGS ?? "[]");
  if (!Array.isArray(args) || args.some(a => typeof a !== "string" || a.includes("\0"))) throw new TypeError("OPENMA_WORK_RUNNER_ARGS must be string argv");
  if (command !== undefined && (!command.startsWith("/") || command.includes("\0"))) throw new TypeError("OPENMA_WORK_RUNNER_COMMAND must be absolute and non-NUL");
  if (env.SANDBOX_PROVIDER === "e2b" && command !== undefined && (
    command !== "/usr/local/bin/node" || args.length !== 1 || args[0] !== "/opt/oma-managed/worker/node-e2b-work-item-cli.js"
  )) throw new TypeError("A trusted E2B worker requires the fixed preinstalled command and argv");
  const origin = input.config.http.publicBaseUrl;
  const controller = new AbortController();
  const workers = new Map<string, { worker: ManagedEnvironmentWorker; completed: Promise<void> }>();
  // Management handles only, never ownership/lease state. SQL remains authority.
  const processes = new Map<string, { handle: SandboxManagedProcessHandle; current(): Promise<boolean> }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let draining: Promise<void> | undefined;
  let started = false;
  const sessions = new SqlSessionSource(input.sql);
  const environments = new SqlSessionEnvironmentSource(input.sql);

  const tick = () => draining ??= (async () => {
    if (controller.signal.aborted || command === undefined || origin === undefined) return;
    for (const [key, process] of processes) {
      if (await process.current()) continue;
      await process.handle.kill("SIGTERM");
      processes.delete(key);
    }
    const rows = await input.sql.prepare(
      "SELECT DISTINCT workspace_id, environment_id FROM managed_environment_work WHERE state IN ('queued', 'starting', 'active')"
    ).all<{ workspace_id: string; environment_id: string }>();
    for (const row of rows.results ?? []) {
      controller.signal.throwIfAborted();
      const scope = { workspaceId: row.workspace_id, environmentId: row.environment_id };
      const environment = await environments.find(scope);
      // Self-hosted environments keep their external worker; no local takeover.
      if (!environment || environment.archivedAt !== null || environment.config.type !== "cloud") continue;
      const key = JSON.stringify([scope.workspaceId, scope.environmentId]);
      if (!workers.has(key)) {
        const app = input.application(scope.workspaceId);
        const worker = createDispatchedManagedEnvironmentWorker({
          workspaceId: scope.workspaceId, environmentId: scope.environmentId,
          environmentKey: "internal-application-port", workerId: input.config.execution.ownerId,
          maxWorkItemsPerDrain: 8, fallbackPollIntervalMs: 1_000,
          client: {
            baseURL: origin,
            beta: { webhooks: { unwrap() { throw new Error("Node uses durable poll discovery"); } } },
            withOptions: () => ({ beta: { environments: { work: {
              poll: async (environmentId, query) => {
                const result = await app.pollEnvironmentWork({ environmentId, blockMilliseconds: 0, workerId: query["Anthropic-Worker-ID"], reclaimOlderThanMilliseconds: query.reclaim_older_than_ms });
                return result.type === "work" ? toEnvironmentWorkResponse(result.work) : null;
              },
              stop: async (workId, query) => app.stopEnvironmentWork({ workId, environmentId: query.environment_id, force: query.force }),
            } } } }),
          },
          onError: () => input.onError(),
          dispatch: {
            descriptor: () => ({ provider: "node", version: "1", strategy: "poll_unacked_then_dispatch" }),
            async dispatch({ work, signal }) {
              const delivery = { ...scope, workId: work.id, sessionId: work.data.id };
              const capability = managedMcpProxyFromWorkEnvironment({ ANTHROPIC_BASE_URL: origin, ANTHROPIC_WORK_SECRET: work.secret ?? undefined });
              const stored = await input.work.find(delivery);
              if (!capability || !stored?.claim || stored.work.environmentId !== scope.environmentId || stored.secret.sessionsToken !== capability.sessionsToken || capability.gatewayBaseUrl !== origin) throw new Error("Work delivery rejected");
              const generation = stored.claim.generation;
              const current = async () => {
                const row = await input.work.find(delivery);
                return !signal.aborted && row?.claim?.generation === generation && row.secret.sessionsToken === capability.sessionsToken
                  && row.work.data.type === "session" && row.work.data.id === delivery.sessionId
                  && ["queued", "starting", "active"].includes(row.work.state)
                  && Date.parse(row.claim.claimedAt) + row.heartbeatTtlSeconds * 1000 > Date.now();
              };
              const session = await sessions.find(delivery);
              const pinnedEnvironment = await environments.find(scope);
              if (!await current() || !session || session.archivedAt !== null || session.environmentId !== scope.environmentId || !pinnedEnvironment || pinnedEnvironment.archivedAt !== null) throw new Error("Work Session unavailable");
              const selection = sessionExecutionPlacement(pinnedEnvironment, session);
              if (selection.authority !== "environment_work" || selection.harnessPlacement !== "in_sandbox") throw new Error("Work placement rejected");
              const pin = session.agent.openma?.acp?.agent;
              const installed = inventory?.find(entry => entry.id === pin?.id && entry.command === pin?.command && JSON.stringify(entry.args ?? []) === JSON.stringify(pin?.args ?? []));
              const harness = pin?.registry ? parseAcpRegistryRef(pin.registry) : installed;
              if (!harness) throw new Error("Pinned harness is not installed");
              const claim = { ...delivery, generation };
              const sandbox = input.sandboxes.build({ workspaceId: scope.workspaceId, session, environment: pinnedEnvironment,
                workAuthority: { attempt: environmentWorkSandboxTokenRef(claim), isCurrent: current, token: physical => input.capabilities.issueWork(claim, session.agent.openma?.harness, physical) },
              });
              await sandbox.open();
              if (!await current()) throw new Error("Work claim lost before bootstrap");
              const token = await sandbox.workToken();
              const handle = await sandbox.startManagedProcess({ command, args: args as string[], env: {
                ANTHROPIC_BASE_URL: origin, ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
                ANTHROPIC_SESSION_ID: session.id, ANTHROPIC_WORK_ID: work.id, ANTHROPIC_WORK_SECRET: work.secret!,
                OPENMA_WORKSPACE_ID: scope.workspaceId, OPENMA_SANDBOX_TOKEN: token,
                OPENMA_HARNESS_ID: harness.id, OPENMA_HARNESS_VERSION: harness.version,
                ...(inventory === null ? {} : { OPENMA_ACP_HARNESSES: JSON.stringify(inventory) }),
              } });
              processes.set(JSON.stringify([scope.workspaceId, work.id, generation]), { handle, current });
            },
          },
        });
        const completed = worker.run(controller.signal).catch(() => {
          if (!controller.signal.aborted) input.onError();
        }).finally(() => { workers.delete(key); });
        workers.set(key, { worker, completed });
        await worker.drain(controller.signal);
      }
    }
  })().catch(() => { if (!controller.signal.aborted) input.onError(); }).finally(() => { draining = undefined; });
  return {
    async start() {
      if (started) return;
      started = true;
      if (command === undefined) return;
      if (!origin) throw new Error("PUBLIC_BASE_URL is required for Work runner bootstrap");
      await tick();
      if (controller.signal.aborted) return;
      timer = setInterval(() => { void tick(); }, 1_000);
      timer.unref?.();
    },
    async stop() {
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
      await draining;
      await Promise.all([...workers.values()].map(worker => worker.completed));
      workers.clear();
      await Promise.all([...processes.values()].map(process => process.handle.kill("SIGTERM")));
      processes.clear();
    },
  };
}
