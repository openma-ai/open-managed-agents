import type { Environment } from "@open-managed-agents/domain/environments";
import type {
  Session,
  SessionBootstrapEvent,
} from "@open-managed-agents/domain/sessions";

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
