import type { ModelMessage } from "ai";
import type {
  HarnessRuntime,
  HistoryStore,
} from "@open-managed-agents/agent/harness/interface";
import {
  eventsToMessages,
  eventsToMessagesAsync,
  type FileResolver,
} from "@open-managed-agents/agent/runtime/history";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import type {
  SessionBootstrapEvent,
  RuntimeProducedSessionEvent,
  SessionEventView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import {
  decodeRuntimeProducedSessionEvent,
  encodeRuntimeHistoryEvent,
  encodeRuntimeSessionEvent,
} from "@open-managed-agents/managed-agents-adapters-runtime";

type UnstampedRuntimeProducedSessionEvent =
  RuntimeProducedSessionEvent extends infer Event
    ? Event extends { id: string; processedAt: string }
      ? Omit<Event, "id" | "processedAt">
      : never
    : never;

class ManagedNodeHistoryStore implements HistoryStore {
  private readonly events: SessionEvent[];

  constructor(
    initialEvents: SessionBootstrapEvent[],
    events: SessionEventView[],
  ) {
    this.events = [
      ...initialEvents.map(
        (event) => encodeRuntimeSessionEvent(event) as SessionEvent,
      ),
      ...events.map(toHarnessHistoryEvent),
    ];
  }

  append(event: SessionEvent): void {
    this.events.push(event);
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    if (afterSeq === undefined) return this.events.slice();
    return this.events.filter(
      (event) => (event as SessionEvent & { seq?: number }).seq! > afterSeq,
    );
  }

  getMessages(): ModelMessage[] {
    return managedNodeEventsToMessages(this.events);
  }
}

interface ManagedHarnessSystemMessageEvent {
  type: "system.message";
  content: Array<{ type: "text"; text: string }>;
}

function asSystemMessage(
  event: SessionEvent,
): ManagedHarnessSystemMessageEvent | null {
  const candidate = event as SessionEvent | ManagedHarnessSystemMessageEvent;
  return candidate.type === "system.message" ? candidate : null;
}

function projectManagedHistorySegments(
  events: SessionEvent[],
  project: (segment: SessionEvent[]) => ModelMessage[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let segment: SessionEvent[] = [];
  for (const event of events) {
    const systemMessage = asSystemMessage(event);
    if (systemMessage === null) {
      segment.push(event);
      continue;
    }
    messages.push(...project(segment));
    segment = [];
    messages.push({
      role: "system",
      content: systemMessage.content.map((block) => block.text).join("\n"),
    });
  }
  messages.push(...project(segment));
  return messages;
}

export function managedNodeEventsToMessages(
  events: SessionEvent[],
): ModelMessage[] {
  return projectManagedHistorySegments(events, eventsToMessages);
}

export async function managedNodeEventsToMessagesAsync(
  events: SessionEvent[],
  resolver?: FileResolver,
): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];
  let segment: SessionEvent[] = [];
  for (const event of events) {
    const systemMessage = asSystemMessage(event);
    if (systemMessage === null) {
      segment.push(event);
      continue;
    }
    messages.push(...await eventsToMessagesAsync(segment, resolver));
    segment = [];
    messages.push({
      role: "system",
      content: systemMessage.content.map((block) => block.text).join("\n"),
    });
  }
  messages.push(...await eventsToMessagesAsync(segment, resolver));
  return messages;
}

function toHarnessHistoryEvent(event: SessionEventView): SessionEvent {
  if (event.type === "user.define_outcome") {
    const rubric = event.rubric.type === "text"
      ? event.rubric.content
      : `[rubric file: ${event.rubric.fileId}]`;
    const task: Extract<SessionEvent, { type: "user.message" }> = {
      id: event.id,
      type: "user.message",
      content: [{
        type: "text",
        text: [
          `<outcome id="${event.outcomeId}">`,
          event.description,
          "",
          "Rubric:",
          rubric,
          "</outcome>",
        ].join("\n"),
      }],
      ...(event.processedAt != null && { processed_at: event.processedAt }),
    };
    return task;
  }
  if (
    event.type === "user.custom_tool_result" ||
    event.type === "user.tool_result"
  ) {
    const result: Extract<SessionEvent, { type: "agent.tool_result" }> = {
      id: event.id,
      type: "agent.tool_result",
      tool_use_id:
        event.type === "user.custom_tool_result"
          ? event.customToolUseId
          : event.toolUseId,
      content: (event.content ?? []).map(toHarnessToolResultContent),
      ...(event.processedAt != null && { processed_at: event.processedAt }),
    };
    return result;
  }
  return encodeRuntimeHistoryEvent(event) as SessionEvent;
}

function toHarnessToolResultContent(
  block: ToolResultContentBlock,
): ContentBlock {
  if (block.type === "text") return block;
  if (block.type === "search_result") {
    return {
      type: "text",
      text: JSON.stringify({
        title: block.title,
        source: block.source,
        content: block.content,
        citations: block.citations,
      }),
    };
  }
  if (block.type === "image") {
    switch (block.source.type) {
      case "base64":
        return {
          type: "image",
          source: {
            type: "base64",
            data: block.source.data,
            media_type: block.source.mediaType,
          },
        };
      case "url":
        return {
          type: "image",
          source: { type: "url", url: block.source.url },
        };
      case "file":
        return {
          type: "image",
          source: { type: "file", file_id: block.source.fileId },
        };
    }
  }
  const source = (() => {
    switch (block.source.type) {
      case "base64":
      case "text":
        return {
          type: block.source.type,
          data: block.source.data,
          media_type: block.source.mediaType,
        };
      case "url":
        return { type: "url" as const, url: block.source.url };
      case "file":
        return { type: "file" as const, file_id: block.source.fileId };
    }
  })();
  return {
    type: "document",
    source,
    ...(typeof block.title === "string" && { title: block.title }),
    ...(typeof block.context === "string" && { context: block.context }),
  };
}

