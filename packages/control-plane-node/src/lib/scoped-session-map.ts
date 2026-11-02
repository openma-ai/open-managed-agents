export interface ScopedSessionKey {
  workspaceId: string;
  sessionId: string;
}

/** Tenant-safe process-local ownership without delimiter-based composite keys. */
export class ScopedSessionMap<Value> {
  private readonly workspaces = new Map<string, Map<string, Value>>();

  has(input: ScopedSessionKey): boolean {
    return this.workspaces.get(input.workspaceId)?.has(input.sessionId) === true;
  }

  get(input: ScopedSessionKey): Value | undefined {
    return this.workspaces.get(input.workspaceId)?.get(input.sessionId);
  }

  set(input: ScopedSessionKey, value: Value): this {
    let sessions = this.workspaces.get(input.workspaceId);
    if (sessions === undefined) {
      sessions = new Map();
      this.workspaces.set(input.workspaceId, sessions);
    }
    sessions.set(input.sessionId, value);
    return this;
  }

  delete(input: ScopedSessionKey): boolean {
    const sessions = this.workspaces.get(input.workspaceId);
    if (sessions === undefined) return false;
    const deleted = sessions.delete(input.sessionId);
    if (sessions.size === 0) this.workspaces.delete(input.workspaceId);
    return deleted;
  }
}
