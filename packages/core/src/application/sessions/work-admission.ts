/**
 * Generic admission hook for work on an existing Session.
 *
 * Hosts may refuse a new turn, a session-thread (sub-agent) start, or a
 * hosted model request before any event is persisted or any runtime work
 * starts. OSS carries no policy here: the default admits everything, and a
 * denial's HTTP status and body come verbatim from the host hook.
 */

export type SessionWorkKind = "turn" | "thread_start" | "model_request";

export interface SessionWorkAdmissionInput {
  kind: SessionWorkKind;
  workspaceId: string;
  sessionId?: string;
  agentId?: string;
  environmentId?: string;
  /** Local-runtime / self-hosted work. Passed through; hooks decide. */
  isLocalRuntime: boolean;
}

export type SessionWorkAdmissionDecision =
  | { type: "allowed" }
  | { type: "denied"; status: number; body: unknown };

export interface SessionWorkAdmissionPort {
  admit(input: SessionWorkAdmissionInput): Promise<SessionWorkAdmissionDecision>;
}
