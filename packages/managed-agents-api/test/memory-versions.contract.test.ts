import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { MemoryVersionsApplicationPort } from "../src/index";
import {
  makeMemoryVersionsPort,
  memoryVersionView,
} from "./memory-fixtures";
import { buildMemoryTestApi } from "./test-api";

function makeClient(port: MemoryVersionsApplicationPort): Anthropic {
  const api = buildMemoryTestApi({ memoryVersions: port });
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

describe("Agent Memory API — memory versions", () => {
  it("retrieves a version with projection semantics", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoryVersionsPort({
        retrieveMemoryVersion: async (query) => {
          calls.push(query);
          return { type: "found", version: memoryVersionView };
        },
      }),
    );

    const version = await client.beta.memoryStores.memoryVersions.retrieve(
      "memver_01",
      { memory_store_id: "memstore_01", view: "full" },
    );

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_01",
        projection: "full",
      },
    ]);
    expect(version).toMatchObject({
      id: "memver_01",
      created_by: { type: "api_actor", api_key_id: "apikey_01" },
      type: "memory_version",
    });
  });

  it("lists versions with every filter and actor variant", async () => {
    const calls: unknown[] = [];
    const versions = [
      memoryVersionView,
      {
        ...memoryVersionView,
        id: "memver_02",
        createdBy: {
          kind: "service_account" as const,
          serviceAccountId: "svac_01",
        },
      },
      {
        ...memoryVersionView,
        id: "memver_03",
        createdBy: { kind: "session" as const, sessionId: "session_01" },
      },
      {
        ...memoryVersionView,
        id: "memver_04",
        createdBy: { kind: "user" as const, userId: "user_01" },
      },
    ];
    const client = makeClient(
      makeMemoryVersionsPort({
        listMemoryVersions: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { versions, nextCursor: "version_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.memoryStores.memoryVersions.list(
      "memstore_01",
      {
        limit: 10,
        page: "version_page_01",
        api_key_id: "apikey_01",
        "created_at[gte]": "2026-08-01T00:00:00Z",
        "created_at[lte]": "2026-08-31T23:59:59Z",
        memory_id: "mem_01",
        operation: "modified",
        service_account_id: "svac_01",
        session_id: "session_01",
        view: "basic",
      },
    );

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        pageSize: 10,
        cursor: "version_page_01",
        apiKeyId: "apikey_01",
        createdAtOrAfter: "2026-08-01T00:00:00Z",
        createdAtOrBefore: "2026-08-31T23:59:59Z",
        memoryId: "mem_01",
        operation: "modified",
        serviceAccountId: "svac_01",
        sessionId: "session_01",
        projection: "basic",
      },
    ]);
    expect(page.data.map((item) => item.created_by?.type)).toEqual([
      "api_actor",
      "service_account_actor",
      "session_actor",
      "user_actor",
    ]);
    expect(page.next_page).toBe("version_page_02");
  });

  it("redacts a memory version", async () => {
    const calls: unknown[] = [];
    const redacted = {
      ...memoryVersionView,
      content: null,
      contentSha256: null,
      contentSizeBytes: null,
      path: null,
      redactedAt: "2026-08-26T14:40:00.000Z",
      redactedBy: { kind: "user" as const, userId: "user_01" },
    };
    const client = makeClient(
      makeMemoryVersionsPort({
        redactMemoryVersion: async (command) => {
          calls.push(command);
          return { type: "redacted", version: redacted };
        },
      }),
    );

    const version = await client.beta.memoryStores.memoryVersions.redact(
      "memver_01",
      { memory_store_id: "memstore_01" },
    );

    expect(calls).toEqual([
      { memoryStoreId: "memstore_01", memoryVersionId: "memver_01" },
    ]);
    expect(version).toMatchObject({
      redacted_at: "2026-08-26T14:40:00.000Z",
      redacted_by: { type: "user_actor", user_id: "user_01" },
    });
  });
});
