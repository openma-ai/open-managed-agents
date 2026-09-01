import type {
  SessionEventView,
  SessionThread,
} from "@open-managed-agents/domain/sessions";
import type {
  ArchiveSessionThread,
  ListSessionThreads,
  SessionThreadLocation,
  SessionThreadStore,
} from "@open-managed-agents/session-thread-store";
import type {
  ListPersistedSessionThreadEvents,
  SessionThreadEventStore,
} from "@open-managed-agents/session-event-store";
import type {
  SessionThreadEventsApplicationServiceDependencies,
  SessionThreadsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import {
  sessionThreadStorePort,
} from "@open-managed-agents/app/modules/session-threads";
import {
  sessionThreadEventStorePort,
} from "@open-managed-agents/app/modules/session-thread-events";

export type V0ArchiveSessionThreadResult =
  | { type: "archived"; thread: SessionThread }
  | { type: "not_found" };

/** The Session Thread persistence shape exposed before the v1 Store split. */
export interface V0SessionThreadPersistence {
  list(input: ListSessionThreads): Promise<SessionThread[]>;
  find(input: SessionThreadLocation): Promise<SessionThread | null>;
  archive(
    input: ArchiveSessionThread,
  ): Promise<V0ArchiveSessionThreadResult>;
}

/** The thread-event read shape exposed before `listThread` named the projection. */
export interface V0SessionThreadEventPersistence {
  list(
    input: ListPersistedSessionThreadEvents,
  ): Promise<SessionEventView[]>;
}

export type V0SessionThreadsApplicationServiceDependencies = Omit<
  SessionThreadsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0SessionThreadPersistence;
};

export type V0SessionThreadEventsApplicationServiceDependencies = Omit<
  SessionThreadEventsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0SessionThreadEventPersistence;
};

/**
 * Bridges the v0 read/archive adapter into the v1 Store Port.
 *
 * v0 never exposed thread insertion. The compatibility adapter rejects that
 * operation explicitly instead of pretending the write succeeded. The
 * read-before-archive check also cannot add the atomic concurrency guarantee
 * of a native v1 Store; it only preserves idempotency for migration callers.
 */
export function sessionThreadStoreFromV0(
  persistence: V0SessionThreadPersistence,
): SessionThreadStore {
  return {
    insert: async () => {
      throw new Error(
        "v0 persistence does not support Session Thread insertion; install a native v1 SessionThreadStore",
      );
    },
    list: (input) => persistence.list(input),
    find: (input) => persistence.find(input),
    archive: async (input) => {
      const current = await persistence.find(input);
      if (current === null) return { type: "not_found" };
      if (current.archivedAt !== null) {
        return { type: "archived", thread: current, transitioned: false };
      }
      const result = await persistence.archive(input);
      if (result.type === "not_found") return result;
      return { ...result, transitioned: true };
    },
  };
}

export function sessionThreadsDependenciesFromV0(
  dependencies: V0SessionThreadsApplicationServiceDependencies,
): SessionThreadsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: sessionThreadStoreFromV0(persistence) };
}

export function sessionThreadEventStoreFromV0(
  persistence: V0SessionThreadEventPersistence,
): SessionThreadEventStore {
  return {
    listThread: (input) => persistence.list(input),
  };
}

export function sessionThreadEventsDependenciesFromV0(
  dependencies: V0SessionThreadEventsApplicationServiceDependencies,
): SessionThreadEventsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: sessionThreadEventStoreFromV0(persistence) };
}

export function v0SessionThreadPersistenceModule(
  persistence: V0SessionThreadPersistence,
): AppModule {
  return providePort(
    sessionThreadStorePort,
    sessionThreadStoreFromV0(persistence),
    { name: "compat-v0:session-thread-persistence" },
  );
}

export function v0SessionThreadEventPersistenceModule(
  persistence: V0SessionThreadEventPersistence,
): AppModule {
  return providePort(
    sessionThreadEventStorePort,
    sessionThreadEventStoreFromV0(persistence),
    { name: "compat-v0:session-thread-event-persistence" },
  );
}
