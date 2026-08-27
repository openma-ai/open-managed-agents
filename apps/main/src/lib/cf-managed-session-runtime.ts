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
  decodeRuntimeEvent,
  encodeRuntimeSessionEvent,
  encodeRuntimeSessionStart,
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
      socket.close(1000, "subscription closed");
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
    const response = await this.fetcher.fetch(
      `https://managed-runtime/sessions/${encodeURIComponent(input.sessionId)}/ws`,
      {
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "x-oma-workspace-id": input.workspaceId,
        },
      },
    );
    const socket = (response as Response & { webSocket?: RuntimeWebSocket })
      .webSocket;
    if (socket === undefined) {
      throw new Error("Managed session runtime did not accept the event stream");
    }
    const deltaTypes = new Set(input.deltaEventTypes ?? []);
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
      for (const event of decodeRuntimeEvent(raw, deltaTypes)) yield event;
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
