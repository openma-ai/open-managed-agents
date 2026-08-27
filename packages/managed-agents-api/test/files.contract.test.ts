import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { FilesApplicationPort } from "../src/index";
import { fileMetadataView, makeFilesPort } from "./file-fixtures";
import { buildFilesTestApi } from "./test-api";

function makeClient(port: FilesApplicationPort): Anthropic {
  const api = buildFilesTestApi(port);
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

describe("Files API — /v1/files", () => {
  it("lists files using directional application pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeFilesPort({
        listFiles: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: {
              files: [fileMetadataView],
              hasMore: true,
              firstId: "file_01",
              lastId: "file_01",
            },
          };
        },
      }),
    );

    const page = await client.beta.files.list({
      limit: 25,
      after_id: "file_cursor_01",
      scope_id: "session_01",
    });

    expect(calls).toEqual([
      {
        pageSize: 25,
        afterId: "file_cursor_01",
        scopeId: "session_01",
      },
    ]);
    expect(page.data[0]).toEqual({
      id: "file_01",
      created_at: "2026-08-26T12:00:00.000Z",
      filename: "notes.txt",
      mime_type: "text/plain",
      size_bytes: 5,
      type: "file",
      downloadable: true,
      scope: { type: "session", id: "session_01" },
    });
    expect(page.has_more).toBe(true);
    expect(page.first_id).toBe("file_01");
    expect(page.last_id).toBe("file_01");
  });

  it("retrieves file metadata", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeFilesPort({
        retrieveFileMetadata: async (query) => {
          calls.push(query);
          return { type: "found", file: fileMetadataView };
        },
      }),
    );

    const file = await client.beta.files.retrieveMetadata("file_01");

    expect(calls).toEqual([{ fileId: "file_01" }]);
    expect(file).toMatchObject({ id: "file_01", type: "file" });
  });

  it("adapts multipart upload into filename, MIME type, and bytes", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeFilesPort({
        uploadFile: async (command) => {
          calls.push({
            filename: command.filename,
            mimeType: command.mimeType,
            content: Array.from(command.content),
          });
          return { type: "uploaded", file: fileMetadataView };
        },
      }),
    );

    const file = await client.beta.files.upload({
      file: new File(["hello"], "notes.txt", { type: "text/plain" }),
    });

    expect(calls).toEqual([
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        content: [104, 101, 108, 108, 111],
      },
    ]);
    expect(file.id).toBe("file_01");
  });

  it("downloads bytes without exposing HTTP response types to the port", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeFilesPort({
        downloadFile: async (query) => {
          calls.push(query);
          return {
            type: "found",
            file: {
              content: new TextEncoder().encode("hello"),
              mimeType: "text/plain",
              filename: "notes.txt",
            },
          };
        },
      }),
    );

    const response = await client.beta.files.download("file_01");

    expect(calls).toEqual([{ fileId: "file_01" }]);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("deletes a file and returns the official tombstone", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeFilesPort({
        deleteFile: async (command) => {
          calls.push(command);
          return { type: "deleted", fileId: "file_01" };
        },
      }),
    );

    const deleted = await client.beta.files.delete("file_01");

    expect(calls).toEqual([{ fileId: "file_01" }]);
    expect(deleted).toEqual({ id: "file_01", type: "file_deleted" });
  });
});
