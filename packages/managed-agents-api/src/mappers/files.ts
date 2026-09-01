import type { FileListQuery } from "../contracts/files";
import type {
  DeleteFileCommand,
  DownloadFileQuery,
  FileMetadataView,
  ListFilesQuery,
  RetrieveFileMetadataQuery,
  UploadFileCommand,
} from "../ports/files";

export function toListFilesQuery(query: FileListQuery): ListFilesQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.before_id !== undefined && { beforeId: query.before_id }),
    ...(query.after_id !== undefined && { afterId: query.after_id }),
    ...(query.scope_id !== undefined && { scopeId: query.scope_id }),
  };
}

export function toRetrieveFileMetadataQuery(
  fileId: string,
): RetrieveFileMetadataQuery {
  return { fileId };
}

export function toUploadFileCommand(file: File): Promise<UploadFileCommand> {
  return file.arrayBuffer().then((content) => ({
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    content: new Uint8Array(content),
  }));
}

export function toDeleteFileCommand(fileId: string): DeleteFileCommand {
  return { fileId };
}

export function toDownloadFileQuery(fileId: string): DownloadFileQuery {
  return { fileId };
}

export function toFileMetadataResponse(file: FileMetadataView): object {
  return {
    id: file.id,
    created_at: file.createdAt,
    filename: file.filename,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    type: "file",
    ...(file.downloadable !== undefined && {
      downloadable: file.downloadable,
    }),
    ...(file.scope !== undefined && { scope: file.scope }),
  };
}
