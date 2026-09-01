import type {
  ManagedAgentsApplicationPorts,
} from "@open-managed-agents/managed-agents-application/ports";
import type { OmaModelsApplicationPort } from "@open-managed-agents/oma-models";

import {
  bindPort,
  createApp,
  createPortToken,
  defineAppModule,
  type App,
  type AppModule,
} from "./index";
import {
  managedAgentsApplicationPortsModule,
  managedAgentsApplicationPortsToken,
} from "./managed-agents";

export const openmaPortTokens = {
  omaModels: createPortToken<OmaModelsApplicationPort>(
    "openma.application.oma-models",
  ),
};

export interface OpenMAApplicationPorts {
  managed: ManagedAgentsApplicationPorts;
  oma: {
    models: OmaModelsApplicationPort;
  };
}

export const openmaApplicationPortsToken =
  createPortToken<OpenMAApplicationPorts>("openma.application-ports");

export function openmaApplicationPortsModule(): AppModule {
  return defineAppModule({
    name: "openma:application-ports",
    provides: [openmaApplicationPortsToken],
    requires: [
      managedAgentsApplicationPortsToken,
      openmaPortTokens.omaModels,
    ],
    setup({ port }) {
      return {
        ports: [bindPort(openmaApplicationPortsToken, {
          managed: port(managedAgentsApplicationPortsToken),
          oma: { models: port(openmaPortTokens.omaModels) },
        })],
      };
    },
  });
}

export interface CreateOpenMAAppOptions {
  modules: readonly AppModule[];
}

export interface OpenMAApp extends App {
  readonly ports: OpenMAApplicationPorts;
}

export function createOpenMAApp(options: CreateOpenMAAppOptions): OpenMAApp {
  const app = createApp({
    modules: [
      ...options.modules,
      managedAgentsApplicationPortsModule(),
      openmaApplicationPortsModule(),
    ],
  });
  const ports = app.port(openmaApplicationPortsToken);
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
