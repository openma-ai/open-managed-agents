import { withPublishedSessionFiles } from "@open-managed-agents/files-store";
import type { NodeFoundation } from "../modules/node-foundation";

/** Adapt Node published output storage to the shared managed Files projection. */
export function nodePublishedSessionFiles(
  files: Parameters<typeof withPublishedSessionFiles>[0],
  workspaceId: string,
  service: NodeFoundation["filesService"],
  outputs: NodeFoundation["sessionOutputs"],
) {
    return withPublishedSessionFiles(files, { workspaceId, service,
      outputs: { async listAfter(input) {
        return (await outputs.list(input.tenantId, input.sessionId) ?? [])
          .filter(entry => input.startAfterFilename === undefined || entry.filename > input.startAfterFilename)
          .sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0).slice(0, input.limit)
          .map(entry => ({ filename: entry.filename, sizeBytes: entry.size_bytes, uploadedAtMs: Date.parse(entry.uploaded_at), mediaType: entry.media_type }));
      } },
      async read(sessionId, filename) {
        const metadata = (await outputs.list(workspaceId, sessionId) ?? []).find(entry => entry.filename === filename);
        if (!metadata) return null;
        const object = await outputs.read(workspaceId, sessionId, filename);
        return object ? { metadata: { filename, mimeType: metadata.media_type, sizeBytes: metadata.size_bytes, createdAt: metadata.uploaded_at },
          content: new Uint8Array(await new Response(object.body).arrayBuffer()) } : null;
      },
    });
}
