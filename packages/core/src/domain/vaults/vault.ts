export interface Vault {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  displayName: string;
  metadata: Record<string, string>;
  updatedAt: string;
}
