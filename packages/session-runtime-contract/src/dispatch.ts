import type { Environment } from "@open-managed-agents/domain/environments";
import type {
  SentSessionEvent,
  Session,
} from "@open-managed-agents/domain/sessions";

export interface AcceptedSessionEvents {
  workspaceId: string;
  sessionId: string;
  session: Session;
  environment: Environment;
  events: SentSessionEvent[];
}

export interface SessionEventDispatchPort {
  sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void>;
  /** Recover only durable interrupt control effects, never replay turn dispatch. */
  reconcileAcceptedInterrupts?(input: AcceptedSessionEvents & { acceptedAt: string }): Promise<void>;
}
