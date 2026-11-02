/**
 * OpenMatter Agent connector for OpenMA Agents, over the public OpenMA API.
 *
 * One OpenMatter Agent Session is one OpenMA session; one Turn is one
 * `user.message` and ends at the next terminal status. Events have ids but
 * no sequence numbers, and the stream only carries events appended after it
 * opened: a Turn is the events that follow its `user.message`, and a
 * repeated Turn is read back from the event list. The Agent reaches
 * OpenMatter operations (for example the Feishu reply tool) through the
 * Matter MCP server configured on the Agent. The MCP request registers each
 * call in the bridge's store; while a Turn runs, the connector takes the
 * Session's calls from the store, alongside the OpenMA event stream, and
 * reports them as operation-call callbacks (see `tool-bridge.ts`). It does
 * not look for tool calls in the OpenMA event log.
 */

import {
  agentEventEnvelope,
  callbackFingerprint,
  createAgentSessionHandle,
  createOpenMAEvent,
  isTurnTerminalEvent,
  type AgentCapabilities,
  type AgentCommand,
  type AgentContent,
  type AgentSessionHandle,
  type AgentSessionInput,
  type AgentTurnInput,
  type OpenMAAgentConnector,
  type OpenMAEvent,
} from "@openma/common/agent-contract";
import { managedEventToOpenMA } from "@openma/common/agent-contract/managed";
import { OPERATION_CALL_METHOD, type AgentTool } from "@openma/matter/agent";
import type { OmaClient, OmaEvent } from "./oma-client.js";
import {
  mcpToolName,
  type JsonValue,
  type OperationCallBridge,
  type StoredCall,
} from "./tool-bridge.js";

export const OPENMA_CONNECTOR_ID = "openma";

/** Prefix of an OpenMatter-created session title; the rest is the
 * idempotency key, so a replayed `open` finds the session it created. */
export const SESSION_TITLE_PREFIX = "openmatter:";

export class OmaSessionUnavailableError extends Error {
  constructor(sessionId: string) {
    super(`OpenMA session ${sessionId} is missing or archived`);
    this.name = "OmaSessionUnavailableError";
  }
}

/** Pass as `isSessionUnavailable` to `makeConnectorAgentDriver`. */
export const isOmaSessionUnavailable = (cause: unknown): boolean =>
  cause instanceof OmaSessionUnavailableError;

