import type { ModelMessage } from "ai";
import { InMemoryEventLog } from "@open-managed-agents/event-log/memory";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HistoryStore } from "../interface";
import { eventsToMessages } from "./events-to-messages";
import { stampEventImmediate, type HistoryStampClock } from "./event-stamp";

/**
 * Lightweight in-memory history for sub-agent threads.
 * No SQLite dependency — thread history lives only for the duration
 * of the sub-agent run and is discarded afterwards.
 */
export class InMemoryHistory implements HistoryStore {
  private repo: InMemoryEventLog;

  constructor(clock?: HistoryStampClock) {
    this.repo = new InMemoryEventLog((e) => stampEventImmediate(e, clock));
  }

  append(event: SessionEvent): void {
    this.repo.append(event);
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    return this.repo.getEvents(afterSeq);
  }

  getMessages(): ModelMessage[] {
    return eventsToMessages(this.getEvents());
  }
}
