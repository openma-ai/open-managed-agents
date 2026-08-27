import type { Environment } from "@open-managed-agents/domain/environments";
import type { Session } from "@open-managed-agents/domain/sessions";

export interface FindSessionExecutionContext {
  workspaceId: string;
  sessionId: string;
}

export interface SessionExecutionContext {
  session: Session;
  environment: Environment;
  revision: number;
}

export interface SessionExecutionContextSourcePort {
  find(
    input: FindSessionExecutionContext,
  ): Promise<SessionExecutionContext | null>;
}
