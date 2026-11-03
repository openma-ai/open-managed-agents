import type { Environment } from "../domain/environments/index.js";
import type { Session } from "../domain/sessions/index.js";

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
