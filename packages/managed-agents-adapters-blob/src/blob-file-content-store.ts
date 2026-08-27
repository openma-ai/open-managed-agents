import type { BlobStore } from "@open-managed-agents/blob-store";
import type {
  FileContentLocation,
  FileContentStore,
  PutFileContent,
} from "@open-managed-agents/file-content-store";

export class BlobFileContentStore implements FileContentStore {
  constructor(private readonly blobs: BlobStore) {}

  async put(input: PutFileContent): Promise<void> {
    const result = await this.blobs.put(this.key(input), input.content);
    if (result === null) {
      throw new Error("File content write was rejected");
    }
  }

  async get(input: FileContentLocation): Promise<Uint8Array | null> {
    const object = await this.blobs.get(this.key(input));
    return object === null ? null : object.bytes();
  }

  async delete(input: FileContentLocation): Promise<void> {
    await this.blobs.delete(this.key(input));
  }

  private key(input: FileContentLocation): string {
    return [
      "managed-files",
      encodeURIComponent(input.workspaceId),
      encodeURIComponent(input.fileId),
    ].join("/");
  }
}
