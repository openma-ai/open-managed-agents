import type { ManagedAgentsApplicationPorts } from "@open-managed-agents/managed-agents-application/ports";

import {
  bindPort,
  createApp,
  createPortToken,
  defineAppModule,
  type App,
  type AppModule,
  type PortToken,
} from "./index";

type ManagedAgentsPortTokens = {
  [Name in keyof ManagedAgentsApplicationPorts]: PortToken<
    ManagedAgentsApplicationPorts[Name]
  >;
};

export const managedAgentsPortTokens = {
  agents: createPortToken<ManagedAgentsApplicationPorts["agents"]>(
    "managed-agents.application.agents",
  ),
  credentials: createPortToken<ManagedAgentsApplicationPorts["credentials"]>(
    "managed-agents.application.credentials",
  ),
  deploymentRuns: createPortToken<ManagedAgentsApplicationPorts["deploymentRuns"]>(
    "managed-agents.application.deployment-runs",
  ),
  deployments: createPortToken<ManagedAgentsApplicationPorts["deployments"]>(
    "managed-agents.application.deployments",
  ),
  dreams: createPortToken<ManagedAgentsApplicationPorts["dreams"]>(
    "managed-agents.application.dreams",
  ),
  environments: createPortToken<ManagedAgentsApplicationPorts["environments"]>(
    "managed-agents.application.environments",
  ),
  environmentWork: createPortToken<ManagedAgentsApplicationPorts["environmentWork"]>(
    "managed-agents.application.environment-work",
  ),
  files: createPortToken<ManagedAgentsApplicationPorts["files"]>(
    "managed-agents.application.files",
  ),
  memories: createPortToken<ManagedAgentsApplicationPorts["memories"]>(
    "managed-agents.application.memories",
  ),
  memoryStores: createPortToken<ManagedAgentsApplicationPorts["memoryStores"]>(
    "managed-agents.application.memory-stores",
  ),
  memoryVersions: createPortToken<ManagedAgentsApplicationPorts["memoryVersions"]>(
    "managed-agents.application.memory-versions",
  ),
  models: createPortToken<ManagedAgentsApplicationPorts["models"]>(
    "managed-agents.application.models",
  ),
  sessionEvents: createPortToken<ManagedAgentsApplicationPorts["sessionEvents"]>(
    "managed-agents.application.session-events",
  ),
  sessionResources: createPortToken<ManagedAgentsApplicationPorts["sessionResources"]>(
    "managed-agents.application.session-resources",
  ),
  sessionThreadEvents: createPortToken<ManagedAgentsApplicationPorts["sessionThreadEvents"]>(
    "managed-agents.application.session-thread-events",
  ),
  sessionThreads: createPortToken<ManagedAgentsApplicationPorts["sessionThreads"]>(
    "managed-agents.application.session-threads",
  ),
  sessions: createPortToken<ManagedAgentsApplicationPorts["sessions"]>(
    "managed-agents.application.sessions",
  ),
  skillVersions: createPortToken<ManagedAgentsApplicationPorts["skillVersions"]>(
    "managed-agents.application.skill-versions",
  ),
  skills: createPortToken<ManagedAgentsApplicationPorts["skills"]>(
    "managed-agents.application.skills",
  ),
  tunnelCertificates: createPortToken<ManagedAgentsApplicationPorts["tunnelCertificates"]>(
    "managed-agents.application.tunnel-certificates",
  ),
  tunnels: createPortToken<ManagedAgentsApplicationPorts["tunnels"]>(
    "managed-agents.application.tunnels",
  ),
  userProfiles: createPortToken<ManagedAgentsApplicationPorts["userProfiles"]>(
    "managed-agents.application.user-profiles",
  ),
  vaults: createPortToken<ManagedAgentsApplicationPorts["vaults"]>(
    "managed-agents.application.vaults",
  ),
} satisfies ManagedAgentsPortTokens;

export const managedAgentsApplicationPortsToken =
  createPortToken<ManagedAgentsApplicationPorts>(
    "managed-agents.application-ports",
  );

const portNames = Object.keys(managedAgentsPortTokens) as Array<
  keyof ManagedAgentsApplicationPorts
>;

export function managedAgentsApplicationPortsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:application-ports",
    provides: [managedAgentsApplicationPortsToken],
    requires: portNames.map((name) => managedAgentsPortTokens[name]),
    setup({ port }) {
      const ports = Object.fromEntries(
        portNames.map((name) => [
          name,
          port(managedAgentsPortTokens[name] as PortToken<unknown>),
        ]),
      ) as unknown as ManagedAgentsApplicationPorts;
      return {
        ports: [bindPort(managedAgentsApplicationPortsToken, ports)],
      };
    },
  });
}

export interface CreateManagedAgentsAppOptions {
  modules: readonly AppModule[];
}

export interface ManagedAgentsApp extends App {
  readonly ports: ManagedAgentsApplicationPorts;
}

export function createManagedAgentsApp(
  options: CreateManagedAgentsAppOptions,
): ManagedAgentsApp {
  const app = createApp({
    modules: [...options.modules, managedAgentsApplicationPortsModule()],
  });
  const ports = app.port(managedAgentsApplicationPortsToken);
  return {
    get status() {
      return app.status;
    },
    ports,
    port: app.port.bind(app),
    start: app.start.bind(app),
    stop: app.stop.bind(app),
  };
}
