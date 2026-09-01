import type { Session } from "../domain/session";

export interface FindSessionQuery {
  workspaceId: string;
  sessionId: string;
}

export interface SessionSourcePort {
  find(query: FindSessionQuery): Promise<Session | null>;
}
