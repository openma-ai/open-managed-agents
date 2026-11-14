import { sessionExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import type {
  EnqueueEnvironmentSessionWork,
  EnqueueEnvironmentSessionWorkResult,
  EnvironmentSessionWorkEnqueuerPort,
  StopEnvironmentSessionWork,
  StopEnvironmentSessionWorkResult,
} from "./enqueuer";
import type { EnvironmentWorkSessionCredentialIssuerPort } from "./credential-issuer";
import type { EnvironmentWorkWakeupPort } from "./wakeup";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";

export interface EnvironmentWorkEnqueuerServiceDependencies {
  workspaceId: string;
  store: EnvironmentWorkStore;
  credentials: EnvironmentWorkSessionCredentialIssuerPort;
  wakeup: EnvironmentWorkWakeupPort;
  clock: { now(): Date };
  ids: { nextEnvironmentWorkId(): string };
}

export class EnvironmentWorkEnqueuerService
  implements EnvironmentSessionWorkEnqueuerPort
{
  constructor(
    private readonly dependencies: EnvironmentWorkEnqueuerServiceDependencies,
  ) {}

  async enqueue(
    input: EnqueueEnvironmentSessionWork,
  ): Promise<EnqueueEnvironmentSessionWorkResult> {
    if (input.workspaceId !== this.dependencies.workspaceId) {
      return {
        type: "rejected",
        message: "Environment Work workspace does not match its application scope",
      };
    }
    if (
      sessionExecutionPlacement(input.environment, input.session).authority !== "environment_work" ||
      input.environment.archivedAt !== null
    ) {
      return {
        type: "rejected",
        message: `Environment ${input.environment.id} cannot accept self-hosted work`,
      };
    }
    if (
      input.session.environmentId !== input.environment.id ||
      input.session.archivedAt !== null
    ) {
      return {
        type: "rejected",
        message: `Session ${input.session.id} does not belong to an active target environment`,
      };
    }
    const workId = this.dependencies.ids.nextEnvironmentWorkId();
    const issued = await this.dependencies.credentials.issue({
      workspaceId: this.dependencies.workspaceId,
      workId,
      environment: input.environment,
      session: input.session,
    });
    if (issued.type === "rejected") return issued;
    const work = {
      id: workId,
      acknowledgedAt: null,
      createdAt: this.dependencies.clock.now().toISOString(),
      data: { type: "session" as const, id: input.session.id },
      environmentId: input.environment.id,
      latestHeartbeatAt: null,
      metadata: {},
      startedAt: null,
      state: "queued" as const,
      stopRequestedAt: null,
      stoppedAt: null,
    };
    if (!this.dependencies.store.ensureSession) throw new Error("Atomic Session Work ensure is not configured");
    const inserted = await this.dependencies.store.ensureSession({
      workspaceId: this.dependencies.workspaceId,
      ...(input.expectedSessionRevision === undefined ? {} : { expectedSessionRevision: input.expectedSessionRevision }),
      ...(input.recoveryEventIds === undefined ? {} : { recoveryEventIds: input.recoveryEventIds }),
      record: {
        work,
        secret: issued.secret,
        claim: null,
        heartbeatTtlSeconds: 90,
      },
    });
    // Delivery is deliberately best-effort. The work row is already durable,
    // and every Environment Worker must retain polling as its fallback.
    await this.dependencies.wakeup.notifyRunStarted({
      workspaceId: this.dependencies.workspaceId,
      environmentId: input.environment.id,
      sessionId: input.session.id,
      workId: inserted.work.id,
      occurredAt: inserted.work.createdAt,
    }).catch(() => {});
    return { type: "queued", work: inserted.work };
  }

  async interruptTarget(input: { workspaceId: string; session: import("../domain/session").Session }): Promise<string | null> {
    if (input.workspaceId !== this.dependencies.workspaceId) throw new Error("Environment Work workspace mismatch");
    const current = await this.dependencies.store.findActiveSession({ workspaceId: input.workspaceId, sessionId: input.session.id });
    return current?.work.environmentId === input.session.environmentId ? current.work.id : null;
  }

  async stop(
    input: StopEnvironmentSessionWork,
  ): Promise<StopEnvironmentSessionWorkResult> {
    if (input.workspaceId !== this.dependencies.workspaceId) {
      return {
        type: "conflict",
        message: "Environment Work workspace does not match its application scope",
      };
    }
    // ACK/reclaim/heartbeat share this revision. Re-read after a lost CAS,
    // but never follow a different Work created while the old one settles.
    if (input.workId === null) return { type: "not_found" };
    let targetWorkId: string | undefined = input.workId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.dependencies.store.findActiveSession({
        workspaceId: this.dependencies.workspaceId,
        sessionId: input.session.id,
      });
      if (current === null || (targetWorkId !== undefined && current.work.id !== targetWorkId)) return { type: "not_found" };
      targetWorkId = current.work.id;
      if (
        current.work.data.type !== "session" ||
        current.work.data.id !== input.session.id ||
        current.work.environmentId !== input.session.environmentId
      ) {
        return {
          type: "conflict",
          message: `Active work does not match Session ${input.session.id}`,
        };
      }
      if (current.work.state === "stopping" || current.work.state === "stopped") {
        return { type: "stopped", work: current.work };
      }
      const timestamp = this.dependencies.clock.now().toISOString();
      const stopsImmediately = current.work.state === "queued";
      const replaced = await this.dependencies.store.replace({
        workspaceId: this.dependencies.workspaceId,
        environmentId: current.work.environmentId,
        workId: current.work.id,
        expectedRevision: current.revision,
        next: {
          work: {
            ...current.work,
            state: stopsImmediately ? "stopped" : "stopping",
            stopRequestedAt: current.work.stopRequestedAt ?? timestamp,
            ...(stopsImmediately && { stoppedAt: timestamp }),
          },
          secret: current.secret,
          claim: stopsImmediately ? null : current.claim,
          heartbeatTtlSeconds: current.heartbeatTtlSeconds,
        },
      });
      if (replaced.type === "not_found") return { type: "not_found" };
      if (replaced.type === "revision_conflict") {
        continue;
      }
      return { type: "stopped", work: replaced.record.work };
    }
    return { type: "conflict", message: "Work changed concurrently while stopping Session " + input.session.id };
  }
}
