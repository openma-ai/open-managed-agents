import {
  SessionEventsApplicationService,
  type SessionSourcePort,
  type WorkOutcomeInterruptPort,
  type SessionWorkAdmissionPort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import type {
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type {
  SessionEventStreamPort,
} from "@open-managed-agents/session-runtime-contract/stream";

import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const sessionWorkAdmissionPort = createPortToken<SessionWorkAdmissionPort>(
  "managed-agents.outbound.session-events.work-admission",
);

export const sessionEventStorePort = createPortToken<SessionEventLogStore>(
  "managed-agents.store.session-events",
);

export const sessionEventSourcePort = createPortToken<SessionSourcePort>(
  "managed-agents.outbound.session-events.sessions",
);

export const sessionEventExecutionContextSourcePort =
  createPortToken<SessionExecutionContextSourcePort>(
    "managed-agents.outbound.session-events.execution-context",
  );

export const sessionEventStreamPort = createPortToken<SessionEventStreamPort>(
  "managed-agents.outbound.session-events.stream",
);

export const sessionEventDispatchPort =
  createPortToken<SessionEventDispatchPort>(
    "managed-agents.outbound.session-events.dispatch",
  );

export function sessionEventsModule(options: { workOutcomeInterrupt?: WorkOutcomeInterruptPort; schedulingRecovery?: { recoverSessionScheduling(input: { sessionId: string }): Promise<unknown> } } = {}): AppModule {
  return defineAppModule({
    name: "managed-agents:session-events",
    provides: [managedAgentsPortTokens.sessionEvents],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      sessionEventStorePort,
      sessionEventSourcePort,
      sessionEventExecutionContextSourcePort,
      sessionEventStreamPort,
      sessionEventDispatchPort,
      sessionWorkAdmissionPort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const clock = port(clockPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.sessionEvents,
          new SessionEventsApplicationService({
            workspaceId: workspace.workspaceId,
            schedulingRecovery: options.schedulingRecovery,
            workOutcomeInterrupt: options.workOutcomeInterrupt,
            store: port(sessionEventStorePort),
            sessions: port(sessionEventSourcePort),
            execution: port(sessionEventExecutionContextSourcePort),
            stream: port(sessionEventStreamPort),
            dispatch: port(sessionEventDispatchPort),
            workAdmission: port(sessionWorkAdmissionPort),
            clock,
            ids: {
              nextEventId: () => ids.next("session-event"),
              nextOutcomeId: () => ids.next("outcome"),
            },
          }),
        )],
      };
    },
  });
}
