// A Session sandbox `warn` message (PortsSessionSandboxOptions.warn) as the
// session.warning a host records in the event log.

import type { SessionWarningEvent } from "@open-managed-agents/shared";

/** e.g. "workspace_restored backup_id=..." when a turn resumes a container
 * that stopped while idle. `source` is required: GET /v1/sessions/:id/events
 * rejects the whole page without it. */
export function sessionSandboxWarningEvent(message: string): SessionWarningEvent {
  return { type: "session.warning", source: "oma.session_sandbox", message };
}
