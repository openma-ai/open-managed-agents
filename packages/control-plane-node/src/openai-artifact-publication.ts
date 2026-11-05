import type { FileOrigin, Session, SessionRuntimeHistoryApplicationPort } from "@open-managed-agents/managed-agents-application";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
import type { Logger } from "@open-managed-agents/observability";
import { applyManagedEventsInPlace, createProjectionState, executionTurnId, publishSessionArtifact, artifactContentHash, readManagedSessionMappingMetadata, type ManagedProjectionEvent, type ResourceSecretSealer } from "@open-managed-agents/openai-agents-compat";
import { sessionExecutionLaneId, type SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { DefaultNodeManagedSessionRunnerDependencies } from "./lib/node-managed-session-runner";

export interface NodeOpenAIArtifactPublisherDependencies {
  historyForWorkspace(workspaceId: string): SessionRuntimeHistoryApplicationPort;
  filesForWorkspace(workspaceId: string): FilesApplicationPort;
  secrets: ResourceSecretSealer;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  environmentId(session: Session): string;
  /** Receives one structured record per skipped publication. */
  logger?: Pick<Logger, "debug" | "info" | "warn">;
}
type AfterExecution = NonNullable<DefaultNodeManagedSessionRunnerDependencies["afterExecution"]>;
type PublicationInput = Parameters<AfterExecution>[0];

/** Publication follows terminal persistence, so a copy failure is reported
 * independently and must not change the completed model execution. */
export function withReportedArtifactPublication(publish: AfterExecution, onError: (error: unknown, input: PublicationInput) => void | Promise<void>): AfterExecution {
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

function pathsFromManifest(value: string): string[] {
  const encoded = value.replace(/\s/g, "");
  if (encoded.length > 16_777_216 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("Invalid output manifest");
  if (!encoded) return [];
  const paths: string[] = Buffer.from(encoded, "base64").toString("utf8").split("\0");
  if (paths.pop() !== "" || paths.length > 10_000) throw new Error("Invalid output manifest");
  const logical = paths.map(path => {
    if (!path.startsWith("./outputs/") || path.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new Error("Output path escaped /workspace/outputs");
    return `/workspace/${path.slice(2)}`;
  });
  if (new Set(logical).size !== logical.length) throw new Error("Duplicate output path");
  return logical;
}

/** Publishes into existing Files only after the exact native execution has
 * committed a successful Turn. No independent resource or runtime state. */
export function createNodeOpenAIArtifactPublisher(deps: NodeOpenAIArtifactPublisherDependencies): AfterExecution {
  // Serialize callback retries within this runner. Cross-runner ownership
  // remains the existing execution fence; persisted dedupe uses File.origin.
  const pending = new Map<string, Promise<void>>();
  async function publish(input: PublicationInput): Promise<void> {
    const { session, workspaceId, executionFence, sandbox } = input;
    if (executionFence.workspaceId !== workspaceId || executionFence.sessionId !== session.id) throw new Error("Artifact execution fence does not belong to this Session");
    const skip = (level: "debug" | "info" | "warn", reason: string, details: Record<string, unknown> = {}): void => {
      deps.logger?.[level]({ op: "main-node.openai_agents.artifact_publication_skipped", reason, workspaceId, sessionId: session.id, executionId: executionFence.executionId, ...details }, "Agents API artifact publication skipped");
    };
    const saved = await readManagedSessionMappingMetadata(session, deps.secrets);
    if (saved?.environment.type !== "openai_hosted") return skip("debug", "environment_not_openai_hosted", { environmentType: saved?.environment.type ?? null });
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
    const laneId = source ? sessionExecutionLaneId(source) : null;
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
    if (!sandbox.setEnvVars || !sandbox.readFileBytes) throw new Error("Sandbox cannot publish binary /workspace outputs");
    await sandbox.setEnvVars({ OMA_OPENAI_WORKSPACE_DIR: "/workspace" });
    const manifest = await sandbox.exec('cd "$OMA_OPENAI_WORKSPACE_DIR" && if test -d ./outputs; then find ./outputs -type f -print0 | base64; fi');
    let totalBytes = 0;
    for (const path of pathsFromManifest(manifest)) {
      if (publishedPaths.has(path)) continue;
      await assertFence();
      const content = await sandbox.readFileBytes(path);
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
