import type { FileOrigin, Session, SessionExecutionFence, SessionRuntimeHistoryApplicationPort } from "@open-managed-agents/managed-agents-application";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
import { artifactContentHash, publishSessionArtifact } from "./artifacts";
import { applyManagedEventsInPlace, createProjectionState, executionTurnId, type ManagedProjectionEvent } from "./projection";

/** The runtime's view of `/workspace/outputs`. Node reads its sandbox
 * directly; Cloudflare passes these as RPC callbacks into the SessionDO. */
export interface ArtifactOutputSource {
  /** Logical `/workspace/outputs/...` file paths. */
  listPaths(): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
}

export interface OpenAIArtifactPublisherDependencies {
  historyForWorkspace(workspaceId: string): SessionRuntimeHistoryApplicationPort;
  filesForWorkspace(workspaceId: string): FilesApplicationPort;
  /** Agents API environment type of the Session (from its sealed mapping). */
  environmentType(session: Session): Promise<string | null>;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  environmentId(session: Session): string;
  /** Receives one structured record per skipped publication. */
  logger?: Record<"debug" | "info" | "warn", (fields: Record<string, unknown>, message: string) => void>;
}

export interface OpenAIArtifactPublicationInput {
  workspaceId: string;
  session: Session;
  executionFence: SessionExecutionFence;
  outputs: ArtifactOutputSource;
}

export type OpenAIArtifactPublisher = (input: OpenAIArtifactPublicationInput) => Promise<void>;

/** Publication follows terminal persistence, so a copy failure is reported
 * independently and must not change the completed model execution. */
export function withReportedArtifactPublication<I extends { workspaceId: string; session: { id: string }; executionFence: { executionId: string } }>(
  publish: (input: I) => Promise<void>,
  onError: (error: unknown, input: I) => void | Promise<void>,
): (input: I) => Promise<void> {
  return async input => {
    try { await publish(input); }
    catch (error) {
      try { await onError(error, input); }
      catch (reportingError) {
        console.error("Artifact publication error reporter failed", { workspaceId: input.workspaceId, sessionId: input.session.id, executionId: input.executionFence.executionId, error, reportingError });
      }
    }
  };
}

/** Decodes `find ./outputs -type f -print0 | base64` run in `/workspace`. */
export function outputPathsFromManifest(value: string): string[] {
  const encoded = value.replace(/\s/g, "");
  if (encoded.length > 16_777_216 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("Invalid output manifest");
  if (!encoded) return [];
  const paths: string[] = new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))).split("\0");
  if (paths.pop() !== "" || paths.length > 10_000) throw new Error("Invalid output manifest");
  const logical = paths.map(path => {
    if (!path.startsWith("./outputs/") || path.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new Error("Output path escaped /workspace/outputs");
    return `/workspace/${path.slice(2)}`;
  });
  if (new Set(logical).size !== logical.length) throw new Error("Duplicate output path");
  return logical;
}

/** Same lane rule as session-runtime-contract `sessionExecutionLaneId`. */
function laneOf(event: object): string {
  const laneId = "sessionThreadId" in event ? event.sessionThreadId : undefined;
  return typeof laneId === "string" ? laneId : "sthr_primary";
}

/** Publishes into existing Files only after the exact native execution has
 * committed a successful Turn, while it still owns its execution fence.
 * Idempotent: a path already published for the turn, or the same path +
 * content already published by the Session, is skipped. */
