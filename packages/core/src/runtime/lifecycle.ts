import type { Environment } from "../domain/environments/index.js";
import type {
  Session,
  SessionBootstrapEvent,
} from "../domain/sessions/index.js";

export interface SessionExecutionLocation {
  workspaceId: string;
  sessionId: string;
}

export interface StartSessionExecution extends SessionExecutionLocation {
  session: Session;
  environment: Environment;
  initialEvents: SessionBootstrapEvent[];
}

export interface StopSessionExecution extends SessionExecutionLocation {
  session: Session;
  reason: "archived" | "deleted";
}

export interface SessionLifecycleCommandPort {
  sessionStarted(input: StartSessionExecution): Promise<void>;
  sessionStopped(input: StopSessionExecution): Promise<void>;
}
