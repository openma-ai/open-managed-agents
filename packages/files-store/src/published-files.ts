import type { FilesApplicationPort, FileMetadataView } from "@open-managed-agents/managed-agents-application";
import type { FileService } from "./service";
import { decodeOutputId } from "./output-id";
import { unifiedPageErrorMessage, type SessionOutputPageSource } from "./unified-page";

/** Project the existing published output set into the managed Files surface.
 * No staging directory or execution status is a publication signal.
 */
export function withPublishedSessionFiles(files: FilesApplicationPort, input: {
  workspaceId: string;
  service: Pick<FileService, "listUnifiedPage">;
  outputs: SessionOutputPageSource;
  read(sessionId: string, filename: string): Promise<{ metadata: Omit<FileMetadataView, "id" | "scope" | "downloadable">; content: Uint8Array } | null>;
}): FilesApplicationPort {
  const read = async (fileId: string) => {
    const decoded = decodeOutputId(fileId);
    if (!decoded || decoded.filename.includes("\0") || decoded.filename.split("/").includes("..")) return null;
    const result = await input.read(decoded.sessionId, decoded.filename);
    return result && { ...result, file: { ...result.metadata, id: fileId, scope: { type: "session" as const, id: decoded.sessionId }, downloadable: true } };
  };
  return {
    uploadFile: command => files.uploadFile(command),
    deleteFile: command => files.deleteFile(command),
    async listFiles(query) {
      if (!query.scopeId) return files.listFiles(query);
      const page = await input.service.listUnifiedPage({ tenantId: input.workspaceId, scopeId: query.scopeId,
        limit: Math.min(Math.max(query.pageSize ?? 20, 1), 100), beforeId: query.afterId, afterId: query.beforeId, outputs: input.outputs });
      if (!page.ok) return { type: "invalid_request", message: unifiedPageErrorMessage(page.error) };
      const entries = await Promise.all(page.items.map(async item => {
        if (item.source === "d1") {
          const original = await files.retrieveFileMetadata({ fileId: item.id });
          if (original.type === "found") return original.file;
        }
        return ({ id: item.id, filename: item.filename, mimeType: item.mediaType,
        sizeBytes: item.sizeBytes, createdAt: item.createdAt, downloadable: item.downloadable,
        ...(item.sessionId ? { scope: { type: "session" as const, id: item.sessionId } } : {}) });
      }));
      return { type: "page", page: { files: entries, hasMore: page.hasMore, firstId: entries[0]?.id ?? null,
        lastId: page.nextCursor ?? entries.at(-1)?.id ?? null } };
    },
    async retrieveFileMetadata(query) {
      if (!decodeOutputId(query.fileId)) return files.retrieveFileMetadata(query);
      const result = await read(query.fileId);
      return result ? { type: "found", file: result.file } : { type: "not_found" };
    },
    async downloadFile(query) {
      if (!decodeOutputId(query.fileId)) return files.downloadFile(query);
      const result = await read(query.fileId);
      return result ? { type: "found", file: { content: result.content, filename: result.file.filename, mimeType: result.file.mimeType } } : { type: "not_found" };
    },
  };
}
