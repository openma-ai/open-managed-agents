import type { Session, SessionRuntimeHistoryApplicationPort } from "@open-managed-agents/managed-agents-application";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
import type { Logger } from "@open-managed-agents/observability";
import { artifactContentHash, publishSessionArtifact, applyManagedEventsInPlace, createProjectionState, executionTurnId, type ManagedProjectionEvent, createOpenAIArtifactPublisher, outputPathsFromManifest, readManagedSessionMappingMetadata, withReportedArtifactPublication as reportPublication, type ResourceSecretSealer } from "@open-managed-agents/openai-agents-compat";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
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
  return reportPublication(publish, onError);
}

/** Node binding of the shared Agents API artifact publisher: outputs are
 * read straight from the execution's sandbox `/workspace/outputs`. */
export function createNodeOpenAIArtifactPublisher(deps: NodeOpenAIArtifactPublisherDependencies): AfterExecution {
  const publish = createOpenAIArtifactPublisher({
    historyForWorkspace: deps.historyForWorkspace,
    filesForWorkspace: deps.filesForWorkspace,
    environmentType: async session => (await readManagedSessionMappingMetadata(session, deps.secrets))?.environment.type ?? null,
    isFenceActive: deps.isFenceActive,
    environmentId: deps.environmentId,
    ...(deps.logger && { logger: deps.logger as NonNullable<Parameters<typeof createOpenAIArtifactPublisher>[0]["logger"]> }),
  });
  return ({ workspaceId, session, executionFence, sandbox }) => publish({
    workspaceId, session, executionFence,
    outputs: {
      listPaths: async () => {
        if (!sandbox.setEnvVars || !sandbox.readFileBytes) throw new Error("Sandbox cannot publish binary /workspace outputs");
        await sandbox.setEnvVars({ OMA_OPENAI_WORKSPACE_DIR: "/workspace" });
        return outputPathsFromManifest(await sandbox.exec('cd "$OMA_OPENAI_WORKSPACE_DIR" && if test -d ./outputs; then find ./outputs -type f -print0 | base64; fi'));
      },
      read: path => sandbox.readFileBytes!(path),
    },
  });
}

/** Work afterExecution uses the same projection, Files provenance and content
 * dedupe as the MA publisher, but its authority is the actual Work claim. Never
 * coerce a Work generation into a SessionExecutionFence. */
export function createNodeWorkArtifactPublisher(deps: Omit<NodeOpenAIArtifactPublisherDependencies, "isFenceActive">) {
  const pending = new Map<string, Promise<void>>();
  async function publish(input: import("./lib/node-session-sandbox.js").NodeWorkStorageInput & {
    terminal: import("@open-managed-agents/managed-agents-application").WorkTerminalReceipt;
    isCurrent(): Promise<boolean>;
  }): Promise<void> {
    const {workspaceId, session, sandbox, terminal} = input;
    const assertCurrent = async () => { if (!await input.isCurrent()) throw new Error("Artifact publication lost Work authority"); };
    await assertCurrent();
    const mapping = await readManagedSessionMappingMetadata(session, deps.secrets);
    if (mapping?.environment.type !== "openai_hosted") return;
    // Preserve parked/exhausted outcomes: they never become successful artifacts.
    if (terminal.stopReason.type !== "end_turn") return;
    const found = await deps.historyForWorkspace(workspaceId).loadSessionRuntimeHistory({sessionId:session.id});
    if (found.type !== "found" || !found.orderedEvents) throw new Error("Ordered artifact history is unavailable");
    const createdAt = Math.floor(Date.parse(session.createdAt) / 1000);
    let state = createProjectionState({sessionId:session.id,agentId:session.agent.id,createdAt});
    if (!found.orderedInitialEvents) state = applyManagedEventsInPlace(state,
      found.initialEvents.map((event,index) => ({...event,id:`bootstrap_${session.id}:${index}`})), {observedAt:createdAt}).state;
    const completed = new Set<string>();
    for (const row of [...(found.orderedInitialEvents ?? []), ...found.orderedEvents]) {
      const result = applyManagedEventsInPlace(state, [row.event as ManagedProjectionEvent],
        {observedAt:createdAt,executionId:row.executionId,consumedByExecutionId:row.consumedByExecutionId});
      state = result.state;
      if (row.event.id === terminal.eventId && row.executionId === terminal.turnId) {
        for (const event of result.events) if (event.type === "agent.session.turn.completed") completed.add(event.turn_id);
      }
    }
    const turnId = executionTurnId(state,"root",terminal.turnId);
    if (!turnId || state.turns[turnId]?.status !== "completed" || !completed.has(turnId)) throw new Error("Work terminal did not complete the artifact turn");
    const files = deps.filesForWorkspace(workspaceId);
    const environmentId = deps.environmentId(session);
    const paths = new Set<string>(); const content = new Set<string>(); const cursors = new Set<string>();
    let afterId: string | undefined;
    for (;;) {
      const page = await files.listFiles({scopeId:session.id,pageSize:100,...(afterId ? {afterId} : {})});
      if (page.type !== "page") throw new Error(page.message);
      for (const file of page.page.files) {
        const origin = file.origin;
        if (file.scope?.type !== "session" || file.scope.id !== session.id || origin?.type !== "session_output" || origin.sessionId !== session.id) continue;
        if (origin.environmentId === environmentId && origin.turnId === turnId) paths.add(origin.path);
        let hash = origin.contentSha256;
        if (!hash) {
          const old = await files.downloadFile({fileId:file.id});
          if (old.type !== "found") throw new Error("Published artifact content is missing");
          hash = await artifactContentHash(old.file.content);
        }
        content.add(JSON.stringify([origin.path,hash]));
      }
      if (!page.page.hasMore) break;
      const next = page.page.lastId;
      if (!next || cursors.has(next)) throw new Error("Invalid File pagination cursor");
      cursors.add(next); afterId = next;
    }
    await assertCurrent();
    if (!sandbox.setEnvVars || !sandbox.readFileBytes) throw new Error("Sandbox cannot publish binary /workspace outputs");
    await sandbox.setEnvVars({OMA_OPENAI_WORKSPACE_DIR:await sandbox.resolveWorkspaceRoot?.() ?? "/workspace"});
    const manifest = await sandbox.exec('cd "$OMA_OPENAI_WORKSPACE_DIR" && if test -d ./outputs; then find ./outputs -type f -print0 | base64; fi');
    let totalBytes = 0;
    for (const path of outputPathsFromManifest(manifest)) {
      if (paths.has(path)) continue;
      await assertCurrent();
      const bytes = await sandbox.readFileBytes(path);
      totalBytes += bytes.byteLength;
      if (totalBytes > 10 * 1024 * 1024 * 1024) throw new Error("Session output byte limit exceeded");
      const key = JSON.stringify([path,await artifactContentHash(bytes)]);
      if (content.has(key)) continue;
      await publishSessionArtifact({files,requireCompletedTurn:async origin => {
        if (origin.sessionId !== session.id || origin.environmentId !== environmentId || origin.turnId !== turnId) throw new Error("Artifact origin mismatch");
        await assertCurrent();
      }}, {sessionId:session.id,environmentId,turnId,path,mimeType:"application/octet-stream",content:bytes});
      paths.add(path); content.add(key);
    }
    await assertCurrent();
  }
  return (input: Parameters<typeof publish>[0]): Promise<void> => {
    const key = JSON.stringify([input.workspaceId,input.session.id]);
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => publish(input));
    pending.set(key,next);
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
  };
}
