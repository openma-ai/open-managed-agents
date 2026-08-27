import {
  TunnelCertificatesApplicationService,
  TunnelsApplicationService,
  type TunnelCertificateAuthorityPort,
  type TunnelProvisionerPort,
  type TunnelTokenManagerPort,
} from "@open-managed-agents/managed-agents-application";
import type { TunnelStore } from "@open-managed-agents/tunnel-store";

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

export const tunnelStorePort = createPortToken<TunnelStore>(
  "managed-agents.store.tunnels",
);

export const tunnelProvisionerPort = createPortToken<TunnelProvisionerPort>(
  "managed-agents.outbound.tunnels.provisioner",
);

export const tunnelTokenManagerPort = createPortToken<TunnelTokenManagerPort>(
  "managed-agents.outbound.tunnels.token-manager",
);

export const tunnelCertificateAuthorityPort =
  createPortToken<TunnelCertificateAuthorityPort>(
    "managed-agents.outbound.tunnels.certificate-authority",
  );

export function tunnelsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:tunnels",
    provides: [managedAgentsPortTokens.tunnels],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      tunnelStorePort,
      tunnelProvisionerPort,
      tunnelTokenManagerPort,
    ],
    setup({ port }) {
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.tunnels,
          new TunnelsApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(tunnelStorePort),
            provisioner: port(tunnelProvisionerPort),
            tokens: port(tunnelTokenManagerPort),
            clock: port(clockPort),
            ids: { nextTunnelId: () => ids.next("tunnel") },
          }),
        )],
      };
    },
  });
}

export function tunnelCertificatesModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:tunnel-certificates",
    provides: [managedAgentsPortTokens.tunnelCertificates],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      tunnelStorePort,
      tunnelCertificateAuthorityPort,
    ],
    setup({ port }) {
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.tunnelCertificates,
          new TunnelCertificatesApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(tunnelStorePort),
            certificateAuthority: port(tunnelCertificateAuthorityPort),
            clock: port(clockPort),
            ids: {
              nextTunnelCertificateId: () => ids.next("tunnel-certificate"),
            },
          }),
        )],
      };
    },
  });
}
