import type { Environment } from "../domain/environments/index.js";
import type {
  SentSessionEvent,
  Session,
} from "../domain/sessions/index.js";

export interface AcceptedSessionEvents {
  workspaceId: string;
  sessionId: string;
  session: Session;
  environment: Environment;
  events: SentSessionEvent[];
}

export interface SessionEventDispatchPort {
  sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void>;
}
