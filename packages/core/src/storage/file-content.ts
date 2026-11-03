export interface FileContentLocation {
  workspaceId: string;
  fileId: string;
}

export interface PutFileContent extends FileContentLocation {
  content: Uint8Array;
}

export interface FileContentStore {
  put(input: PutFileContent): Promise<void>;
  get(input: FileContentLocation): Promise<Uint8Array | null>;
  delete(input: FileContentLocation): Promise<void>;
}
