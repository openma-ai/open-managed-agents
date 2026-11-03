export interface MemoryStore {
  id: string;
  createdAt: string;
  name: string;
  updatedAt: string;
  archivedAt: string | null;
  description?: string;
  metadata?: Record<string, string>;
}
