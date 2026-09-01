import type {
  LoadSessionRuntimeHistoryQuery,
  LoadSessionRuntimeHistoryResult,
  SessionRuntimeHistoryApplicationPort,
} from "./port";
import type {
  SessionRuntimeHistorySourcePort,
} from "@open-managed-agents/session-runtime-contract/history";

export interface SessionRuntimeHistoryApplicationServiceDependencies {
  workspaceId: string;
  source: SessionRuntimeHistorySourcePort;
}

export class SessionRuntimeHistoryApplicationService
  implements SessionRuntimeHistoryApplicationPort
{
  constructor(
    private readonly dependencies: SessionRuntimeHistoryApplicationServiceDependencies,
  ) {}

  async loadSessionRuntimeHistory(
    query: LoadSessionRuntimeHistoryQuery,
  ): Promise<LoadSessionRuntimeHistoryResult> {
    const history = await this.dependencies.source.load({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    return history === null
      ? { type: "not_found" }
      : { type: "found", ...history };
  }
}
