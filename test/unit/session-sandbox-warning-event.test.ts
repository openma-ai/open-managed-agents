import { describe, expect, it } from "vitest";

import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { sessionEventPageResponseSchema } from "../../packages/managed-agents-api/src/contracts/session-events";
import { toSessionEventResponse } from "../../packages/managed-agents-api/src/mappers/session-events";
import { sessionSandboxWarningEvent } from "@open-managed-agents/session-runtime";

// The Session sandbox reports "workspace_restored backup_id=..." when a turn
// resumes a Cloudflare container that stopped while idle. SessionDO stored it
// as a session.warning without `source`; GET /v1/sessions/:id/events then
// failed the whole page with a 500 (e2e core / vault / fence after 330s idle).
const listedPage = (raw: object) => {
  const decoded = decodeRuntimeProducedSessionEvent({
    ...raw,
    id: "sevt_warn",
    processed_at: "2026-11-09T03:03:32.299Z",
  });
  expect(decoded).not.toBeNull();
  return sessionEventPageResponseSchema.safeParse({ data: [toSessionEventResponse(decoded!)], next_page: null });
};

describe("Session sandbox warning event", () => {
  it("is listed by GET /v1/sessions/:id/events", () => {
    const event = sessionSandboxWarningEvent("workspace_restored backup_id=b1 elapsed_ms=3752");
    expect(event).toEqual({
      type: "session.warning",
      source: "oma.session_sandbox",
      message: "workspace_restored backup_id=b1 elapsed_ms=3752",
    });
    expect(listedPage(event).success).toBe(true);
  });

  it("a warning without source fails the events page (the old SessionDO shape)", () => {
    expect(listedPage({ type: "session.warning", message: "workspace_restored backup_id=b1" }).success).toBe(false);
  });
});
