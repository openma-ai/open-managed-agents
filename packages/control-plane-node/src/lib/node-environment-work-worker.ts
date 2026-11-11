import { observeWorkOperation, type WorkOperationObservation } from "./work-operation-observation.js";
import { createDispatchedManagedEnvironmentWorker, type ManagedEnvironmentWorker } from "@open-managed-agents/managed-runtime-host";
import type { SandboxManagedProcessHandle } from "@open-managed-agents/sandbox";
import { toPolledEnvironmentWorkResponse } from "@open-managed-agents/managed-agents-api";
import type { EnvironmentWorkApplicationPort } from "@open-managed-agents/managed-agents-application";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { sessionExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import { parseInstalledHarnesses } from "@open-managed-agents/acp-runtime/installed-harnesses";
import { parseAcpRegistryRef } from "@open-managed-agents/acp-runtime/registry-pins";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";
import { environmentWorkSandboxTokenRef } from "@open-managed-agents/sandbox-gateway-sql";
import { sandboxTokenSha256 } from "@open-managed-agents/sandbox-gateway";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { NodeConfig } from "../config.js";
import type { NodeSessionSandboxes } from "./node-session-sandbox.js";
import type { createNodeManagedAcpCapabilities } from "./node-managed-acp-capability.js";

/** Bounds one dispatch from reservation to the sandbox worker's ACK. It is
 * also the retry delay after a failed dispatch (the dispatcher never ACKs or
 * stops on failure), and must stay below the 90s Work heartbeat TTL. */
export const WORK_RESERVATION_RECLAIM_MS = 60_000;
const WORK_HEARTBEAT_TTL_MS = 90_000;
function reservationReclaimMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return WORK_RESERVATION_RECLAIM_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms >= WORK_HEARTBEAT_TTL_MS) {
    throw new TypeError("OPENMA_WORK_RESERVATION_RECLAIM_MS must be a positive integer below the 90000ms Work heartbeat TTL");
  }
  return ms;
}

/** Node installs the existing unacknowledged-Work dispatcher. SQL discovers
 * environments only; the application's atomic claim remains the sole scheduler
 * authority. Native launch owns no heartbeat and never ACKs on the host. */
