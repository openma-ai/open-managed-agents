import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type {
  SessionEventsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import {
  providePort,
  type AppModule,
} from "@open-managed-agents/app";
import {
  sessionEventStorePort,
} from "@open-managed-agents/app/modules/session-events";

/** The structural shape implemented by v0 Session Event persistence adapters. */
export type V0SessionEventPersistence = SessionEventLogStore;

export type V0SessionEventsApplicationServiceDependencies = Omit<
  SessionEventsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0SessionEventPersistence;
};

export function sessionEventStoreFromV0(
  persistence: V0SessionEventPersistence,
): SessionEventLogStore {
  return persistence;
}

export function sessionEventsDependenciesFromV0(
  dependencies: V0SessionEventsApplicationServiceDependencies,
): SessionEventsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: sessionEventStoreFromV0(persistence) };
}

export function v0SessionEventPersistenceModule(
  persistence: V0SessionEventPersistence,
): AppModule {
  return providePort(
    sessionEventStorePort,
    sessionEventStoreFromV0(persistence),
    { name: "compat-v0:session-event-persistence" },
  );
}