export interface OpenMAConnectorOptions {
  readonly client: OmaClient;
  readonly bridge: OperationCallBridge;
  /** The environment new sessions run in, or how to find it. */
  readonly environmentId: string | (() => Promise<string>);
  /** Vaults attached to a new session, for example the one holding the
   * Matter MCP bearer for this session. */
  readonly vaultIds?: (input: AgentSessionInput) => Promise<readonly string[]>;
  /** Rewrites a Turn's content before it is sent, for example to attach
   * the images of the message (see `images.ts`). */
  readonly content?: (content: AgentContent) => Promise<AgentContent>;
  readonly id?: string;
  readonly now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SOURCE = { kind: "harness", harness: "openma", adapter: "matter" } as const;

/** The tools the kernel passed for this Turn, by MCP tool name. */
const turnTools = (input: AgentTurnInput): ReadonlyMap<string, AgentTool> => {
  const tools = isRecord(input.metadata?.openmatter)
    ? (input.metadata.openmatter as Record<string, unknown>).tools
    : undefined;
  const map = new Map<string, AgentTool>();
  if (!Array.isArray(tools)) return map;
  for (const tool of tools as AgentTool[]) {
    if (typeof tool?.name === "string") map.set(mcpToolName(tool.name), tool);
  }
  return map;
};

const toolFailure = (message: string) =>
  ({ ok: false, error: { message } }) as const;

/** Waits for the next of a Turn's two sources: the OpenMA event stream and
 * the Matter MCP calls of its Session. */
type Next =
  | { readonly kind: "event"; readonly result: IteratorResult<OmaEvent> }
  | { readonly kind: "call" };

const userMessage = (content: AgentContent): Record<string, unknown> => ({
  type: "user.message",
  content:
    typeof content === "string" ? [{ type: "text", text: content }] : content,
});

export const createOpenMAConnector = (
  options: OpenMAConnectorOptions,
): OpenMAAgentConnector => {
  const id = options.id ?? OPENMA_CONNECTOR_ID;
  const now = options.now ?? (() => new Date());
  const { client, bridge } = options;
  /** The `user.message` event that started each Turn, so a repeated turnId
   * replays it; null when the server returned no id for it. */
  const turnStarts = new Map<string, string | null>();

  /** The logged events after `eventId`, oldest first. */
  const eventsAfter = async (
    sessionId: string,
    eventId: string,
  ): Promise<readonly OmaEvent[]> => {
    const after: OmaEvent[] = [];
    let found = false;
    let page: string | undefined;
    do {
      const result = await client.listEvents(sessionId, {
        ...(page === undefined ? {} : { page }),
      });
      for (const event of result.data) {
        if (found) after.push(event);
        else if (event.id === eventId) found = true;
      }
      page = result.nextPage;
    } while (page !== undefined);
    return after;
  };

  const handleFor = (sessionId: string): AgentSessionHandle =>
    createAgentSessionHandle({
      connectorId: id,
      externalSessionId: sessionId,
      placement: "managed",
    });

  const capabilities = async (): Promise<AgentCapabilities> => ({
    sessionPersistence: "persistent",
    streaming: true,
    cancellation: true,
    permissions: false,
    elicitation: false,
    customTools: true,
    mcp: true,
  });

  const open = async (input: AgentSessionInput): Promise<AgentSessionHandle> => {
    if (input.resume !== undefined) {
      const session = await client.getSession(input.resume.externalSessionId);
      if (session === null || session.archived_at) {
        throw new OmaSessionUnavailableError(input.resume.externalSessionId);
      }
      return handleFor(session.id);
    }
    const title = `${SESSION_TITLE_PREFIX}${input.idempotencyKey}`;
    const existing = (await client.findSessions(input.agentId, title)).find(
      (session) => session.title === title && !session.archived_at,
    );
    if (existing !== undefined) return handleFor(existing.id);
    // The Loop's session settings, when it has any (see loopDrivers).
    const metadata = input.metadata ?? {};
    const loopVaults = Array.isArray(metadata.vaultIds)
      ? metadata.vaultIds.filter((id): id is string => typeof id === "string" && id !== "")
      : [];
    const vaultIds = [...((await options.vaultIds?.(input)) ?? []), ...loopVaults];
    const repositoryUrls = Array.isArray(metadata.repositories)
      ? metadata.repositories.filter((r): r is string => typeof r === "string" && r !== "")
      : [];
    const created = await client.createSession({
      agentId: input.agentId,
      title,
      environmentId:
        typeof metadata.environmentId === "string" && metadata.environmentId !== ""
          ? metadata.environmentId
          : typeof options.environmentId === "string"
            ? options.environmentId
            : await options.environmentId(),
      vaultIds,
      ...(repositoryUrls.length === 0 ? {} : { repositoryUrls }),
    });
    return handleFor(created.id);
  };

  async function* execute(
    session: AgentSessionHandle,
    input: AgentTurnInput,
  ): AsyncGenerator<OpenMAEvent> {
    const omaSessionId = session.externalSessionId;
    const tools = turnTools(input);
    const abort = new AbortController();
    const known = turnStarts.get(input.turnId);
    // Open the stream before sending, so no event of this Turn is missed.
    const stream = await client.streamEvents(omaSessionId, { signal: abort.signal });
    let backlog: readonly OmaEvent[] = [];
    if (known === undefined) {
      await bridge.setTools(input.sessionId, [...tools.values()]);
      const content = options.content === undefined ? input.content : await options.content(input.content);
      const sent = await client.sendEvents(omaSessionId, [userMessage(content)]);
      turnStarts.set(input.turnId, sent[0]?.id ?? null);
    } else if (known !== null) {
      backlog = await eventsAfter(omaSessionId, known);
    }
    const seen = new Set<string>();
    let seq = 0;
    const context = (event: OmaEvent, suffix = "") => ({
      eventId: `${omaSessionId}:${event.id ?? `#${seq + 1}`}${suffix}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      occurredAt:
        typeof event.processed_at === "string"
          ? event.processed_at
          : now().toISOString(),
      seq: ++seq,
    });
    async function* turnEvents(): AsyncGenerator<OmaEvent> {
      yield* backlog;
      yield* stream;
    }

    // Take the Session's MCP calls from the store while the Turn runs. This
    // runs apart from the kernel reading this generator: the kernel handles
    // one event at a time, and a call must be taken while an earlier
    // callback is still being answered.
    const taker = bridge.newTaker();
    const taken: StoredCall[] = [];
    const surfaced = new Set<string>();
    let notify: (() => void) | undefined;
    let watchError: unknown;
    const watching = new AbortController();
    const watcher = (async () => {
      try {
        while (!watching.signal.aborted) {
          const calls = await bridge.take(input.sessionId, taker);
          if (calls.length > 0) {
            taken.push(...calls);
            notify?.();
          }
          await bridge.pause(watching.signal);
        }
      } catch (error) {
        if (!watching.signal.aborted) {
          watchError = error;
          notify?.();
        }
      }
    })();

    const callbackFor = (call: StoredCall, tool: AgentTool): OpenMAEvent => {
      const ctx = {
        eventId: `${omaSessionId}:${call.callId}:operation`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        occurredAt: new Date(call.createdAtMs).toISOString(),
        seq: ++seq,
      };
      const params = {
        integrationId: tool.integrationId,
        operation: tool.operation,
        input: call.input,
      };
      return createOpenMAEvent({
        ...agentEventEnvelope(ctx, SOURCE),
        type: "callback.requested",
        data: {
          callback_id: call.callId,
          fingerprint: callbackFingerprint(
            ctx,
            "extension",
            OPERATION_CALL_METHOD,
            call.callId,
            params,
          ),
          method: OPERATION_CALL_METHOD,
          category: "extension",
          params,
        },
      }) as OpenMAEvent;
    };

    const events = turnEvents();
    let pending: Promise<Next> | undefined;
    try {
      for (;;) {
        if (watchError !== undefined) throw watchError;
        // Calls first: they are already waiting, in registration order.
        const call = taken.shift();
        if (call !== undefined) {
          const tool = tools.get(call.tool);
          if (tool === undefined) {
            await bridge.resolve(
              call.callId,
              toolFailure(`${call.tool} is not available in this Turn`),
            );
            continue;
          }
          surfaced.add(call.callId);
          yield callbackFor(call, tool);
          continue;
        }
        pending ??= events.next().then((result) => ({ kind: "event", result }) as const);
        const called = new Promise<Next>((resolve) => {
          notify = () => resolve({ kind: "call" });
        });
        const next = await Promise.race([pending, called]);
        notify = undefined;
        if (next.kind === "call") continue;
        pending = undefined;
        if (next.result.done) {
          throw new Error(
            `OpenMA event stream for session ${omaSessionId} ended before the Turn finished`,
          );
        }
        const event = next.result.value;
        if (typeof event.id === "string") {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
        }
        // User events are inputs (this Turn's message, steering); the
        // stream may or may not echo them.
        if (event.type.startsWith("user.")) continue;
        const mapped = managedEventToOpenMA(
          event as Parameters<typeof managedEventToOpenMA>[0],
          context(event),
        );
        if (mapped.type === "session.terminated") {
          throw new OmaSessionUnavailableError(omaSessionId);
        }
        yield mapped;
        if (isTurnTerminalEvent(mapped)) {
          turnStarts.delete(input.turnId);
          return;
        }
      }
    } finally {
      abort.abort();
      // The stream may be mid-read; its read ends with the abort.
      pending?.catch(() => undefined);
      watching.abort();
      await watcher;
      // Calls this Turn took but the kernel did not answer fail now; first
      // answer wins, so answered calls keep their answer.
      const late = await bridge.take(input.sessionId, taker).catch(() => []);
      for (const call of [...taken, ...late]) surfaced.add(call.callId);
      for (const callId of surfaced) {
        await bridge
          .resolve(callId, toolFailure("The Turn ended before this call was answered"))
          .catch(() => undefined);
      }
    }
  }

  const send = async (
    session: AgentSessionHandle,
    command: AgentCommand,
  ): Promise<void> => {
    switch (command.type) {
      case "callback.respond":
        await bridge.resolve(
          command.callbackId,
          command.error === undefined
            ? { ok: true, result: (command.result ?? null) as JsonValue }
            : { ok: false, error: command.error as JsonValue },
        );
        return;
      case "turn.cancel":
        await client.sendEvents(session.externalSessionId, [
          { type: "user.interrupt" },
        ]);
        return;
      case "turn.steer":
        await client.sendEvents(session.externalSessionId, [
          userMessage(options.content === undefined ? command.content : await options.content(command.content)),
        ]);
        return;
    }
  };

  const close = async (session: AgentSessionHandle): Promise<void> => {
    await client.archiveSession(session.externalSessionId);
  };

  return { id, capabilities, open, execute, send, close };
};
