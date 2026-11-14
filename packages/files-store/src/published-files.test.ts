import { expect, it } from "vitest";
import { withPublishedSessionFiles } from "./published-files";
import { FileService } from "./service";
import { InMemoryFileRepo } from "./test-fakes";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application";

it("exposes only published bytes after idle, pages outputs, and reflects deletion", async () => {
  const published = new Map<string, string>();
  const base: FilesApplicationPort = {
    listFiles: async () => ({ type: "page", page: { files: [], hasMore: false, firstId: null, lastId: null } }),
    retrieveFileMetadata: async () => ({ type: "not_found" }), downloadFile: async () => ({ type: "not_found" }),
    uploadFile: async () => { throw Error("unused"); }, deleteFile: async () => ({ type: "not_found" }),
  };
  const app = withPublishedSessionFiles(base, { workspaceId: "tenant", service: new FileService({ repo: new InMemoryFileRepo() }),
    outputs: { async listAfter(input) {
      expect(input.tenantId).toBe("tenant");
      if (input.sessionId !== "session") return [];
      return [...published.keys()].sort().filter(name => input.startAfterFilename === undefined || name > input.startAfterFilename).slice(0, input.limit)
        .map(filename => ({ filename, sizeBytes: published.get(filename)!.length, uploadedAtMs: 1000 }));
    } },
    async read(session, filename) {
      const content = session === "session" ? published.get(filename) : undefined;
      return content === undefined ? null : { metadata: { filename, mimeType: "text/plain", sizeBytes: content.length, createdAt: new Date(1000).toISOString() }, content: new TextEncoder().encode(content) };
    },
  });
  expect((await app.listFiles({ scopeId: "session" }))).toMatchObject({ type: "page", page: { files: [] } });
  // Upload completion is independent of idle: the publisher commits bytes later.
  published.set("a.txt", "complete-a"); published.set("b.txt", "complete-b");
  const first = await app.listFiles({ scopeId: "session", pageSize: 1 });
  expect(first.type).toBe("page"); if (first.type !== "page") throw Error("page");
  expect(first.page.files.map(x => x.filename)).toEqual(["a.txt"]);
  const id = first.page.files[0]!.id;
  expect(await app.downloadFile({ fileId: id })).toMatchObject({ type: "found", file: { content: new TextEncoder().encode("complete-a") } });
  expect(await app.retrieveFileMetadata({ fileId: id })).toMatchObject({ type: "found", file: { downloadable: true, scope: { id: "session" } } });
  const second = await app.listFiles({ scopeId: "session", pageSize: 1, afterId: first.page.lastId! });
  expect(second).toMatchObject({ type: "page", page: { files: [{ filename: "b.txt" }], hasMore: false } });
  published.delete("a.txt");
  expect(await app.downloadFile({ fileId: id })).toEqual({ type: "not_found" });
  expect(await app.listFiles({ scopeId: "other" })).toMatchObject({ type: "page", page: { files: [] } });
});
