import type { Session } from "../domain/session";

export interface FindDreamSession {
  workspaceId: string;
  sessionId: string;
}

export interface DreamSessionSourcePort {
  find(input: FindDreamSession): Promise<Session | null>;
}
