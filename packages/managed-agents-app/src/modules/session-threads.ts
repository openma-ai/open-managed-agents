import {
  SessionThreadsApplicationService,
  type SessionSourcePort,
  type SessionThreadLifecycleCommandPort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionThreadStore } from "@open-managed-agents/session-thread-store";

import { clockPort, workspaceContextPort } from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const sessionThreadSessionSourcePort =
  createPortToken<SessionSourcePort>(
    "managed-agents.outbound.session-threads.sessions",
  );

export const sessionThreadStorePort =
  createPortToken<SessionThreadStore>(
    "managed-agents.outbound.session-threads.store",
  );

/** @deprecated Use `sessionThreadStorePort`. */
export const sessionThreadPersistencePort = sessionThreadStorePort;

export const sessionThreadLifecyclePort =
  createPortToken<SessionThreadLifecycleCommandPort>(
    "managed-agents.outbound.session-threads.lifecycle",
  );

export function sessionThreadsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:session-threads",
    provides: [managedAgentsPortTokens.sessionThreads],
    requires: [
      workspaceContextPort,
      clockPort,
      sessionThreadSessionSourcePort,
      sessionThreadStorePort,
      sessionThreadLifecyclePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.sessionThreads,
          new SessionThreadsApplicationService({
            workspaceId: workspace.workspaceId,
            sessions: port(sessionThreadSessionSourcePort),
            store: port(sessionThreadStorePort),
            lifecycle: port(sessionThreadLifecyclePort),
            clock: port(clockPort),
          }),
        )],
      };
    },
  });
}
