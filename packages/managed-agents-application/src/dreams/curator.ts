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
