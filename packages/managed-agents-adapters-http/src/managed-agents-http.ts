import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "@open-managed-agents/app";
import {
  openmaApplicationPortsToken,
} from "@open-managed-agents/app/openma";
import {
  buildManagedAgentsApi,
} from "@open-managed-agents/managed-agents-api";
import { buildOmaModelRoutes } from "@open-managed-agents/oma-api";

export interface ManagedAgentsHttpHandlerPort {
  fetch(request: Request): Response | Promise<Response>;
}

export const managedAgentsHttpHandlerPort =
  createPortToken<ManagedAgentsHttpHandlerPort>("openma.http.fetch-handler");

export function managedAgentsHttpModule(): AppModule {
  return defineAppModule({
    name: "openma:http",
    provides: [managedAgentsHttpHandlerPort],
    requires: [openmaApplicationPortsToken],
    setup({ port }) {
      const application = port(openmaApplicationPortsToken);
      const router = buildManagedAgentsApi(application.managed);
      router.route(
        "/v1/oma/models",
        buildOmaModelRoutes(application.oma.models),
      );
      return {
        ports: [bindPort(managedAgentsHttpHandlerPort, {
          fetch: (request: Request) => router.fetch(request),
        })],
      };
    },
  });
}
