import { customInvocationPublicationStatements } from "./custom-invocation-publication";
import { sqliteSourcePositionSql, postgresSourcePositionSql } from "./work-inputs";
import { decodeSessionEventDocument, encodeSessionEventDocument } from '@open-managed-agents/session-runtime-contract/history';
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindRuntimeProjectionSession,
  RuntimeProducedSessionEvent,
  ProjectSessionRuntimeState,
  ProjectSessionRuntimeStateResult,
  SessionRuntimeProjectionPersistencePort,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";
import {
  workStartupFailureEvents,
  planWorkBootstrap,
  sessionBudgetExhausted,
  type WorkFinalizationProjectionGuard,
  inspectWorkApprovalResolution,
  validateWorkThreadLineage,
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

/** Side-effect-free startup lifecycle a claim may project before settling:
 * running, plus the retrying error/rescheduled pair of a failed ACP start. */
function startupFact(event: ReturnType<typeof decodeSessionEventDocument>["event"]): boolean {
  return event.type === "session.status_running" || event.type === "session.status_rescheduled"
    || (event.type === "session.error" && event.error.retryStatus === "retrying");
}

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
  readonly #dialect: "sqlite" | "postgres" | "mysql";
  readonly #warn: (entry: ReturnType<typeof projectionEventIdCollisionWarning>) => void;

  constructor(
    private readonly client: SqlClient,
    options: {
      now?: () => Date;
      dialect?: "sqlite" | "postgres" | "mysql";
      warn?: (entry: ReturnType<typeof projectionEventIdCollisionWarning>) => void;
    } = {},
  ) {
    this.#dialect = options.dialect ?? "sqlite";
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

  /** Reuse canonical bootstrap selection, not latest idle as admission. The
   * private startup transport supplies only a sealed claim, so the holder and
   * exact pending root are resolved here from authoritative storage. */
  private async idleStartupRoot(claim: EnvironmentWorkExecutionFence, current: StoredSession): Promise<WorkFinalizationProjectionGuard | null> {
    if (current.session.status !== "idle" || current.session.archivedAt !== null || current.session.environmentId !== claim.environmentId) return null;
    const work = await this.client.prepare("SELECT claim_worker_id FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND state IN ('starting','active')")
      .bind(claim.workspaceId,claim.environmentId,claim.sessionId,claim.workId,claim.generation).first<{claim_worker_id:string|null}>();
    if (!work?.claim_worker_id) return null;
    const [events, initial] = await Promise.all([
      this.client.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? LIMIT 10001").bind(claim.workspaceId,claim.sessionId).all<{document:string}>(),
      this.client.prepare("SELECT document,sequence FROM managed_session_initial_events WHERE workspace_id=? AND session_id=? LIMIT 10001").bind(claim.workspaceId,claim.sessionId).all<{document:string;sequence?:number}>(),
    ]);
    const rawRows = [...(events.results ?? []),...(initial.results ?? [])];
    if (rawRows.length > 10000) return null;
    // Corrupt canonical JSON is a typed admission refusal, not a transport
    // failure. Keep database IO outside this catch so outages still propagate.
    try {
      const rows = rawRows.map(row => ({...row,decoded:decodeSessionEventDocument(row.document)}));
      if (rows.some(({decoded:{event}}) => !event || typeof event.id !== "string" || typeof event.type !== "string" ||
        (event.type === "user.message" && !Array.isArray(event.content)))) return null;
      const candidate = planWorkBootstrap({claim:{...claim,holder:work.claim_worker_id},revision:current.revision,rows,budgetExhausted:sessionBudgetExhausted(current.session)});
      if (candidate.type !== "run") return null;
      const root = rows.find(row => row.decoded.event.id === candidate.root.inputId)!;
      return {holder:work.claim_worker_id,turnId:candidate.root.turnId,inputId:candidate.root.inputId,inputDocument:root.document,
        bootstrapSequence:"sequence" in root && typeof root.sequence === "number" ? root.sequence : undefined,dialect:this.#dialect};
    } catch { return null; }
  }

  private startupClock(): string {
    return this.#dialect === "postgres" ? "floor(extract(epoch FROM clock_timestamp())*1000)::bigint"
      : this.#dialect === "mysql" ? "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)"
      : "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  }

  async captureStartupBoundary(claim: EnvironmentWorkExecutionFence): Promise<number | null> {
    const current = await this.findCurrent(claim);
    if (current === null) return null;
    if (current.session.status === "idle") {
      const root = await this.idleStartupRoot(claim,current);
      if (!root) return null;
      // No status/revision mutation. Evaluate all authority and raw input
      // conditions in one DB statement, including the clock AFTER queued I/O.
      const rawCas = this.#dialect === "mysql" ? "BINARY document=BINARY ?" : "document=?";
      const result = await this.client.prepare(`UPDATE managed_sessions SET revision=revision
        WHERE workspace_id=? AND id=? AND revision=? AND environment_id=? AND archived_at IS NULL AND status='idle'
        AND EXISTS(SELECT 1 FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=?
          AND state IN ('starting','active') AND claim_generation=? AND claim_worker_id=? AND claim_at IS NOT NULL
          AND claim_at+heartbeat_ttl_seconds*1000>${this.startupClock()})
        AND EXISTS(SELECT 1 FROM ${root.bootstrapSequence===undefined?"managed_session_events":"managed_session_initial_events"}
          WHERE workspace_id=? AND session_id=? AND ${root.bootstrapSequence===undefined?"id":"sequence"}=? AND ${rawCas})`)
        .bind(claim.workspaceId,claim.sessionId,current.revision,claim.environmentId,
          claim.workspaceId,claim.environmentId,claim.sessionId,claim.workId,claim.generation,root.holder,
          claim.workspaceId,claim.sessionId,root.bootstrapSequence??root.inputId,root.inputDocument).run();
      return result.meta.changes === 1 ? current.revision : null;
    }
    if (current.session.status !== "running") return null;
    // Preserve existing running startup protocol. Idle followup admission is
    // the narrow canonical-root path above, never a fabricated running event.
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
    if (current === null || current.revision < input.revision) return "rejected";
    const idleRoot = current.session.status === "idle" && current.revision === input.revision
      ? await this.idleStartupRoot(claim,current) : null;
    if (current.session.status !== "running" && current.session.status !== "rescheduling" && idleRoot === null) return "rejected";
    if (current.revision > input.revision) {
      const rows = await this.client.prepare(
        "SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ?",
      ).bind(claim.workspaceId, claim.sessionId).all<{ document: string }>();
      const revisions = new Set<number>();
      for (const row of rows.results ?? []) {
        const source = decodeSessionEventDocument(row.document);
        // Legacy/unpositioned facts cannot prove they preceded the boundary.
        if (source.position === undefined) return "rejected";
        if (source.position.revision <= input.revision) continue;
        if (source.position.revision > current.revision ||
          source.environmentWork?.workId !== claim.workId || source.environmentWork.generation !== claim.generation ||
          source.consumedByExecutionId !== undefined || !startupFact(source.event)) return "rejected";
        revisions.add(source.position.revision);
      }
      // Every intervening Session revision must be explained by this claim's
      // startup facts, not merely a latest running status. CAS below
      // still rejects a new input/projection after this read.
      if (revisions.size !== current.revision - input.revision) return "rejected";
    }
    const result = await this.projectState({ ...claim, expectedRevision: current.revision,
      environmentWorkFence: claim, events,
      next: { ...current.session, status: "idle", updatedAt: input.processedAt > current.session.updatedAt ? input.processedAt : current.session.updatedAt },
    }, { workRevision: Number(work.revision), workDocument: work.document, processedAt: input.processedAt, ...(idleRoot ? {root:idleRoot} : {}) });
    return result.type === "projected" ? "committed" : "rejected";
  }

  async project(
    input: ProjectSessionRuntimeState,
  ): Promise<ProjectSessionRuntimeStateResult> {
    return this.projectState(input);
  }

  private async projectState(
    input: ProjectSessionRuntimeState,
    startup?: { workRevision: number; workDocument: string; processedAt: string; root?: WorkFinalizationProjectionGuard },
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
    const finalization = input.workFinalization;
    if (finalization !== undefined && (environmentWorkFence === undefined || !finalization.holder || !finalization.turnId)) {
      return { type: "execution_fence_lost" };
    }
    const rootGuard = input.workRoot === undefined ? undefined : await this.verifyWorkRoot(input);
    if (input.workRoot !== undefined && finalization !== undefined) return { type: "execution_fence_lost" };
    if (input.workRoot !== undefined && rootGuard === null) {
      // A concurrent usage projection can advance the revision between the
      // application read and root verification. Retry from a fresh read; every
      // attempt must prove the root and the live Work fence again.
      const current = await this.findCurrent(input);
      if (current !== null && current.revision !== input.expectedRevision) {
        return { type: "revision_conflict", actualRevision: current.revision };
      }
      return { type: "execution_fence_lost" };
    }
    const guarded = finalization ?? rootGuard ?? startup?.root ?? undefined;
    if (input.customInvocations?.length && (!input.workRoot || !guarded || !environmentWorkFence || guarded.dialect !== "sqlite")) {
      return {type:"execution_fence_lost"};
    }
    const now = this.#now().getTime();
    const workClock = guarded === undefined ? "?" : guarded.dialect === "postgres"
      ? "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint"
      : guarded.dialect === "mysql" ? "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)"
      : "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
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
                AND session_id = ? AND state IN ('starting', 'active'${finalization === undefined ? "" : ", 'stopping'"})
                AND claim_generation = ? AND claim_at IS NOT NULL
                AND claim_at + heartbeat_ttl_seconds * 1000 > ${workClock}
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
            ...(guarded === undefined ? [now] : []),
          ]
        : [];
    if (guarded !== undefined && environmentWorkFence !== undefined) {
      const rawCas = guarded.dialect === "mysql" ? "BINARY document = BINARY ?" : "document = ?";
      fenceSql += ` AND EXISTS (SELECT 1 FROM managed_environment_work
        WHERE workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ? AND claim_worker_id = ?)
        AND EXISTS (SELECT 1 FROM ${guarded.bootstrapSequence === undefined ? "managed_session_events" : "managed_session_initial_events"}
          WHERE workspace_id = ? AND session_id = ? AND ${guarded.bootstrapSequence === undefined ? "id" : "sequence"} = ? AND ${rawCas})
        AND EXISTS (SELECT 1 FROM managed_sessions WHERE workspace_id = ? AND id = ? AND environment_id = ? AND archived_at IS NULL)`;
      fenceBindings.push(environmentWorkFence.workspaceId, environmentWorkFence.environmentId, environmentWorkFence.workId,
        environmentWorkFence.sessionId, guarded.holder, input.workspaceId, input.sessionId,
        guarded.bootstrapSequence ?? guarded.inputId, guarded.inputDocument,
        input.workspaceId, input.sessionId, environmentWorkFence.environmentId);
    }
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
    const replayEvents = input.environmentWorkFence === undefined ? input.events : input.sourceEvents ?? input.events;
    const existingEvents = await Promise.all(replayEvents.map((event) =>
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
      if (startup !== undefined || input.workRoot !== undefined) return { type: "execution_fence_lost" };
      const exactReplay = existingEvents.every((row, index) =>
        row !== null && (() => {
          const stored = decodeSessionEventDocument(row.document);
          const source = JSON.parse(row.document).source_position?.runtime_input;
          // Original inputs and derived facts were committed in one CAS.
          // Never let another Work generation confirm their publication.
          if (input.environmentWorkFence !== undefined &&
            (stored.environmentWork?.workId !== input.environmentWorkFence.workId ||
             stored.environmentWork.generation !== input.environmentWorkFence.generation)) return false;
          return JSON.stringify(source ?? stored.event) === JSON.stringify(replayEvents[index]);
        })()
      );
      if (!await this.isFenceActive(input, now)) {
        return { type: "execution_fence_lost" };
      }
      if (!exactReplay) {
        // Event IDs are immutable facts: keep the first recorded body and do
        // not apply any part of the replayed batch.
        const collision = projectionEventIdCollision(
          replayEvents
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
    const invocationStatements = input.customInvocations?.length
      ? await customInvocationPublicationStatements({sql:this.client,projection:input,turnId:guarded!.turnId,fenceSql,fenceBindings}) : [];
    if (invocationStatements === null) return {type:"execution_fence_lost"};
    const sourceById = new Map((input.sourceEvents ?? []).map(event => [event.id, event]));
    const eventStatements = input.events.map((event, index) => {
      const document = JSON.parse(encodeSessionEventDocument(event,
        { revision: input.expectedRevision + 1, index }, guarded?.turnId ?? fence?.executionId, undefined,
        environmentWorkFence === undefined ? undefined : { workId: environmentWorkFence.workId, generation: environmentWorkFence.generation }));
      const binding = input.customInvocations?.find(binding => binding.nativeCallId === event.id);
      if (binding) document.source_position.custom_invocation_receipt = binding.receipt;
      const source = sourceById.get(event.id);
      if (environmentWorkFence !== undefined && source !== undefined) {
        document.source_position.runtime_input = source;
      }
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
          JSON.stringify(document),
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
    // Lock Work before event writes on READ COMMITTED hosts. Re-evaluate the
    // database clock after lock acquisition and again in the final Session CAS.
    const workLock = guarded === undefined || environmentWorkFence === undefined ? [] : [this.client.prepare(
      `UPDATE managed_environment_work SET claim_generation = claim_generation WHERE workspace_id = ? AND id = ? AND claim_worker_id = ? AND claim_generation = ?`,
    ).bind(environmentWorkFence.workspaceId, environmentWorkFence.workId, guarded.holder, environmentWorkFence.generation)];
    const statements = [revisionGuard, ...workLock, ...invocationStatements, ...eventStatements, ...threadStatements, update, ...stop];
    const invocationStart = 1 + workLock.length;
    const eventStart = invocationStart + invocationStatements.length;
    const updateIndex = eventStart + eventStatements.length + threadStatements.length;
    const rejected = new Error("Runtime projection admission changed inside transaction");
    let results;
    const assertChange = (index: number) => index <= updateIndex || (startup?.root !== undefined && index === statements.length - 1);
    const originalIndexes: number[] = [];
    let batchIndex = 0;
    const checkedStatements = statements.flatMap((statement, index) => {
      originalIndexes.push(batchIndex);
      const check = guarded !== undefined && assertChange(index);
      batchIndex += check ? 2 : 1;
      return check ? [statement, this.client.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE abs(-9223372036854775808) END")] : [statement];
    });
    try {
      // READ COMMITTED may change the fence between statements. Never commit
      // earlier events/threads when the final CAS or an event write rejects.
      results = this.client.batchChecked
        ? await this.client.batchChecked(statements, rows => {
          if ((guarded !== undefined && (rows[0]?.meta.changes !== 1 || workLock.length > 0 && rows[1]?.meta.changes !== 1)) || rows[updateIndex]?.meta.changes !== 1 || (stop.length > 0 && rows.at(-1)?.meta.changes !== 1) || rows.slice(invocationStart, eventStart + eventStatements.length).some(row => row.meta.changes !== 1)) throw rejected;
        })
        : guarded === undefined ? await this.client.batch(statements)
        // A SQLite statement clock may advance even inside an atomic batch.
        // Assert changed rows inside SQL to roll back partial terminal writes.
        : await this.client.batch(checkedStatements).then(rows => originalIndexes.map(index => rows[index]!));
    } catch (error) {
      if (error !== rejected && !(guarded !== undefined && !this.client.batchChecked && error instanceof Error && error.message.includes("integer overflow"))) throw error;
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

  /** Bounded optimistic evidence read. Exact root bytes + current Session
   * revision + Work holder/generation/DB clock are repeated in EVERY write's
   * transaction guard. A root/terminal race rolls the complete batch back. */
  private async verifyWorkRoot(input: ProjectSessionRuntimeState): Promise<import("@open-managed-agents/managed-agents-application").WorkFinalizationProjectionGuard | null> {
    const proof = input.workRoot!, claim = input.environmentWorkFence;
    if (!claim || input.executionFence || !proof.inputId || !proof.turnId || !proof.expectedDocument) return null;
    const dialect = input.workRootDialect ?? "sqlite";
    let root: ReturnType<typeof decodeSessionEventDocument>;
    let raw: Record<string, unknown>;
    try { root = decodeSessionEventDocument(proof.expectedDocument); raw = JSON.parse(proof.expectedDocument); } catch { return null; }
    const position = raw.source_position as {consumption_claim?: {workId?: unknown; generation?: unknown; holder?: unknown}} | undefined;
    const consumedClaim = position?.consumption_claim;
    const runnable = (event: {type: string}, document: Record<string, unknown>) =>
      ["user.message", "user.define_outcome", "user.tool_result", "user.custom_tool_result"].includes(event.type) || event.type === "session.updated" && document.resume === true;
    if (!root.position || root.position.revision > input.expectedRevision || root.event.id !== proof.inputId ||
        (root.executionId ?? root.event.id) !== proof.turnId || root.consumedByExecutionId !== proof.turnId ||
        consumedClaim?.workId !== claim.workId || consumedClaim.generation !== claim.generation ||
        typeof consumedClaim.holder !== "string" || !consumedClaim.holder || !runnable(root.event, raw) ||
        typeof raw.processedAt !== "string" || !Number.isFinite(Date.parse(raw.processedAt)) || raw._queued === true || raw.cancelled_at_ms != null ||
        raw.deferredUntilToolResults !== undefined || raw.deferred_until_tool_results !== undefined) return null;
    const bootstrapPrefix = `bootstrap_${input.sessionId}:`;
    let bootstrapSequence: number | undefined;
    if (proof.inputId.startsWith(bootstrapPrefix)) {
      const sequence = proof.inputId.slice(bootstrapPrefix.length);
      if (!/^(0|[1-9][0-9]*)$/.test(sequence)) return null;
      bootstrapSequence = Number(sequence);
      if (!Number.isSafeInteger(bootstrapSequence) || root.position.revision !== 1 || root.position.index !== bootstrapSequence) return null;
    }
    const rawCas = dialect === "mysql" ? "BINARY document = BINARY ?" : "document = ?";
    const row = await this.client.prepare(`SELECT 1 FROM ${bootstrapSequence === undefined ? "managed_session_events" : "managed_session_initial_events"}
      WHERE workspace_id=? AND session_id=? AND ${bootstrapSequence === undefined ? "id" : "sequence"}=? AND ${rawCas}`)
      .bind(input.workspaceId, input.sessionId, bootstrapSequence ?? proof.inputId, proof.expectedDocument).first();
    if (!row) return null;
    const positions = dialect === "postgres" ? postgresSourcePositionSql : dialect === "mysql"
      ? {revision:"work_input_revision",ordinal:"work_input_index",invalid:"work_input_invalid=1"} : sqliteSourcePositionSql;
    // Use the existing source-position and invalid-position indexes. Unknown
    // facts are never skipped when proving a still-open root.
    if (await this.client.prepare(`SELECT 1 FROM managed_session_events WHERE workspace_id=? AND session_id=? AND ${positions.invalid} LIMIT 1`)
      .bind(input.workspaceId,input.sessionId).first()) return null;
    const rows = await this.client.prepare(`SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? AND ${positions.revision}>=? ORDER BY ${positions.revision},${positions.ordinal} LIMIT 201`)
      .bind(input.workspaceId,input.sessionId,root.position.revision).all<{document:string}>();
    if ((rows.results?.length ?? 0) > 200) return null;
    const facts = [];
    for (const row of rows.results ?? []) {
      const fact = decodeSessionEventDocument(row.document);
      const event: Record<string, unknown> = JSON.parse(row.document);
      if (!fact.position || fact.position.revision > input.expectedRevision) return null;
      if (fact.position.revision === root.position.revision && fact.position.index <= root.position.index) continue;
      if (fact.consumedByExecutionId && fact.consumedByExecutionId !== proof.turnId && runnable(fact.event,event)) return null;
      if (fact.event.type === "session.status_terminated" || fact.event.type === "session.status_idle") {
        if (!fact.executionId) return null;
        if (fact.executionId === proof.turnId && (fact.event.type !== "session.status_idle" || fact.event.stopReason.type !== "requires_action" ||
            fact.environmentWork?.workId !== claim.workId || fact.environmentWork.generation !== claim.generation)) return null;
      }
      facts.push(fact);
    }
    const lane = raw.sessionThreadId ?? "sthr_primary";
    const ownedHistory = facts.filter(fact => fact.executionId === proof.turnId && fact.environmentWork?.workId === claim.workId && fact.environmentWork.generation === claim.generation)
      .map(fact => fact.event as RuntimeProducedSessionEvent);
    if (!validateWorkThreadLineage({rootLane:String(lane),history:ownedHistory,events:input.events})) return null;
    // A child id cannot be rebound from an older/different canonical root even
    // if the caller supplies an otherwise valid new parent tool this turn.
    for (const event of input.events) if (event.type === "session.thread_created") {
      const existing = await this.client.prepare("SELECT 1 FROM managed_session_events WHERE workspace_id=? AND session_id=? AND thread_id=? LIMIT 1")
        .bind(input.workspaceId,input.sessionId,event.sessionThreadId).first();
      if (existing) return null;
    }
    const ownedTools = new Map<string, RuntimeProducedSessionEvent>();
    for (const fact of facts) {
      if (fact.executionId === proof.turnId && fact.environmentWork?.workId === claim.workId && fact.environmentWork.generation === claim.generation &&
          ["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"].includes(fact.event.type)) {
        ownedTools.set(fact.event.id, fact.event as RuntimeProducedSessionEvent);
      }
    }
    const approvals = inspectWorkApprovalResolution({root:proof,
      claim:{workId:claim.workId,generation:claim.generation,holder:consumedClaim.holder},
      documents:(rows.results ?? []).map(row => row.document)});
    if (approvals.type === "invalid") return null;
    const pendingApprovals = new Set(approvals.pendingRequestIds);
    for (const event of input.events) {
      const eventLane = ("sessionThreadId" in event ? event.sessionThreadId : undefined) ?? "sthr_primary";
      // Child approvals are not implicitly granted by parent approval state.
      // Native foreground descendants are supported; child human-review needs
      // its own scoped callback/consumption protocol and remains fail-closed.
      if (eventLane !== lane && (event.type === "agent.tool_use" && event.evaluatedPermission === "ask" || event.type === "agent.custom_tool_use" ||
          event.type === "session.thread_status_idle" && event.stopReason.type === "requires_action" ||
          ["session.status_idle","session.status_running","session.status_rescheduled","session.status_terminated"].includes(event.type))) return null;
      // Ownership is not resolution. Only persisted user inputs consumed under
      // this root/claim can clear requests; runtime status/results cannot.
      if (event.type === "agent.tool_use" && event.evaluatedPermission === "ask" || event.type === "agent.custom_tool_use") pendingApprovals.add(event.id);
      if (event.type === "session.status_running" && pendingApprovals.size > 0) return null;
      if (event.type === "session.status_idle" && event.stopReason.type === "requires_action") {
        const remaining = event.stopReason.eventIds;
        if ([...pendingApprovals].some(id => !remaining.includes(id))) return null;
      }
      // This endpoint attributes running facts/approval pauses, NOT completion.
      if (event.type === "session.status_terminated" || event.type === "session.status_idle" && event.stopReason.type !== "requires_action") return null;
      if (["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"].includes(event.type)) ownedTools.set(event.id, event);
      const toolId = "toolUseId" in event ? event.toolUseId : undefined;
      if (toolId && !ownedTools.has(toolId)) return null;
      if (event.type === "session.status_idle" && event.stopReason.type === "requires_action" && event.stopReason.eventIds.some(id => {
        const tool = ownedTools.get(id);
        return !tool || tool.type === "agent.tool_use" && tool.evaluatedPermission !== "ask";
      })) return null;
    }
    return {holder:consumedClaim.holder,turnId:proof.turnId,inputId:proof.inputId,inputDocument:proof.expectedDocument,bootstrapSequence,dialect};
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
