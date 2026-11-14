import { log } from "@open-managed-agents/shared";
import type { E2BSandboxExecutor, E2BManagedIdentity } from "@open-managed-agents/sandbox-adapter-e2b";
import type { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import type { EnvironmentWorkRuntimeDelivery } from "@open-managed-agents/runtime-resource-contract";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxManagedProcessSpec } from "@open-managed-agents/sandbox";


export async function startE2BWorkProcess(input: {
  runtime: E2BSandboxExecutor;
  work: Pick<SqlEnvironmentWorkStore, "find">;
  sql?: SqlClient;
  delivery: EnvironmentWorkRuntimeDelivery;
  assertCurrent(): Promise<void>;
  spec: SandboxManagedProcessSpec;
  identity: E2BManagedIdentity;
}) {
  await input.assertCurrent();
  const context = { session_id: input.delivery.sessionId, work_id: input.delivery.workId, tenant_id: input.delivery.workspaceId, sandbox_id: input.runtime.runtimeHandle().runtimeId, claim_generation: input.identity.attemptId, call_id: crypto.randomUUID() };
  log({ ...context, op: "work.execution.start" }, "Starting native Work process");
  try {
    const handle = await input.runtime.startManagedProcess(input.spec, input.identity);
    log({ ...context, op: "work.execution.started", process_id: handle.id }, "Native Work process started; harness completion not implied");
    return { ...handle, created: true };
  }
  catch (error) {
    // Only a definite flock rejection permits discovery. Unknown starts are
    // never retried or interpreted as absence.
    if (!(error instanceof Error) || error.message !== "management worker busy" || (error as { outcome?: string }).outcome !== "rejected") throw error;
  }
  const locator = await input.runtime.inspectManagedProcessSlot();
  await input.assertCurrent();
  if (locator.sandboxId !== input.runtime.runtimeHandle().runtimeId || locator.identity.workspaceId !== input.delivery.workspaceId || locator.identity.sessionId !== input.delivery.sessionId) throw new Error("Management slot scope mismatch");
  const same = locator.identity.workId === input.identity.workId && locator.identity.attemptId === input.identity.attemptId;
  if (same) {
    if (locator.status !== "running") throw new Error("Current management worker already exited");
    const handle = await input.runtime.restoreManagedProcess(locator);
    await input.assertCurrent();
    if (await handle.getStatus() !== "running") throw new Error("Current management worker exit is unconfirmed");
    return { ...handle, created: false };
  }
  await assertE2BWorkClaimObsolete({ ...input, identity: locator.identity });
  await input.assertCurrent();
  const handle = await input.runtime.restoreManagedProcess(locator);
  await input.assertCurrent();
  await handle.kill("SIGTERM");
  if (await handle.getStatus() !== "exited") throw new Error("Previous management worker exit is unconfirmed");
  await input.assertCurrent();
  return { ...await input.runtime.startManagedProcess(input.spec, input.identity), created: true };
}

/** A locator is discovery, never kill/bootstrap authority. Both cold dispatch
 * and native handoff require the same scoped SQL proof of an obsolete claim. */
export async function assertE2BWorkClaimObsolete(input: {
  work: Pick<SqlEnvironmentWorkStore, "find">;
  sql?: SqlClient;
  delivery: EnvironmentWorkRuntimeDelivery;
  identity: E2BManagedIdentity;
}): Promise<void> {
  const match = /^environment-work-claim:([1-9][0-9]*)$/.exec(input.identity.attemptId);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Management locator has no Work claim identity");
  const generation = Number(match[1]);
  const old = await input.work.find({ ...input.delivery, workId: input.identity.workId });
  // Discovery is not kill authority: require a known obsolete SQL Work claim.
  if (!old || old.work.data.type !== "session" || old.work.data.id !== input.delivery.sessionId) throw new Error("Management Work authority is unknown");
  // The public store deliberately hides stopped claims. Its original SQL row
  // retains the monotonic generation; read it without inventing a live claim.
  const terminal = old.work.state === "stopped" && old.claim === null && input.sql
    ? await input.sql.prepare("SELECT claim_generation FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND state='stopped'")
      .bind(input.delivery.workspaceId, input.delivery.environmentId, input.delivery.sessionId, input.identity.workId).first<{ claim_generation: number }>()
    : null;
  const observedGeneration = old.claim?.generation ?? Number(terminal?.claim_generation);
  if (!Number.isSafeInteger(observedGeneration) || observedGeneration < generation) throw new Error("Management Work authority is unknown");
  const obsolete = old.work.state === "stopped" || observedGeneration > generation || (old.claim !== null && (old.work.state === "stopping"
    || Date.parse(old.claim.claimedAt) + old.heartbeatTtlSeconds * 1000 <= Date.now()));
  if (!obsolete) throw new Error("Previous management worker is still current");
}

/** Read-only discovery for provider maintenance, not dispatch/claim recovery.
 * Legacy locators remain readable by old callers, but never authorize renewal.
 */
export async function readE2BWorkLeaseProcess(input: {
  runtime: E2BSandboxExecutor;
  scope: { workspaceId: string; sessionId: string };
}) {
  const locator = await input.runtime.inspectManagedProcessSlot();
  const match = /^environment-work-claim:([1-9][0-9]*)$/.exec(locator.identity.attemptId);
  if (locator.sandboxId !== input.runtime.runtimeHandle().runtimeId
    || locator.identity.workspaceId !== input.scope.workspaceId || locator.identity.sessionId !== input.scope.sessionId
    || !match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Work lease locator scope mismatch");
  if (!locator.holderHash || !/^[a-f0-9]{64}$/.test(locator.holderHash)) throw new Error("Work lease recovery requires a process-bound holder hash");
  return { locator, generation: Number(match[1]), holderHash: locator.holderHash };
}

export async function restoreE2BWorkLeaseProcess(input: {
  runtime: E2BSandboxExecutor;
  scope: { workspaceId: string; sessionId: string };
}) {
  const { locator, generation, holderHash } = await readE2BWorkLeaseProcess(input);
  if (locator.status !== "running") throw new Error("Work lease management process has exited");
  const handle = await input.runtime.restoreManagedProcess(locator);
  if (await handle.getStatus() !== "running") throw new Error("Work lease management process has exited");
  return { locator, handle, generation, holderHash };
}
