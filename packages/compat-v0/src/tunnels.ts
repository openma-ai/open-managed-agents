import type { TunnelStore } from "@open-managed-agents/tunnel-store";
import type {
  TunnelCertificatesApplicationServiceDependencies,
  TunnelsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { tunnelStorePort } from "@open-managed-agents/app/modules/tunnels";

/** The structural shape implemented by v0 Tunnel persistence adapters. */
export type V0TunnelPersistence = TunnelStore;

export type V0TunnelsApplicationServiceDependencies = Omit<
  TunnelsApplicationServiceDependencies,
  "store"
> & { persistence: V0TunnelPersistence };

export type V0TunnelCertificatesApplicationServiceDependencies = Omit<
  TunnelCertificatesApplicationServiceDependencies,
  "store"
> & { persistence: V0TunnelPersistence };

export function tunnelStoreFromV0(
  persistence: V0TunnelPersistence,
): TunnelStore {
  return persistence;
}

export function tunnelsDependenciesFromV0(
  dependencies: V0TunnelsApplicationServiceDependencies,
): TunnelsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: tunnelStoreFromV0(persistence) };
}

export function tunnelCertificatesDependenciesFromV0(
  dependencies: V0TunnelCertificatesApplicationServiceDependencies,
): TunnelCertificatesApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: tunnelStoreFromV0(persistence) };
}

export function v0TunnelPersistenceModule(
  persistence: V0TunnelPersistence,
): AppModule {
  return providePort(tunnelStorePort, tunnelStoreFromV0(persistence), {
    name: "compat-v0:tunnel-persistence",
  });
}
