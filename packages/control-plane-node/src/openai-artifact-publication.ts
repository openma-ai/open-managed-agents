import type { Session, SessionRuntimeHistoryApplicationPort } from "@open-managed-agents/managed-agents-application";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
import type { Logger } from "@open-managed-agents/observability";
import { createOpenAIArtifactPublisher, outputPathsFromManifest, readManagedSessionMappingMetadata, withReportedArtifactPublication as reportPublication, type ResourceSecretSealer } from "@open-managed-agents/openai-agents-compat";
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
