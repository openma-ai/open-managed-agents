import type {
  FindCurrentSessionResources,
  ReplaceCurrentSessionResources,
  ReplaceCurrentSessionResourcesResult,
  SessionResourceStore,
  StoredSessionResources,
} from "@open-managed-agents/session-resource-store";
import type { SessionStore } from "@open-managed-agents/session-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemorySessionResourceStore implements SessionResourceStore {
  private readonly githubTokens = new Map<string, string>();

  constructor(private readonly sessions: SessionStore) {}

  async findCurrent(
    input: FindCurrentSessionResources,
  ): Promise<StoredSessionResources | null> {
    const current = await this.sessions.findCurrent(input);
    return current === null
      ? null
      : {
          resources: clone(current.session.resources),
          revision: current.revision,
        };
  }

  async replaceCurrent(
    input: ReplaceCurrentSessionResources,
  ): Promise<ReplaceCurrentSessionResourcesResult> {
    const current = await this.sessions.findCurrent(input);
    if (current === null) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const replaced = await this.sessions.replaceCurrent({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      next: {
        ...current.session,
        resources: clone(input.resources),
        updatedAt: input.updatedAt,
      },
    });
    if (replaced.type !== "replaced") return replaced;

    for (const change of input.secretChanges) {
      const key = `${input.workspaceId}\u0000${input.sessionId}\u0000${change.resourceId}`;
      if (change.type === "store_github_token") {
        this.githubTokens.set(key, change.authorizationToken);
      } else {
        this.githubTokens.delete(key);
      }
    }
    return {
      type: "replaced",
      record: {
        resources: clone(replaced.record.session.resources),
        revision: replaced.record.revision,
      },
    };
  }
}
