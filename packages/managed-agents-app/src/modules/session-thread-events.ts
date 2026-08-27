import {
  SessionThreadEventsApplicationService,
  type SessionThreadEventStreamPort,
  type SessionThreadSourcePort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionThreadEventStore } from "@open-managed-agents/session-event-store";

import { workspaceContextPort } from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const sessionThreadEventThreadSourcePort =
  createPortToken<SessionThreadSourcePort>(
    "managed-agents.outbound.session-thread-events.threads",
  );

export const sessionThreadEventStorePort =
  createPortToken<SessionThreadEventStore>(
    "managed-agents.outbound.session-thread-events.store",
  );

/** @deprecated Use `sessionThreadEventStorePort`. */
export const sessionThreadEventPersistencePort = sessionThreadEventStorePort;

export const sessionThreadEventStreamPort =
  createPortToken<SessionThreadEventStreamPort>(
    "managed-agents.outbound.session-thread-events.stream",
  );

export function sessionThreadEventsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:session-thread-events",
    provides: [managedAgentsPortTokens.sessionThreadEvents],
    requires: [
      workspaceContextPort,
      sessionThreadEventThreadSourcePort,
      sessionThreadEventStorePort,
      sessionThreadEventStreamPort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.sessionThreadEvents,
          new SessionThreadEventsApplicationService({
            workspaceId: workspace.workspaceId,
            threads: port(sessionThreadEventThreadSourcePort),
            store: port(sessionThreadEventStorePort),
            stream: port(sessionThreadEventStreamPort),
          }),
        )],
      };
    },
  });
}
