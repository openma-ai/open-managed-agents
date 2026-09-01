import {
  SessionsApplicationService,
  type DeploymentSessionLauncherPort,
  type SessionAgentSourcePort,
  type SessionEnvironmentSourcePort,
  type SessionResourceResolverPort,
} from "@open-managed-agents/managed-agents-application";
import type {
  SessionLifecycleCommandPort,
} from "@open-managed-agents/session-runtime-contract/lifecycle";
import type { SessionStore } from "@open-managed-agents/session-store";

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

export const sessionStorePort = createPortToken<SessionStore>(
  "managed-agents.store.sessions",
);

export const sessionAgentSourcePort = createPortToken<SessionAgentSourcePort>(
  "managed-agents.outbound.sessions.agents",
);

export const sessionEnvironmentSourcePort =
  createPortToken<SessionEnvironmentSourcePort>(
    "managed-agents.outbound.sessions.environments",
  );

export const sessionResourceResolverPort =
  createPortToken<SessionResourceResolverPort>(
    "managed-agents.outbound.sessions.resources",
  );

export const sessionLifecyclePort =
  createPortToken<SessionLifecycleCommandPort>(
    "managed-agents.outbound.sessions.lifecycle",
  );

export const deploymentSessionLauncherPort =
  createPortToken<DeploymentSessionLauncherPort>(
    "managed-agents.application.deployment-session-launcher",
  );

export function sessionsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:sessions",
    provides: [
      managedAgentsPortTokens.sessions,
      deploymentSessionLauncherPort,
    ],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      sessionStorePort,
      sessionAgentSourcePort,
      sessionEnvironmentSourcePort,
      sessionResourceResolverPort,
      sessionLifecyclePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const clock = port(clockPort);
      const ids = port(idGeneratorPort);
      const service = new SessionsApplicationService({
        workspaceId: workspace.workspaceId,
        clock,
        ids: { nextSessionId: () => ids.next("session") },
        store: port(sessionStorePort),
        agents: port(sessionAgentSourcePort),
        environments: port(sessionEnvironmentSourcePort),
        resources: port(sessionResourceResolverPort),
        lifecycle: port(sessionLifecyclePort),
      });
      return {
        ports: [
          bindPort(managedAgentsPortTokens.sessions, service),
          bindPort(deploymentSessionLauncherPort, service),
        ],
      };
    },
  });
}
