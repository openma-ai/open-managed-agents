import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { sessionSandboxWarningEvent } from "@open-managed-agents/session-runtime";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SessionRuntimeProjectionApplicationService } from "@open-managed-agents/managed-agents-application";
import { SqlSessionRuntimeProjectionPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import type { NodeSessionSandboxContext } from "./node-session-sandbox";

/** Persist sandbox warnings as Session events, including outside a turn. */
export function nodeSessionSandboxWarning(sql: SqlClient, logger: { warn(fields: Record<string, unknown>, message: string): void }, dialect: "sqlite" | "postgres" | "mysql" = "sqlite") {
  return async (message: string, { workspaceId, session }: NodeSessionSandboxContext): Promise<void> => {
    logger.warn({ op: "main-node.session_sandbox", workspaceId, sessionId: session.id }, message);
    try {
      const event = decodeRuntimeProducedSessionEvent({ ...sessionSandboxWarningEvent(message), id: `sevt_${nanoid()}`, processed_at: new Date().toISOString() });
      if (event === null) throw new Error("Sandbox warning event could not be decoded");
      const projection = new SessionRuntimeProjectionApplicationService({ workspaceId, persistence: new SqlSessionRuntimeProjectionPersistence(sql, { dialect }) });
      const result = await projection.recordSessionRuntimeEvents({ sessionId: session.id, events: [event] });
      if (result.type !== "recorded" && result.type !== "not_found") {
        logger.warn({ op: "main-node.session_sandbox.warning", result: result.type }, "sandbox warning could not be persisted");
      }
    } catch (error) {
      logger.warn({ op: "main-node.session_sandbox.warning", error }, "sandbox warning persistence failed");
    }
  };
}