export function createOpenAIArtifactPublisher(deps: OpenAIArtifactPublisherDependencies): OpenAIArtifactPublisher {
  // Serialize callback retries within this publisher. Cross-runner ownership
  // remains the existing execution fence; persisted dedupe uses File.origin.
  const pending = new Map<string, Promise<void>>();
  async function publish(input: OpenAIArtifactPublicationInput): Promise<void> {
    const { session, workspaceId, executionFence, outputs } = input;
    if (executionFence.workspaceId !== workspaceId || executionFence.sessionId !== session.id) throw new Error("Artifact execution fence does not belong to this Session");
    const skip = (level: "debug" | "info" | "warn", reason: string, details: Record<string, unknown> = {}): void => {
      deps.logger?.[level]({ op: "openai_agents.artifact_publication_skipped", reason, workspaceId, sessionId: session.id, executionId: executionFence.executionId, ...details }, "Agents API artifact publication skipped");
    };
    const environmentType = await deps.environmentType(session);
    if (environmentType !== "openai_hosted") return skip("debug", "environment_not_openai_hosted", { environmentType });
    const found = await deps.historyForWorkspace(workspaceId).loadSessionRuntimeHistory({ sessionId: session.id });
    if (found.type !== "found") return skip("warn", "history_not_found", { historyResult: found.type });
    if (!found.orderedEvents) return skip("warn", "history_unordered");
    const createdAt = Math.floor(Date.parse(session.createdAt) / 1000);
    const bootstrapEvents = found.initialEvents.map((event, index) => ({ ...event, id: `bootstrap_${session.id}:${index}` }));
    // An execution id is the id of the first event of its lane batch
    // (`sessionExecutionEventBatches`), so that event names the execution's
    // lane. Subagent executions never own root outputs, whatever root-lane
    // facts they also commit.
    const source = [...bootstrapEvents, ...found.orderedEvents.map(row => row.event)].find(event => event.id === executionFence.executionId);
    const laneId = source ? laneOf(source) : null;
    if (laneId !== null && laneId !== "sthr_primary") return skip("info", "execution_not_root_lane", { laneId });
    let state = createProjectionState({ sessionId: session.id, agentId: session.agent.id, createdAt });
    if (!found.orderedInitialEvents) state = applyManagedEventsInPlace(state, bootstrapEvents, { observedAt: createdAt }).state;
    const completedByExecution = new Set<string>();
    for (const row of [...(found.orderedInitialEvents ?? []), ...found.orderedEvents]) {
      const result = applyManagedEventsInPlace(state, [row.event as ManagedProjectionEvent], { observedAt: createdAt, executionId: row.executionId, consumedByExecutionId: row.consumedByExecutionId });
      state = result.state;
      if (row.executionId === executionFence.executionId) for (const event of result.events) {
        if (event.type === "agent.session.turn.completed") completedByExecution.add(event.turn_id);
      }
    }
    const turnId = executionTurnId(state, "root", executionFence.executionId);
    if (!turnId) return skip("warn", "execution_turn_not_found");
    const turn = state.turns[turnId];
    if (turn?.status !== "completed") return skip("info", "turn_not_completed", { turnId, turnStatus: turn?.status ?? null });
    if (!completedByExecution.has(turnId)) return skip("info", "turn_not_completed_by_execution", { turnId });
    const environmentId = deps.environmentId(session);
    const assertFence = async () => { if (!await deps.isFenceActive(executionFence)) throw new Error("Artifact publication lost the execution fence"); };
    const requireCompletedTurn = async (origin: FileOrigin) => {
      if (origin.sessionId !== session.id || origin.environmentId !== environmentId || origin.turnId !== turnId || !completedByExecution.has(origin.turnId)) throw new Error("Artifact origin does not match the completed execution");
      await assertFence();
    };
    await assertFence();
    const files = deps.filesForWorkspace(workspaceId);
    // A completed turn's publication remains immutable on callback retries.
    // Across turns, identity is session + path + content, loaded from Files
    // on every invocation so process restarts do not reset deduplication.
    const publishedPaths = new Set<string>();
    const publishedContent = new Set<string>();
    const contentKey = (path: string, hash: string) => JSON.stringify([path, hash]);
    const cursors = new Set<string>();
    let afterId: string | undefined;
    for (;;) {
      const page = await files.listFiles({ scopeId: session.id, pageSize: 100, ...(afterId && { afterId }) });
      if (page.type !== "page") throw new Error(page.message);
      for (const file of page.page.files) {
        const origin = file.origin;
        if (file.scope?.type !== "session" || file.scope.id !== session.id || origin?.type !== "session_output" || origin.sessionId !== session.id) continue;
        if (origin.environmentId === environmentId && origin.turnId === turnId) publishedPaths.add(origin.path);
        let hash = origin.contentSha256;
        if (!hash) {
          const legacy = await files.downloadFile({ fileId: file.id });
          if (legacy.type !== "found") throw new Error("Published artifact content is missing");
          hash = await artifactContentHash(legacy.file.content);
        }
        publishedContent.add(contentKey(origin.path, hash));
      }
      if (!page.page.hasMore) break;
      const next = page.page.lastId;
      if (!next || cursors.has(next)) throw new Error("Invalid File pagination cursor");
      cursors.add(next); afterId = next;
    }
    let totalBytes = 0;
    for (const path of await outputs.listPaths()) {
      if (publishedPaths.has(path)) continue;
      await assertFence();
      const content = await outputs.read(path);
      totalBytes += content.byteLength;
      if (totalBytes > 10 * 1024 * 1024 * 1024) throw new Error("Session output byte limit exceeded");
      const key = contentKey(path, await artifactContentHash(content));
      if (publishedContent.has(key)) continue;
      await publishSessionArtifact({ files, requireCompletedTurn }, { sessionId: session.id, environmentId, turnId, path, mimeType: "application/octet-stream", content });
      publishedPaths.add(path);
      publishedContent.add(key);
    }
  }
  return input => {
    const key = JSON.stringify([input.workspaceId, input.session.id]);
    const work = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => publish(input));
    pending.set(key, work);
    return work.finally(() => { if (pending.get(key) === work) pending.delete(key); });
  };
}
