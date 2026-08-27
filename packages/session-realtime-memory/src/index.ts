import type {
  AttachSessionRealtimeWriter,
  PublishSessionRealtimeFrame,
  SessionRealtimeHub,
  SessionRealtimeScope,
  SessionRealtimeWriter,
} from "@open-managed-agents/session-realtime";

export class MemorySessionRealtimeHub implements SessionRealtimeHub {
  private readonly workspaces = new Map<
    string,
    Map<string, Set<SessionRealtimeWriter>>
  >();

  attach(input: AttachSessionRealtimeWriter): () => void {
    for (const frame of input.replay ?? []) {
      if (input.writer.closed) break;
      input.writer.write(structuredClone(frame));
    }
    if (input.writer.closed) return () => undefined;

    const writers = this.writers(input, true);
    writers.add(input.writer);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      writers.delete(input.writer);
      this.compact(input);
    };
  }

  publish(input: PublishSessionRealtimeFrame): void {
    const writers = this.writers(input);
    if (writers === undefined) return;
    for (const writer of writers) {
      if (writer.closed) {
        writers.delete(writer);
        continue;
      }
      try {
        writer.write(structuredClone(input.frame));
      } catch {
        writers.delete(writer);
      }
    }
    this.compact(input);
  }

  closeSession(input: SessionRealtimeScope): void {
    const writers = this.writers(input);
    if (writers === undefined) return;
    for (const writer of writers) {
      try {
        writer.close();
      } catch {
        // Closing the remaining writers must continue.
      }
    }
    writers.clear();
    this.compact(input);
  }

  private writers(
    input: SessionRealtimeScope,
    create: true,
  ): Set<SessionRealtimeWriter>;
  private writers(
    input: SessionRealtimeScope,
    create?: false,
  ): Set<SessionRealtimeWriter> | undefined;
  private writers(
    input: SessionRealtimeScope,
    create = false,
  ): Set<SessionRealtimeWriter> | undefined {
    let sessions = this.workspaces.get(input.workspaceId);
    if (sessions === undefined) {
      if (!create) return undefined;
      sessions = new Map();
      this.workspaces.set(input.workspaceId, sessions);
    }
    const current = sessions.get(input.sessionId);
    if (current !== undefined || !create) return current;
    const writers = new Set<SessionRealtimeWriter>();
    sessions.set(input.sessionId, writers);
    return writers;
  }

  private compact(input: SessionRealtimeScope): void {
    const sessions = this.workspaces.get(input.workspaceId);
    const writers = sessions?.get(input.sessionId);
    if (writers !== undefined && writers.size === 0) {
      sessions?.delete(input.sessionId);
    }
    if (sessions !== undefined && sessions.size === 0) {
      this.workspaces.delete(input.workspaceId);
    }
  }
}
