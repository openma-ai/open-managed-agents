import type { Session, SessionRuntimeHistoryApplicationPort } from "@open-managed-agents/managed-agents-application";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
import type { Logger } from "@open-managed-agents/observability";
import { createOpenAIArtifactPublisher, outputPathsFromManifest, readManagedSessionMappingMetadata, type ResourceSecretSealer } from "@open-managed-agents/openai-agents-compat";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { DefaultNodeManagedSessionRunnerDependencies } from "./lib/node-managed-session-runner";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { hasProcessInvariantFailure } from "./lib/process-invariant";

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
export interface ReadOnlyArtifactPublicationInput {
  workspaceId: string;
  session: Session;
  executionFence: SessionExecutionFence;
  outputs: { listPaths(): Promise<string[]>; read(path: string): Promise<Uint8Array> };
  /** Must wrap each non-idempotent Files write, including its response. */
  write<T>(operation: () => Promise<T>): Promise<T>;
}

/** Publication follows terminal persistence, so a copy failure is reported
 * independently and must not change the completed model execution. */
export function withReportedArtifactPublication<I extends { workspaceId: string; session: { id: string }; executionFence: { executionId: string } }>(publish: (input: I) => Promise<void>, onError: (error: unknown, input: I) => void | Promise<void>): (input: I) => Promise<void> {
  return async input => {
    try { await publish(input); }
    catch (error) {
      // The attempt owner must see this explicit process-fatal evidence even
      // though ordinary artifact-copy failures leave the completed turn alone.
      if (hasProcessInvariantFailure(error)) throw error;
      try { await onError(error, input); }
      catch (reportingError) {
        if (hasProcessInvariantFailure(reportingError)) throw reportingError;
        console.error("Artifact publication error reporter failed", {
          workspaceId: input.workspaceId, sessionId: input.session.id,
          executionId: input.executionFence.executionId, error, reportingError,
        });
      }
    }
  };
}

/** Node binding of the shared Agents API artifact publisher: outputs are
 * read straight from the execution's sandbox `/workspace/outputs`. */
export function createNodeReadOnlyArtifactPublisher(deps: NodeOpenAIArtifactPublisherDependencies): (input: ReadOnlyArtifactPublicationInput) => Promise<void> {
  const pending = new Map<string, Promise<void>>();
  const publish = (input: ReadOnlyArtifactPublicationInput) => createOpenAIArtifactPublisher({
    historyForWorkspace: deps.historyForWorkspace,
    filesForWorkspace: workspaceId => {
      const files = deps.filesForWorkspace(workspaceId);
      return new Proxy(files, { get(target, property) {
        if (property === "uploadFile") return (command: Parameters<FilesApplicationPort["uploadFile"]>[0]) => input.write(() => files.uploadFile(command));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    environmentType: async session => (await readManagedSessionMappingMetadata(session, deps.secrets))?.environment.type ?? null,
    isFenceActive: deps.isFenceActive,
    environmentId: deps.environmentId,
    ...(deps.logger && { logger: deps.logger as NonNullable<Parameters<typeof createOpenAIArtifactPublisher>[0]["logger"]> }),
  })(input);
  return input => {
    const key = JSON.stringify([input.workspaceId, input.session.id]);
    const work = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => publish(input));
    pending.set(key, work);
    return work.finally(() => { if (pending.get(key) === work) pending.delete(key); });
  };
}

/** Only this fixed manifest command and binary reads reach the sandbox. The
 * publication callback gets no command, mutation or lifecycle capability. */
export function readOnlyArtifactOutputs(sandbox: SandboxExecutor): ReadOnlyArtifactPublicationInput["outputs"] {
  return {
      listPaths: async () => {
        if (!sandbox.readFileBytes) throw new Error("Sandbox cannot publish binary /workspace outputs");
        return outputPathsFromManifest(await sandbox.exec('cd /workspace && if test -d ./outputs; then find ./outputs -type f -print0 | base64; fi'));
      },
      read: path => {
        if (!path.startsWith("/workspace/outputs/") || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".")) throw new Error("Artifact read escaped /workspace/outputs");
        return sandbox.readFileBytes!(path);
      },
  };
}

/** Compatibility adapter for standalone publishers without a dispatch ledger. */
export function createNodeOpenAIArtifactPublisher(deps: NodeOpenAIArtifactPublisherDependencies): AfterExecution {
  const publish = createNodeReadOnlyArtifactPublisher(deps);
  return input => publish({ ...input, outputs: readOnlyArtifactOutputs(input.sandbox), write: operation => operation() });
}