export function createNodeEnvironmentWorkWorker(input: {
  sql: SqlClient;
  config: NodeConfig;
  work: EnvironmentWorkStore;
  application(workspaceId: string): EnvironmentWorkApplicationPort;
  recovery?: { recoverSchedulingPage(input: { limit: number; after?: { workspaceId: string; sessionId: string }; onError(error: unknown): void }): Promise<{ next: { workspaceId: string; sessionId: string } | null }> };
  sandboxes: NodeSessionSandboxes;
  capabilities: ReturnType<typeof createNodeManagedAcpCapabilities>;
  onError(): void;
  observe?(event: WorkOperationObservation): void;
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
  const reclaimOlderThanMs = reservationReclaimMs(env.OPENMA_WORK_RESERVATION_RECLAIM_MS);
  const controller = new AbortController();
  const workers = new Map<string, { worker: ManagedEnvironmentWorker; completed: Promise<void> }>();
  // Management handles only, never ownership/lease state. SQL remains authority.
  type ManagedProcess = { slot: string; handle: SandboxManagedProcessHandle; current(): Promise<boolean>; renew?(): Promise<void>; renewal?: Promise<void>; takeover?: { authorize(): Promise<boolean> }; pending?: { op: string; result: Promise<unknown> } };
  const processes = new Map<string, ManagedProcess>();
  // The Port has no cancellation signal. Bound our wait, NOT the native call:
  // retain an unresolved exact-handle RPC and never start a concurrent duplicate.
  async function processCall<T>(process: ManagedProcess, op: string, action: () => Promise<T>): Promise<T> {
    if (process.pending && process.pending.op !== op) throw new Error("Previous management RPC outcome is pending");
    if (!process.pending) {
      const pending = { op, result: Promise.resolve().then(action) };
      process.pending = pending;
      void pending.result.finally(() => {
        if (process.pending === pending) process.pending = undefined;
      }).catch(() => {});
    }
    const result = process.pending.result as Promise<T>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([result, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Management RPC wait timed out; native outcome is unknown")), 1_000);
      })]);
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  // Provider renewal is independent of exact-process cleanup. A stuck renewal
  // must not block a lost claim's SIGTERM, nor be mistaken for cancellation.
  async function renew(process: ManagedProcess): Promise<void> {
    if (process.renew === undefined) return;
    if (process.renewal === undefined) {
      const pending = Promise.resolve().then(() => process.renew!());
      process.renewal = pending;
      void pending.finally(() => { if (process.renewal === pending) process.renewal = undefined; }).catch(() => {});
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([process.renewal, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Provider renewal wait timed out; native outcome remains pending")), 1_000);
      })]);
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  // Serialize local handle cleanup and registration, not ownership. The sandbox
  // OS lock remains the exclusion boundary across hosts/restarts.
  const handoffs = new Map<string, Promise<void>>();
  async function handoff(slot: string, action: () => Promise<void>) {
    const previous = handoffs.get(slot) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    handoffs.set(slot, next);
    try { await next; } finally { if (handoffs.get(slot) === next) handoffs.delete(slot); }
  }
  async function retire(key: string) {
    const process = processes.get(key);
    if (!process) return;
    // Unknown authority throws: never interpret lookup failure as lost ownership.
    if (await processCall(process, "current", () => process.current())) throw new Error("Previous management worker is still current");
    await processCall(process, "kill", () => process.handle.kill("SIGTERM"));
    for (let attempt = 0; attempt < 5; attempt++) {
      const status = await processCall(process, "status", () => process.handle.getStatus());
      if (["exited", "killed", "completed", "error"].includes(status)) {
        if (processes.get(key) === process) processes.delete(key);
        return;
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Previous management worker exit is unconfirmed");
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let draining: Promise<void> | undefined;
  let started = false;
  const sessions = new SqlSessionSource(input.sql);
  const environments = new SqlSessionEnvironmentSource(input.sql);

  let recoveryAfter: { workspaceId: string; sessionId: string } | undefined;
  let recoverAfterMs = 0;
  const tick = () => draining ??= (async () => {
    if (controller.signal.aborted) return;
    if (input.recovery && Date.now() >= recoverAfterMs) {
      recoverAfterMs = Date.now() + 30_000;
      const page = await input.recovery.recoverSchedulingPage({ limit: 20, after: recoveryAfter, onError: () => input.onError() });
      recoveryAfter = page.next ?? undefined;
    }
    if (command === undefined || origin === undefined) return;
    await Promise.all([...processes].map(([key, process]) => handoff(process.slot, async () => {
      if (processes.get(key) !== process) return;
      if (!await processCall(process, "current", () => process.current())) await retire(key);
      else await renew(process);
    }).catch(() => { if (!controller.signal.aborted) input.onError(); })));
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
          // An unacknowledged reservation must outlive sandbox open + restore +
          // native start + the worker's ACK, or another replica's poll reclaims
          // it mid-launch (the 5s default double-claims multi-replica Node).
          reclaimOlderThanMs,
          client: {
            baseURL: origin,
            beta: { webhooks: { unwrap() { throw new Error("Node uses durable poll discovery"); } } },
            withOptions: () => ({ beta: { environments: { work: {
              poll: async (environmentId, query) => {
                const result = await app.pollEnvironmentWork({ environmentId, blockMilliseconds: 0, workerId: query["Anthropic-Worker-ID"], reclaimOlderThanMilliseconds: query.reclaim_older_than_ms });
                return result.type === "work" ? toPolledEnvironmentWorkResponse(result.work) : null;
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
              const observed = <T>(operation: string, run: () => Promise<T>) => observeWorkOperation(input.observe, { ...delivery, generation }, operation, run);
              let holderHash: string | undefined;
              const current = async (includeStopping = false) => {
                const row = await input.work.find(delivery);
                return !signal.aborted && row?.claim?.generation === generation && row.claim.workerId === stored.claim!.workerId && row.secret.sessionsToken === capability.sessionsToken
                  && row.work.data.type === "session" && row.work.data.id === delivery.sessionId
                  && (includeStopping ? ["queued", "starting", "active", "stopping"] : ["queued", "starting", "active"]).includes(row.work.state)
                  && Date.parse(row.claim.claimedAt) + row.heartbeatTtlSeconds * 1000 > Date.now();
              };
              // Stop-requested is a finalization window only while this exact
              // claim's SQL lease remains valid. Never extend the SQL lease here.
              const owned = async () => {
                if (!await current(true)) return false;
                if (holderHash === undefined) return true; // bootstrap has not issued its holder yet
                // Reuse the existing holder row. Unlike gateway access, provider
                // maintenance also covers the still-leased stopping window.
                const holder = await input.sql.prepare(
                  "SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ? AND claim_generation = ? AND claim_at + heartbeat_ttl_seconds * 1000 > ? AND state IN ('queued', 'starting', 'active', 'stopping')"
                ).bind(scope.workspaceId, scope.environmentId, work.id, delivery.sessionId, generation, Date.now()).first<{ sandbox_token_hashes: string | null }>();
                const hashes: unknown = JSON.parse(holder?.sandbox_token_hashes ?? "[]");
                return Array.isArray(hashes) && hashes.some(entry => entry?.h === holderHash && entry?.s === "all");
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
              const slot = JSON.stringify([scope.workspaceId, delivery.sessionId]);
              await handoff(slot, async () => {
                if (controller.signal.aborted || !await current()) throw new Error("Work claim lost before handoff");
                for (const [key, process] of processes) if (process.slot === slot) {
                  // The exact target/pending RPC stays; a new legitimate claim
                  // supplies fresh cleanup authority instead of inheriting a closure.
                  if (process.takeover) process.takeover.authorize = current;
                  await retire(key);
                }
                const claim = { ...delivery, generation };
                const sandbox = input.sandboxes.build({ workspaceId: scope.workspaceId, session, environment: pinnedEnvironment,
                  workAuthority: { attempt: environmentWorkSandboxTokenRef(claim), isCurrent: owned, holderHash: () => holderHash, token: physical => input.capabilities.issueWork(claim, session.agent.openma?.harness, physical) },
                });
                await observed("sandbox-open", () => sandbox.open());
                if (!await current()) throw new Error("Work claim lost before bootstrap");
                const token = await observed("sandbox-token", () => sandbox.workToken());
                holderHash = (await sandboxTokenSha256(token)) ?? undefined;
                if (holderHash === undefined || !await owned()) throw new Error("Work sandbox holder lost before launch");
                // Strict canonical workspace/native-state restore before any
                // management worker can bootstrap. Exact attaches are never
                // overwritten, and a failed restore never launches a model.
                try {
                  await observed("checkpoint-restore", () => input.sandboxes.restoreWorkCheckpoint(sandbox, environmentWorkSandboxTokenRef(claim)));
                  if (!await owned()) throw new Error("Work claim lost during checkpoint restore");
                } catch (error) {
                  // Never let the next dispatcher attach a partially restored
                  // runtime as though it were a completed initialization.
                  // failExecution already refuses release after authority loss.
                  await sandbox.failExecution();
                  throw error;
                }
                const spec = { command, args: args as string[], env: {
                  ANTHROPIC_BASE_URL: origin, ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
                  ANTHROPIC_SESSION_ID: session.id, ANTHROPIC_WORK_ID: work.id, ANTHROPIC_WORK_SECRET: work.secret!,
                  OPENMA_WORKSPACE_ID: scope.workspaceId, OPENMA_SANDBOX_TOKEN: token,
                  OPENMA_HARNESS_ID: harness.id, OPENMA_HARNESS_VERSION: harness.version,
                  ...(inventory === null ? {} : { OPENMA_ACP_HARNESSES: JSON.stringify(inventory) }),
                } };
                let handle: SandboxManagedProcessHandle;
                try { handle = await observed("native-start", () => sandbox.startManagedProcess(spec)); }
                catch (error) {
                  if ((error as {outcome?: string}).outcome !== "rejected" || (error as Error).message !== "management worker busy") throw error;
                  const recovered = await sandbox.recoverManagedProcessSlot();
                  const identity = recovered.locator.identity;
                  const obsolete = async () => {
                    const old = await input.work.find({...scope, workId: identity.workId});
                    if (!old || old.work.data.type !== "session" || old.work.data.id !== delivery.sessionId || !old.claim) throw new Error("Management identity cannot be verified");
                    const expected = environmentWorkSandboxTokenRef({...scope, sessionId: delivery.sessionId, workId: identity.workId, generation: old.claim.generation});
                    const locatedGeneration = Number(identity.attemptId.split(":").at(-1));
                    const located = environmentWorkSandboxTokenRef({...scope, sessionId: delivery.sessionId, workId: identity.workId, generation: locatedGeneration});
                    if (!Number.isSafeInteger(locatedGeneration) || locatedGeneration < 1 || located.attemptId !== identity.attemptId || locatedGeneration > old.claim.generation) throw new Error("Unrecognized management attempt identity");
                    return locatedGeneration < old.claim.generation || expected.attemptId === identity.attemptId && (!["queued", "starting", "active", "stopping"].includes(old.work.state)
                      || Date.parse(old.claim.claimedAt) + old.heartbeatTtlSeconds * 1000 <= Date.now());
                  };
                  if (!await current() || !await obsolete()) throw new Error("Management worker remains current or takeover claim lost");
                  const recoveredKey = JSON.stringify([scope.workspaceId, identity.workId, identity.attemptId, recovered.handle.id]);
                  const takeover = {authorize: current};
                  processes.set(recoveredKey, {slot, handle: recovered.handle, takeover, current: async () => {
                    if (!await takeover.authorize()) throw new Error("Takeover claim lost; old handle cleanup unauthorized");
                    return !await obsolete();
                  }});
                  await retire(recoveredKey);
                  if (controller.signal.aborted || !await current()) throw new Error("Work claim lost before replacement launch");
                  handle = await observed("native-start", () => sandbox.startManagedProcess(spec));
                }
                processes.set(JSON.stringify([scope.workspaceId, work.id, generation]), { slot, handle, current: owned, renew: () => sandbox.renewActivityTimeout() });
              });
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
      if (command === undefined && !input.recovery) return;
      if (command !== undefined && !origin) throw new Error("PUBLIC_BASE_URL is required for Work runner bootstrap");
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
      await Promise.all([...processes].map(([key, process]) => handoff(process.slot, () => retire(key)).catch(() => input.onError())));
    },
  };
}
