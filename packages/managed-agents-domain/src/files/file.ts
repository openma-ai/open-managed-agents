export interface FileScope {
  id: string;
  type: "session";
}

export interface FileMetadata {
  id: string;
  createdAt: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadable?: boolean;
  scope?: FileScope | null;
}
