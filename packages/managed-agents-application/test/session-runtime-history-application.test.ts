import { describe, expect, it } from "vitest";
import type {
  InitialSessionEvent,
  SessionEventView,
} from "../src/index";
import * as applicationModule from "../src/index";

interface RuntimeHistoryApplication {
  loadSessionRuntimeHistory(input: { sessionId: string }): Promise<unknown>;
}

interface RuntimeHistoryApplicationConstructor {
  new (dependencies: {
    workspaceId: string;
    source: {
      load(input: {
        workspaceId: string;
        sessionId: string;
      }): Promise<{
        initialEvents: InitialSessionEvent[];
        events: SessionEventView[];
      } | null>;
    };
  }): RuntimeHistoryApplication;
}

describe("SessionRuntimeHistoryApplicationService", () => {
  it("loads complete runtime history through a tenant-scoped source", async () => {
    const Service = (
      applicationModule as typeof applicationModule & {
        SessionRuntimeHistoryApplicationService?: RuntimeHistoryApplicationConstructor;
      }
    ).SessionRuntimeHistoryApplicationService ?? class {
      async loadSessionRuntimeHistory(): Promise<unknown> {
        return { type: "not_implemented" };
      }
    } as RuntimeHistoryApplicationConstructor;

    const initialEvents: InitialSessionEvent[] = [
      {
        type: "user.message",
        content: [{ type: "text", text: "Initial brief" }],
      },
    ];
    const events: SessionEventView[] = [
      {
        id: "event_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
    ];
    const lookups: object[] = [];
    const service = new Service({
      workspaceId: "workspace_01",
      source: {
        load: async (input) => {
          lookups.push(input);
          return { initialEvents, events };
        },
      },
    });

    const result = await service.loadSessionRuntimeHistory({
      sessionId: "session_01",
    });

    expect(lookups).toEqual([
      { workspaceId: "workspace_01", sessionId: "session_01" },
    ]);
    expect(result).toEqual({ type: "found", initialEvents, events });
  });
});
