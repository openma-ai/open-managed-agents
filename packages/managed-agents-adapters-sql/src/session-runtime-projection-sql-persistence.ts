import { decodeSessionEventDocument, encodeSessionEventDocument } from '@open-managed-agents/session-runtime-contract/history';
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindRuntimeProjectionSession,
  ProjectSessionRuntimeState,
  ProjectSessionRuntimeStateResult,
  SessionRuntimeProjectionPersistencePort,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";
import {
  workStartupFailureEvents,
  type SettleWorkStartupFailure,
  type WorkStartupFailurePersistencePort,
  type EnvironmentWorkExecutionFence,
  projectionEventIdCollision,
  projectionEventIdCollisionWarning,
} from "@open-managed-agents/managed-agents-application";
import type { StoredSession } from "@open-managed-agents/session-store";
import { sessionFromSourceRow } from "./session-sql-source";

const FAILED_ATTEMPT_SQL = `SELECT 1 FROM managed_session_executions old
      WHERE old.workspace_id = ? AND old.id = ? AND old.session_id = ?
        AND old.state = 'failed' AND old.attempt_id = ? AND old.owner_id = ? AND old.generation = ?
        AND NOT EXISTS (SELECT 1 FROM managed_session_executions newer
          WHERE newer.workspace_id = old.workspace_id AND newer.session_id = old.session_id AND newer.id <> old.id
            AND (newer.state IN ('queued', 'running') OR newer.admitted_at_ms >= old.admitted_at_ms
              OR newer.settled_at_ms > old.settled_at_ms))`;

