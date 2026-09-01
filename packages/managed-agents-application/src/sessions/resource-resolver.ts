import type {
  SessionResource,
  SessionResourceInput,
} from "../domain/session-resource";
import type { SessionResourceSecret } from "@open-managed-agents/session-store";

export interface ResolveSessionResources {
  workspaceId: string;
  sessionId: string;
  createdAt: string;
  resources: SessionResourceInput[];
}

export type ResolvedSessionResourceSecret = SessionResourceSecret;

export type ResolveSessionResourcesResult =
  | {
      type: "resolved";
      resources: SessionResource[];
      secrets: ResolvedSessionResourceSecret[];
    }
  | { type: "invalid_request"; message: string }
  | { type: "dependency_not_found"; message: string };

export interface SessionResourceResolverPort {
  resolve(input: ResolveSessionResources): Promise<ResolveSessionResourcesResult>;
}