export interface ManagedNodeHarnessRuntimeInput {
  initialEvents: SessionBootstrapEvent[];
  events: SessionEventView[];
  sandbox: SandboxExecutor;
  abortSignal?: AbortSignal;
  output(frame: unknown): Promise<void>;
  clock: { now(): Date };
  ids: { nextEventId(): string };
}

export class ManagedNodeHarnessRuntime implements HarnessRuntime {
  readonly history: HistoryStore;
  readonly sandbox: SandboxExecutor;
  readonly abortSignal?: AbortSignal;
  private readonly applicationHistoryEvents: SessionEventView[];
  private outputChain: Promise<void> = Promise.resolve();

  constructor(private readonly input: ManagedNodeHarnessRuntimeInput) {
    this.history = new ManagedNodeHistoryStore(
      input.initialEvents,
      input.events,
    );
    this.sandbox = input.sandbox;
    this.abortSignal = input.abortSignal;
    this.applicationHistoryEvents = structuredClone(input.events);
  }

  broadcast = (event: SessionEvent): void => {
    const frame = structuredClone(event) as SessionEvent & {
      id?: string;
      processed_at?: string;
    };
    if (typeof frame.id !== "string") frame.id = this.input.ids.nextEventId();
    if (typeof frame.processed_at !== "string") {
      frame.processed_at = this.input.clock.now().toISOString();
    }
    this.history.append(frame);
    const applicationEvent = decodeRuntimeProducedSessionEvent(frame);
    if (applicationEvent !== null) {
      this.applicationHistoryEvents.push(applicationEvent);
    }
    void this.enqueue(frame);
  };

  broadcastProducedEvent(event: UnstampedRuntimeProducedSessionEvent): string {
    const stamped = {
      ...event,
      id: this.input.ids.nextEventId(),
      processedAt: this.input.clock.now().toISOString(),
    } as RuntimeProducedSessionEvent;
    const frame = encodeRuntimeHistoryEvent(stamped) as SessionEvent;
    this.history.append(frame);
    this.applicationHistoryEvents.push(stamped);
    void this.enqueue(frame);
    return stamped.id;
  }

  getApplicationHistoryEvents(): SessionEventView[] {
    return structuredClone(this.applicationHistoryEvents);
  }

  appendOutcomeFeedback(iteration: number, explanation: string): void {
    this.history.append({
      type: "user.message",
      content: [{
        type: "text",
        text: [
          `<outcome_feedback iteration="${iteration}">`,
          explanation || "(no explanation)",
          "",
          "Address the feedback and try again.",
          "</outcome_feedback>",
        ].join("\n"),
      }],
    });
  }

  broadcastStreamStart = (messageId: string): Promise<void> =>
    this.enqueue({
      type: "agent.message_stream_start",
      message_id: messageId,
    });

  broadcastChunk = (messageId: string, delta: string): Promise<void> =>
    this.enqueue({
      type: "agent.message_chunk",
      message_id: messageId,
      delta,
    });

  broadcastStreamEnd = (
    messageId: string,
    status: "completed" | "aborted",
    errorText?: string,
  ): Promise<void> =>
    this.enqueue({
      type: "agent.message_stream_end",
      message_id: messageId,
      status,
      ...(errorText !== undefined && { error_text: errorText }),
    });

  broadcastThinkingStart = (thinkingId: string): Promise<void> =>
    this.enqueue({
      type: "agent.thinking_stream_start",
      thinking_id: thinkingId,
    });

  broadcastThinkingChunk = (
    thinkingId: string,
    delta: string,
  ): Promise<void> =>
    this.enqueue({
      type: "agent.thinking_chunk",
      thinking_id: thinkingId,
      delta,
    });

  broadcastThinkingEnd = (
    thinkingId: string,
    status: "completed" | "aborted",
  ): Promise<void> =>
    this.enqueue({
      type: "agent.thinking_stream_end",
      thinking_id: thinkingId,
      status,
    });

  broadcastToolInputStart = (
    toolUseId: string,
    toolName?: string,
  ): Promise<void> =>
    this.enqueue({
      type: "agent.tool_use_input_stream_start",
      tool_use_id: toolUseId,
      ...(toolName !== undefined && { tool_name: toolName }),
    });

  broadcastToolInputChunk = (
    toolUseId: string,
    delta: string,
  ): Promise<void> =>
    this.enqueue({
      type: "agent.tool_use_input_chunk",
      tool_use_id: toolUseId,
      delta,
    });

  broadcastToolInputEnd = (
    toolUseId: string,
    status: "completed" | "aborted",
  ): Promise<void> =>
    this.enqueue({
      type: "agent.tool_use_input_stream_end",
      tool_use_id: toolUseId,
      status,
    });

  async drain(): Promise<void> {
    await this.outputChain;
  }

  private enqueue(frame: unknown): Promise<void> {
    const output = this.outputChain.then(() => this.input.output(frame));
    this.outputChain = output;
    return output;
  }
}