interface ProjectionSessionRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid runtime projection timestamp: ${value}`);
  }
  return milliseconds;
}

function storedSession(row: ProjectionSessionRow): StoredSession {
  return {
    revision: Number(row.revision),
    session: sessionFromSourceRow(row),
  };
}

export class SqlSessionRuntimeProjectionPersistence
  implements SessionRuntimeProjectionPersistencePort, WorkStartupFailurePersistencePort
{
  readonly #now: () => Date;
  readonly #warn: (entry: ReturnType<typeof projectionEventIdCollisionWarning>) => void;

  constructor(
    private readonly client: SqlClient,
    options: {
      now?: () => Date;
      warn?: (entry: ReturnType<typeof projectionEventIdCollisionWarning>) => void;
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#warn = options.warn ?? ((entry) => {
      console.warn(JSON.stringify({ level: "warn", ...entry }));
    });
  }

  async findCurrent(
    input: FindRuntimeProjectionSession,
  ): Promise<StoredSession | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<ProjectionSessionRow>();
    return row === null ? null : storedSession(row);
  }

  async captureStartupBoundary(claim: EnvironmentWorkExecutionFence): Promise<number | null> {
    const current = await this.findCurrent(claim);
    if (current === null || current.session.status !== "running") return null;
    // A later input/projection invalidates this boundary at settlement.
    const active = await this.isFenceActive({ ...claim, expectedRevision: current.revision,
      next: current.session, events: [], environmentWorkFence: claim }, this.#now().getTime());
    return active ? current.revision : null;
  }

  async settleStartupFailure(input: SettleWorkStartupFailure): Promise<"committed" | "rejected"> {
    const claim = input.claim;
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isFinite(Date.parse(input.processedAt))) return "rejected";
    const events = workStartupFailureEvents(input);
    const work = await this.client.prepare(
      "SELECT document, revision, state, claim_generation FROM managed_environment_work WHERE workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ?",
    ).bind(claim.workspaceId, claim.environmentId, claim.workId, claim.sessionId)
      .first<{ document: string; revision: number; state: string; claim_generation: number }>();
    if (work === null || Number(work.claim_generation) !== claim.generation) return "rejected";
    if (work.state === "stopped") {
      // Confirmation only: stopped credentials cannot publish a fresh terminal.
      // Require the exact immutable bodies, never infer completion from status.
      for (const event of events) {
        const row = await this.client.prepare("SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND id = ?")
          .bind(claim.workspaceId, claim.sessionId, event.id).first<{ document: string }>();
        if (row === null || JSON.stringify(decodeSessionEventDocument(row.document).event) !== JSON.stringify(event)) return "rejected";
      }
      return "committed";
    }
    const current = await this.findCurrent(claim);
    if (current === null || current.revision !== input.revision || current.session.status !== "running") return "rejected";
    const result = await this.projectState({ ...claim, expectedRevision: input.revision,
      environmentWorkFence: claim, events,
      next: { ...current.session, status: "idle", updatedAt: input.processedAt > current.session.updatedAt ? input.processedAt : current.session.updatedAt },
    }, { workRevision: Number(work.revision), workDocument: work.document, processedAt: input.processedAt });
    return result.type === "projected" ? "committed" : "rejected";
  }

  async project(
    input: ProjectSessionRuntimeState,
  ): Promise<ProjectSessionRuntimeStateResult> {
    return this.projectState(input);
  }

  private async projectState(
    input: ProjectSessionRuntimeState,
    startup?: { workRevision: number; workDocument: string; processedAt: string },
  ): Promise<ProjectSessionRuntimeStateResult> {
    if (input.next.id !== input.sessionId) {
      throw new Error("Projected session ID does not match the target session");
    }
    const fence = input.executionFence;
    const environmentWorkFence = input.environmentWorkFence;
    if (fence !== undefined && environmentWorkFence !== undefined) {
      throw new Error("Runtime projection accepts exactly one execution fence");
    }
    if (
      fence !== undefined &&
      (fence.workspaceId !== input.workspaceId ||
        fence.sessionId !== input.sessionId)
    ) return { type: "execution_fence_lost" };
    if (
      environmentWorkFence !== undefined &&
      (environmentWorkFence.workspaceId !== input.workspaceId ||
        environmentWorkFence.sessionId !== input.sessionId ||
        !Number.isSafeInteger(environmentWorkFence.generation) ||
        environmentWorkFence.generation < 1)
    ) return { type: "execution_fence_lost" };
    const now = this.#now().getTime();
    const failedSql = fence?.settlement === "failed_unclaimed" ? FAILED_ATTEMPT_SQL.replace("old.attempt_id = ? AND old.owner_id = ? AND old.generation = ?", "old.attempt_id IS NULL AND old.attempt_count = 0") : FAILED_ATTEMPT_SQL;
    let fenceSql = fence?.settlement !== undefined
      ? `AND EXISTS (${failedSql})`
      : fence !== undefined
      ? `AND EXISTS (
           SELECT 1 FROM managed_session_executions
            WHERE workspace_id = ? AND id = ? AND session_id = ?
              AND state = 'running' AND attempt_id = ? AND owner_id = ?
              AND generation = ? AND lease_expires_at_ms > ?
         )`
      : environmentWorkFence !== undefined
        ? `AND EXISTS (
             SELECT 1 FROM managed_environment_work
              WHERE workspace_id = ? AND environment_id = ? AND id = ?
                AND session_id = ? AND state IN ('starting', 'active')
                AND claim_generation = ? AND claim_at IS NOT NULL
                AND claim_at + heartbeat_ttl_seconds * 1000 > ?
           )`
        : "";
    const fenceBindings: Array<string | number> = fence !== undefined
      ? [
          fence.workspaceId,
          fence.executionId,
          fence.sessionId,
          ...(fence.settlement === "failed_unclaimed" ? [] : [fence.attemptId, fence.ownerId, fence.generation]),
          ...(fence.settlement !== undefined ? [] : [now]),
        ]
      : environmentWorkFence !== undefined
        ? [
            environmentWorkFence.workspaceId,
            environmentWorkFence.environmentId,
            environmentWorkFence.workId,
            environmentWorkFence.sessionId,
            environmentWorkFence.generation,
            now,
          ]
        : [];
    if (startup !== undefined && environmentWorkFence !== undefined) {
      // Work revision includes heartbeat updates: a racing renewal or reclaim
      // rejects this whole batch. Other/newer Work must not be closed by us.
      fenceSql += `AND EXISTS (SELECT 1 FROM managed_environment_work WHERE workspace_id = ? AND id = ? AND revision = ?)
        AND NOT EXISTS (SELECT 1 FROM managed_environment_work newer
          WHERE newer.workspace_id = ? AND newer.session_id = ? AND newer.id <> ?
            AND (newer.state <> 'stopped' OR newer.created_at >=
              (SELECT created_at FROM managed_environment_work WHERE workspace_id = ? AND id = ?)))`;
      fenceBindings.push(environmentWorkFence.workspaceId, environmentWorkFence.workId, startup.workRevision,
        environmentWorkFence.workspaceId, environmentWorkFence.sessionId, environmentWorkFence.workId,
        environmentWorkFence.workspaceId, environmentWorkFence.workId);
    }
    const existingEvents = await Promise.all(input.events.map((event) =>
      this.client.prepare(
        `SELECT document FROM managed_session_events
          WHERE workspace_id = ? AND session_id = ? AND id = ?`,
      ).bind(input.workspaceId, input.sessionId, event.id).first<{
        document: string;
      }>()
    ));
    if (existingEvents.some((row) => row !== null)) {
      // Startup replay is confirmed only by settleStartupFailure after checking
      // the stopped Work. Ordinary projection replay cannot prove that stop.
      if (startup !== undefined) return { type: "execution_fence_lost" };
      const exactReplay = existingEvents.every((row, index) =>
        row !== null && JSON.stringify(decodeSessionEventDocument(row.document).event) === JSON.stringify(input.events[index])
      );
      if (!await this.isFenceActive(input, now)) {
        return { type: "execution_fence_lost" };
      }
      if (!exactReplay) {
        // Event IDs are immutable facts: keep the first recorded body and do
        // not apply any part of the replayed batch.
        const collision = projectionEventIdCollision(
          input.events
            .filter((_event, index) => existingEvents[index] !== null)
            .map((event) => event.id),
        );
        this.#warn(projectionEventIdCollisionWarning({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          collision,
        }));
        return collision;
      }
      const current = await this.findCurrent(input);
      return current === null
        ? { type: "not_found" }
        : { type: "projected", record: current };
    }
    const eventStatements = input.events.map((event, index) => {
      return this.client.prepare(
          `INSERT INTO managed_session_events
            (workspace_id, session_id, thread_id, id, type, document, processed_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM managed_sessions
               WHERE workspace_id = ? AND id = ? AND revision = ?
            )
              ${fenceSql}
           ON CONFLICT (workspace_id, session_id, id) DO NOTHING`,
        ).bind(
          input.workspaceId,
          input.sessionId,
          "sessionThreadId" in event ? event.sessionThreadId ?? null : null,
          event.id,
          event.type,
          encodeSessionEventDocument(event, { revision: input.expectedRevision + 1, index }, fence?.executionId),
          timestamp(event.processedAt),
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
          ...fenceBindings,
        );
    });
    // Thread CRUD is a projection of the same native lifecycle facts. Update
    // the existing Thread records under this Session CAS/fence, so a stale
    // child cannot publish a status after the parent loses ownership.
    const threadUpdates = new Map<string, SessionThread>();
    for (const event of input.events) {
      if (!("sessionThreadId" in event) || typeof event.sessionThreadId !== "string") continue;
      const status = event.type === "session.thread_status_running" ? "running"
        : event.type === "session.thread_status_idle" ? "idle"
        : event.type === "session.thread_status_terminated" ? "terminated"
        : event.type === "session.thread_status_rescheduled" ? "rescheduling" : undefined;
      if (status === undefined) continue;
      let thread = threadUpdates.get(event.sessionThreadId);
      if (thread === undefined) {
        const row = await this.client.prepare(
          `SELECT document FROM managed_session_threads
            WHERE workspace_id = ? AND session_id = ? AND id = ?`,
        ).bind(input.workspaceId, input.sessionId, event.sessionThreadId).first<{ document: string }>();
        if (row === null) continue;
        thread = JSON.parse(row.document) as SessionThread;
      }
      threadUpdates.set(event.sessionThreadId, { ...thread, status,
        updatedAt: event.processedAt > thread.updatedAt ? event.processedAt : thread.updatedAt });
    }
    const threadStatements = [...threadUpdates.values()].map((thread) => this.client.prepare(
      `UPDATE managed_session_threads SET document = ?, updated_at = ?
        WHERE workspace_id = ? AND session_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM managed_sessions
              WHERE workspace_id = ? AND id = ? AND revision = ?
          ) ${fenceSql}`,
    ).bind(JSON.stringify(thread), timestamp(thread.updatedAt), input.workspaceId,
      input.sessionId, thread.id, input.workspaceId, input.sessionId,
      input.expectedRevision, ...fenceBindings));
    const next = input.next;
    const update = this.client.prepare(
        `UPDATE managed_sessions
            SET document = ?, revision = revision + 1, agent_id = ?,
                agent_version = ?, environment_id = ?, deployment_id = ?,
                status = ?, updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?
            ${fenceSql}`,
      ).bind(
        JSON.stringify(next),
        next.agent.id,
        next.agent.version,
        next.environmentId,
        next.deploymentId ?? null,
        next.status,
        timestamp(next.updatedAt),
        next.archivedAt === null ? null : timestamp(next.archivedAt),
        input.workspaceId,
        input.sessionId,
        input.expectedRevision,
        ...fenceBindings,
      );
    // Serialize event insertion with accepted inputs and other runtime batches
    // before publishing the successful Session revision as an ordering fact.
    const revisionGuard = this.client.prepare(
      `UPDATE managed_sessions SET revision = revision
        WHERE workspace_id = ? AND id = ? AND revision = ? ${fenceSql}`,
    ).bind(input.workspaceId, input.sessionId, input.expectedRevision, ...fenceBindings);
    const stop = startup === undefined || environmentWorkFence === undefined ? [] : [this.client.prepare(
      `UPDATE managed_environment_work SET document = ?, state = 'stopped', claim_worker_id = NULL, revision = revision + 1
       WHERE workspace_id = ? AND environment_id = ? AND id = ? AND revision = ?
         AND EXISTS (SELECT 1 FROM managed_sessions WHERE workspace_id = ? AND id = ? AND revision = ?) ${fenceSql}`,
    ).bind(JSON.stringify({ ...JSON.parse(startup.workDocument), state: "stopped",
      stopRequestedAt: JSON.parse(startup.workDocument).stopRequestedAt ?? startup.processedAt,
      stoppedAt: startup.processedAt }),
      environmentWorkFence.workspaceId, environmentWorkFence.environmentId, environmentWorkFence.workId,
      startup.workRevision, input.workspaceId, input.sessionId, input.expectedRevision + 1, ...fenceBindings)];
    const statements = [revisionGuard, ...eventStatements, ...threadStatements, update, ...stop];
    const updateIndex = 1 + eventStatements.length + threadStatements.length;
    const rejected = new Error("Runtime projection admission changed inside transaction");
    let results;
    try {
      // READ COMMITTED may change the fence between statements. Never commit
      // earlier events/threads when the final CAS or an event write rejects.
      results = this.client.batchChecked
        ? await this.client.batchChecked(statements, rows => {
          if (rows[updateIndex]?.meta.changes !== 1 || (stop.length > 0 && rows.at(-1)?.meta.changes !== 1) || rows.slice(1, 1 + eventStatements.length).some(row => row.meta.changes !== 1)) throw rejected;
        })
        : await this.client.batch(statements); // D1: one atomic SQLite snapshot.
    } catch (error) {
      if (error !== rejected) throw error;
      results = [{ meta: { changes: 0 } }];
    }
    const updateResult = results[updateIndex] ?? results[0];
    if (updateResult === undefined) {
      throw new Error("Runtime projection batch returned no update result");
    }
    if (updateResult.meta.changes === 0) {
      if (!await this.isFenceActive(input, now)) {
        return { type: "execution_fence_lost" };
      }
      const current = await this.findCurrent(input);
      return current === null
        ? { type: "not_found" }
        : {
            type: "revision_conflict",
            actualRevision: current.revision,
          };
    }
    if (updateResult.meta.changes !== 1) {
      throw new Error(
        `Runtime projection affected ${updateResult.meta.changes} session rows`,
      );
    }
    const projected = await this.findCurrent(input);
    if (projected === null) {
      throw new Error("Session vanished after runtime projection");
    }
    return { type: "projected", record: projected };
  }

  private async isFenceActive(
    input: ProjectSessionRuntimeState,
    now: number,
  ): Promise<boolean> {
    const fence = input.executionFence;
    if (fence?.settlement !== undefined) {
      const sql = fence.settlement === "failed_unclaimed" ? FAILED_ATTEMPT_SQL.replace("old.attempt_id = ? AND old.owner_id = ? AND old.generation = ?", "old.attempt_id IS NULL AND old.attempt_count = 0") : FAILED_ATTEMPT_SQL;
      const row = await this.client.prepare(sql)
        .bind(fence.workspaceId, fence.executionId, fence.sessionId, ...(fence.settlement === "failed_unclaimed" ? [] : [fence.attemptId, fence.ownerId, fence.generation])).first();
      return row !== null;
    }
    if (fence !== undefined) {
      const active = await this.client.prepare(
        `SELECT 1 AS active FROM managed_session_executions
          WHERE workspace_id = ? AND id = ? AND session_id = ?
            AND state = 'running' AND attempt_id = ? AND owner_id = ?
            AND generation = ? AND lease_expires_at_ms > ?`,
      ).bind(
        fence.workspaceId,
        fence.executionId,
        fence.sessionId,
        fence.attemptId,
        fence.ownerId,
        fence.generation,
        now,
      ).first<{ active: number }>();
      return active !== null;
    }
    const environmentWorkFence = input.environmentWorkFence;
    if (environmentWorkFence !== undefined) {
      const active = await this.client.prepare(
        `SELECT 1 AS active FROM managed_environment_work
          WHERE workspace_id = ? AND environment_id = ? AND id = ?
            AND session_id = ? AND state IN ('starting', 'active')
            AND claim_generation = ? AND claim_at IS NOT NULL
            AND claim_at + heartbeat_ttl_seconds * 1000 > ?`,
      ).bind(
        environmentWorkFence.workspaceId,
        environmentWorkFence.environmentId,
        environmentWorkFence.workId,
        environmentWorkFence.sessionId,
        environmentWorkFence.generation,
        now,
      ).first<{ active: number }>();
      return active !== null;
    }
    return true;
  }
}
