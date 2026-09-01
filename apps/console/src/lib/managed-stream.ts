export type ManagedDeltaStream = "agent.message" | "agent.thinking";

export interface ManagedDeltaState {
  kinds: Map<string, ManagedDeltaStream>;
  text: Map<string, string>;
}

export type ManagedDeltaAction =
  | { type: "open"; stream: ManagedDeltaStream; id: string }
  | { type: "append"; stream: ManagedDeltaStream; id: string; text: string }
  | { type: "close"; stream: ManagedDeltaStream; id: string };

export function reduceManagedDeltaFrame(
  current: ManagedDeltaState,
  frame: Record<string, unknown>,
): { state: ManagedDeltaState; action?: ManagedDeltaAction } {
  const kinds = new Map(current.kinds);
  const text = new Map(current.text);

  if (frame.type === "event_start" && isRecord(frame.event)) {
    const id = frame.event.id;
    const stream = frame.event.type;
    if (
      typeof id === "string" &&
      (stream === "agent.message" || stream === "agent.thinking")
    ) {
      kinds.set(id, stream);
      text.set(id, "");
      return { state: { kinds, text }, action: { type: "open", stream, id } };
    }
  }

  if (
    frame.type === "event_delta" &&
    typeof frame.event_id === "string" &&
    isRecord(frame.delta) &&
    isRecord(frame.delta.content) &&
    frame.delta.type === "content_delta" &&
    frame.delta.content.type === "text" &&
    typeof frame.delta.content.text === "string"
  ) {
    const id = frame.event_id;
    const stream = kinds.get(id);
    if (stream !== undefined) {
      const delta = frame.delta.content.text;
      text.set(id, `${text.get(id) ?? ""}${delta}`);
      return {
        state: { kinds, text },
        action: { type: "append", stream, id, text: delta },
      };
    }
  }

  if (
    (frame.type === "agent.message" || frame.type === "agent.thinking") &&
    typeof frame.id === "string" &&
    kinds.get(frame.id) === frame.type
  ) {
    const id = frame.id;
    const stream = frame.type;
    kinds.delete(id);
    text.delete(id);
    return { state: { kinds, text }, action: { type: "close", stream, id } };
  }

  return { state: current };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
