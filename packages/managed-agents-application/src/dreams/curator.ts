import type { DreamModel, DreamUsage } from "../domain/dream";

export interface DreamMemoryDocument {
  path: string;
  content: string;
}

export interface DreamSessionDescriptor {
  id: string;
  title: string | null;
}

export interface CurateDream {
  /** Workspace that owns the Dream; model credentials resolve against it. */
  workspaceId: string;
  inputMemories: DreamMemoryDocument[];
  inputSessions: DreamSessionDescriptor[];
  instructions: string | null;
  model: DreamModel;
}

export interface CuratedDream {
  memories: DreamMemoryDocument[];
  usage: DreamUsage;
}

export interface DreamCuratorPort {
  curate(input: CurateDream): Promise<CuratedDream>;
}
