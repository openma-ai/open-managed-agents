import type {
  ListPersistedSessionThreadEvents,
  SessionThreadEventStore,
} from "@open-managed-agents/session-event-store";
import { SqlSessionEventStore } from "@open-managed-agents/session-event-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** @deprecated Use `SqlSessionEventStore.listThread()`. */
export class SqlSessionThreadEventPersistence {
  private readonly store: SessionThreadEventStore;

  constructor(client: SqlClient) {
    this.store = new SqlSessionEventStore(client);
  }

  list(
    input: ListPersistedSessionThreadEvents,
  ): ReturnType<SessionThreadEventStore["listThread"]> {
    return this.store.listThread(input);
  }
}
