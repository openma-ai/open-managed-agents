import type {
  ArchivedSessionThread,
  SessionThreadEventStreamPort,
  SessionThreadLifecycleCommandPort,
  StreamSessionEvent,
  SubscribeSessionThreadEvents,
} from "@open-managed-agents/managed-agents-application";
import type {
  AcceptedSessionEvents,
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type {
  SessionLifecycleCommandPort,
  StartSessionExecution,
  StopSessionExecution,
} from "@open-managed-agents/session-runtime-contract/lifecycle";
import type {
  SessionEventStreamPort,
  SubscribeSessionEvents,
} from "@open-managed-agents/session-runtime-contract/stream";
import {
  encodeRuntimeSessionEvent,
  encodeRuntimeSessionStart,
  RuntimeEventStreamDecoder,
} from "@open-managed-agents/managed-agents-adapters-runtime";

interface RuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface RuntimeWebSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

function socketMessages(socket: RuntimeWebSocket): AsyncIterable<string> {
  return (async function* () {
    const values: string[] = [];
    let pending: ((value: IteratorResult<string>) => void) | null = null;
    let finished = false;
    const finish = () => {
      finished = true;
      const resolve = pending;
      pending = null;
      resolve?.({ done: true, value: undefined });
    };
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || finished) return;
      const resolve = pending;
      pending = null;
      if (resolve !== null) resolve({ done: false, value: event.data });
      else values.push(event.data);
    });
    socket.addEventListener("close", finish);
    socket.addEventListener("error", finish);
    socket.accept();
    try {
      while (values.length > 0 || !finished) {
        const value = values.shift();
        if (value !== undefined) {
          yield value;
          continue;
        }
        const item = await new Promise<IteratorResult<string>>((resolve) => {
          pending = resolve;
        });
        if (item.done) break;
        yield item.value;
      }
    } finally {
      try {
        socket.close(1000, "subscription closed");
      } catch {
        // Peer-close and error events can transition Cloudflare's socket to
        // CLOSED before the iterator unwinds. Closing an already-closed
        // socket throws and must not bypass the adapter's replay/reconnect
        // loop.
      }
    }
  })();
}

export class CfManagedSessionRuntimeAdapter
  implements
    SessionLifecycleCommandPort,
    SessionEventDispatchPort,
    SessionThreadLifecycleCommandPort,
    SessionEventStreamPort,
    SessionThreadEventStreamPort
{
  constructor(private readonly fetcher: RuntimeFetcher) {}

  async sessionStarted(input: StartSessionExecution): Promise<void> {
    await this.send({
      workspaceId: input.workspaceId,
      path: `/sessions/${encodeURIComponent(input.sessionId)}/init`,
      init: {
        method: "PUT",
        body: JSON.stringify(encodeRuntimeSessionStart(input)),
      },
    });
  }

  async sessionStopped(input: StopSessionExecution): Promise<void> {
    await this.send({
      workspaceId: input.workspaceId,
      path: `/sessions/${encodeURIComponent(input.sessionId)}/destroy`,
      init: { method: "DELETE" },
    });
  }

  async sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void> {
    for (const event of input.events) {
      await this.send({
        workspaceId: input.workspaceId,
        path: `/sessions/${encodeURIComponent(input.sessionId)}/event`,
        init: {
          method: "POST",
          body: JSON.stringify(encodeRuntimeSessionEvent(event)),
        },
      });
    }
  }

  async sessionThreadArchived(input: ArchivedSessionThread): Promise<void> {
    await this.send({
      workspaceId: input.workspaceId,
      path: `/sessions/${encodeURIComponent(input.sessionId)}/threads/${encodeURIComponent(input.threadId)}/archive`,
      init: { method: "POST", body: "{}" },
    });
  }

  subscribe(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return this.stream(input);
  }

  private async *stream(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    const deltaTypes = new Set(input.deltaEventTypes ?? []);
    const decoder = new RuntimeEventStreamDecoder(deltaTypes);
    const seenCanonicalEventIds = new Set<string>();
    let replay = false;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetcher.fetch(
          `https://managed-runtime/sessions/${encodeURIComponent(input.sessionId)}/ws`,
          {
            method: "GET",
            headers: {
              Connection: "Upgrade",
              Upgrade: "websocket",
              "x-oma-workspace-id": input.workspaceId,
              ...(replay && { "x-oma-replay": "1" }),
            },
          },
        );
      } catch (error) {
        if (!replay) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const socket = (response as Response & {
        webSocket?: RuntimeWebSocket | null;
      })
        .webSocket;
      if (socket == null) {
        if (replay) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw new Error("Managed session runtime did not accept the event stream");
      }
      for await (const frame of socketMessages(socket)) {
        let raw: unknown;
        try {
          raw = JSON.parse(frame);
        } catch {
          continue;
        }
        if (
          "threadId" in input &&
          (raw === null ||
            typeof raw !== "object" ||
            (raw as { session_thread_id?: unknown }).session_thread_id !==
              input.threadId)
        ) continue;
        const rawEvent = raw as { id?: unknown; type?: unknown };
        const canonicalEventId =
          typeof rawEvent.id === "string" ? rawEvent.id : undefined;
        if (
          canonicalEventId !== undefined &&
          seenCanonicalEventIds.has(canonicalEventId)
        ) continue;
        if (canonicalEventId !== undefined) {
          seenCanonicalEventIds.add(canonicalEventId);
        }
        for (const event of decoder.decode(raw)) yield event;
        if (
          rawEvent.type === "session.status_idle" ||
          rawEvent.type === "session.status_terminated" ||
          rawEvent.type === "session.deleted" ||
          ("threadId" in input &&
            (rawEvent.type === "session.thread_status_idle" ||
              rawEvent.type === "session.thread_status_terminated"))
        ) return;
      }
      replay = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async send(input: {
    workspaceId: string;
    path: string;
    init: RequestInit;
  }): Promise<void> {
    const response = await this.fetcher.fetch(`https://managed-runtime${input.path}`, {
      ...input.init,
      headers: {
        "content-type": "application/json",
        "x-oma-workspace-id": input.workspaceId,
        ...input.init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Managed session runtime request failed: ${input.init.method ?? "GET"} ${input.path} (${response.status})`,
      );
    }
  }
}
