import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type {
  Session,
  SessionEventStreamPort,
  SessionThreadEventStreamPort,
  StreamSessionEvent,
} from "@open-managed-agents/managed-agents-application";
import { SqlReplicatedSessionEventStream } from "../src/session-event-replicated-stream";

const session = {
  id: "session_01",
  agent: {} as never,
  archivedAt: null,
  budget: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  environmentId: "env_cloud_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-09-08T00:00:00.000Z",
  usage: {},
  vaultIds: [],
} satisfies Session;

/** In-process runtime stream of one replica: push() emulates a local publish. */
class LocalStream implements SessionEventStreamPort, SessionThreadEventStreamPort {
  readonly subscribers = new Set<{
    push(event: StreamSessionEvent): void;
    end(): void;
  }>();

  subscribe(): AsyncIterable<StreamSessionEvent> {
    const queue: StreamSessionEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const subscriber = {
      push: (event: StreamSessionEvent) => {
        queue.push(event);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    this.subscribers.add(subscriber);
    const subscribers = this.subscribers;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        } finally {
          subscribers.delete(subscriber);
        }
      },
    };
  }

  publish(event: StreamSessionEvent): void {
    for (const subscriber of this.subscribers) subscriber.push(event);
  }

  end(): void {
    for (const subscriber of this.subscribers) subscriber.end();
  }
}

async function fixture(options: { rowsPerQuery?: number } = {}) {
  const client = await createBetterSqlite3SqlClient(":memory:");
  await client.exec(`CREATE TABLE managed_session_events (
    workspace_id text NOT NULL,
    session_id text NOT NULL,
    thread_id text,
    id text NOT NULL,
    type text NOT NULL,
    document text NOT NULL,
    processed_at integer NOT NULL,
    PRIMARY KEY (workspace_id, session_id, id)
  )`);
  const local = new LocalStream();
  let timers = 0;
  const stream = new SqlReplicatedSessionEventStream(client, local, {
    ...options,
    schedule: () => {
      timers += 1;
      return { stop: () => { timers -= 1; } };
    },
  });
  const append = async (
    event: Record<string, unknown>,
    sessionId = session.id,
    threadId: string | null = null,
  ) => {
    await client.prepare(
      `INSERT INTO managed_session_events
        (workspace_id, session_id, thread_id, id, type, document, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "workspace_01",
      sessionId,
      threadId,
      event.id,
      event.type,
      JSON.stringify(event),
      Date.parse(String(event.processedAt)),
    ).run();
    return event as unknown as StreamSessionEvent;
  };
  return { append, local, stream, timers: () => timers };
}

function message(id: string, second: number) {
  return {
    id,
    type: "agent.message",
    processedAt: `2026-09-08T00:00:${String(second).padStart(2, "0")}.000Z`,
    content: [{ type: "text", text: id }],
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function subscribe(
  stream: SqlReplicatedSessionEventStream,
  extra: Record<string, unknown> = {},
  sessionId = session.id,
) {
  const received: StreamSessionEvent[] = [];
  const iterator = stream.subscribe({
    workspaceId: "workspace_01",
    sessionId,
    session: { ...session, id: sessionId },
    ...extra,
  } as never)[Symbol.asyncIterator]();
  let finished = false;
  const drain = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        return;
      }
      received.push(next.value);
    }
  })();
  await settle();
  return {
    received,
    ids: () => received.map((event) => ("id" in event ? event.id : event.type)),
    finished: () => finished,
    close: async () => {
      await iterator.return?.();
      await drain;
    },
  };
}

describe("SqlReplicatedSessionEventStream", () => {
  it("delivers canonical events committed by another replica, live-only", async () => {
    const { append, stream } = await fixture();
    await append(message("history", 1));
    const sub = await subscribe(stream);

    await append(message("remote-1", 2));
    await append(message("remote-2", 3));
    await stream.pollOnce();
    await settle();
    expect(sub.ids()).toEqual(["remote-1", "remote-2"]);

    await stream.pollOnce();
    await settle();
    expect(sub.ids()).toEqual(["remote-1", "remote-2"]);
    await sub.close();
  });

  it("passes local deltas through and de-duplicates canonical events seen both ways", async () => {
    const { append, local, stream } = await fixture();
    const sub = await subscribe(stream);

    local.publish({ type: "event_start", event: { id: "m1", type: "agent.message" } } as never);
    local.publish({ type: "event_delta", eventId: "m1", delta: { text: "hi" } } as never);
    local.publish(await append(message("m1", 2)));
    await settle();
    await stream.pollOnce();
    await settle();
    expect(sub.received.map((event) => event.type)).toEqual([
      "event_start",
      "event_delta",
      "agent.message",
    ]);

    // Poller wins the race: the later local publish is dropped.
    await append(message("m2", 3));
    await stream.pollOnce();
    await settle();
    local.publish(message("m2", 3) as never);
    await settle();
    expect(sub.ids().filter((id) => id === "m2")).toHaveLength(1);
    await sub.close();
  });

  it("does not end on idle but ends on a persisted terminal event", async () => {
    const { append, stream } = await fixture();
    const sub = await subscribe(stream);
    await append({
      id: "idle",
      type: "session.status_idle",
      processedAt: "2026-09-08T00:00:02.000Z",
      stopReason: { type: "end_turn" },
    });
    await stream.pollOnce();
    await settle();
    expect(sub.finished()).toBe(false);

    await append({
      id: "terminated",
      type: "session.status_terminated",
      processedAt: "2026-09-08T00:00:03.000Z",
    });
    await stream.pollOnce();
    await settle();
    expect(sub.ids()).toEqual(["idle", "terminated"]);
    expect(sub.finished()).toBe(true);
  });

  it("ends when the local runtime stream closes", async () => {
    const { local, stream, timers } = await fixture();
    const sub = await subscribe(stream);
    expect(timers()).toBe(1);
    local.end();
    await settle();
    expect(sub.finished()).toBe(true);
    expect(timers()).toBe(0);
  });

  it("isolates thread lanes", async () => {
    const { append, stream } = await fixture();
    const sub = await subscribe(stream, { threadId: "thread_01", thread: {} });
    await append(message("other", 2), session.id, "thread_02");
    await append({ ...message("mine", 3), sessionThreadId: "thread_01" }, session.id, "thread_01");
    await stream.pollOnce();
    await settle();
    expect(sub.ids()).toEqual(["mine"]);
    await sub.close();
  });

  it("batches sessions with independent positions and pages through large backlogs", async () => {
    const { append, stream, timers } = await fixture({ rowsPerQuery: 2 });
    await append(message("a-old", 1), "session_a");
    const a = await subscribe(stream, {}, "session_a");
    const empty = await subscribe(stream, {}, "session_empty");
    expect(timers()).toBe(1);

    for (let i = 2; i <= 6; i += 1) await append(message(`a${i}`, i), "session_a");
    await append(message("e1", 7), "session_empty");
    await stream.pollOnce();
    await settle();
    expect(a.ids()).toEqual(["a2", "a3", "a4", "a5", "a6"]);
    expect(empty.ids()).toEqual(["e1"]);

    await a.close();
    expect(timers()).toBe(1);
    await empty.close();
    expect(timers()).toBe(0);
  });
});
