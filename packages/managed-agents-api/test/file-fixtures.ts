import type { FileMetadataView, FilesApplicationPort } from "../src/index";

export const fileMetadataView: FileMetadataView = {
  id: "file_01",
  createdAt: "2026-08-26T12:00:00.000Z",
  filename: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  downloadable: true,
  scope: { type: "session", id: "session_01" },
};

export function makeFilesPort(
  overrides: Partial<FilesApplicationPort>,
): FilesApplicationPort {
  return {
    listFiles: async () => {
      throw new Error("unexpected listFiles application port call");
    },
    retrieveFileMetadata: async () => {
      throw new Error("unexpected retrieveFileMetadata application port call");
    },
    uploadFile: async () => {
      throw new Error("unexpected uploadFile application port call");
    },
    deleteFile: async () => {
      throw new Error("unexpected deleteFile application port call");
    },
    downloadFile: async () => {
      throw new Error("unexpected downloadFile application port call");
    },
    ...overrides,
  };
}
