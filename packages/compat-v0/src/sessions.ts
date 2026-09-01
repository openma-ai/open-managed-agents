import type { SessionStore } from "@open-managed-agents/session-store";
import type {
  SessionsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import {
  providePort,
  type AppModule,
} from "@open-managed-agents/app";
import { sessionStorePort } from "@open-managed-agents/app/modules/sessions";

/** The structural shape implemented by v0 Session persistence adapters. */
export type V0SessionPersistence = SessionStore;

export type V0SessionsApplicationServiceDependencies = Omit<
  SessionsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0SessionPersistence;
};

/**
 * Adapts a v0 Session persistence implementation to the v1 SessionStore Port.
 * The shapes are compatible, so the adapter preserves object identity.
 */
export function sessionStoreFromV0(
  persistence: V0SessionPersistence,
): SessionStore {
  return persistence;
}

/** Renames the v0 constructor dependency without changing its implementation. */
export function sessionsDependenciesFromV0(
  dependencies: V0SessionsApplicationServiceDependencies,
): SessionsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: sessionStoreFromV0(persistence) };
}

/** Installs a v0 Session persistence implementation into a v1 app graph. */
export function v0SessionPersistenceModule(
  persistence: V0SessionPersistence,
): AppModule {
  return providePort(sessionStorePort, sessionStoreFromV0(persistence), {
    name: "compat-v0:session-persistence",
  });
}
