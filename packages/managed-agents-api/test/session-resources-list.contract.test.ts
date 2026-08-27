import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionResourcesTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/resources", () => {
  it("maps cursor pagination and every official session resource variant", async () => {
    const listCalls: unknown[] = [];
    const sessionResources = makeSessionResourcesPort({
      listSessionResources: async (query: object) => {
        listCalls.push(query);
        return {
          type: "page" as const,
          page: {
            resources: [
              {
                id: "sesrsc_file_01",
                type: "file" as const,
                createdAt: "2026-08-26T05:00:00.000Z",
                fileId: "file_01",
                mountPath: "/mnt/session/uploads/file_01",
                updatedAt: "2026-08-26T05:00:00.000Z",
              },
              {
                id: "sesrsc_repo_01",
                type: "github_repository" as const,
                createdAt: "2026-08-26T05:01:00.000Z",
                mountPath: "/workspace/openma",
                updatedAt: "2026-08-26T05:02:00.000Z",
                url: "https://github.com/example/openma",
                checkout: { type: "branch" as const, name: "main" },
              },
              {
                type: "memory_store" as const,
                memoryStoreId: "memstore_01",
                access: "read_only" as const,
                description: "User preferences",
                instructions: "Use when personalization is relevant",
                mountPath: "/mnt/memory/preferences",
                name: "preferences",
              },
            ],
            nextCursor: "resource_page_02",
          },
        };
      },
    });
    const api = buildSessionResourcesTestApi(sessionResources);
    const client = new Anthropic({
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

    const page = await client.beta.sessions.resources.list(sessionWire.id, {
      limit: 20,
      page: "resource_page_01",
    });

    expect(listCalls).toEqual([
      {
        sessionId: sessionWire.id,
        pageSize: 20,
        cursor: "resource_page_01",
      },
    ]);
    expect(page.data).toEqual([
      {
        id: "sesrsc_file_01",
        type: "file",
        created_at: "2026-08-26T05:00:00.000Z",
        file_id: "file_01",
        mount_path: "/mnt/session/uploads/file_01",
        updated_at: "2026-08-26T05:00:00.000Z",
      },
      {
        id: "sesrsc_repo_01",
        type: "github_repository",
        created_at: "2026-08-26T05:01:00.000Z",
        mount_path: "/workspace/openma",
        updated_at: "2026-08-26T05:02:00.000Z",
        url: "https://github.com/example/openma",
        checkout: { type: "branch", name: "main" },
      },
      {
        type: "memory_store",
        memory_store_id: "memstore_01",
        access: "read_only",
        description: "User preferences",
        instructions: "Use when personalization is relevant",
        mount_path: "/mnt/memory/preferences",
        name: "preferences",
      },
    ]);
    expect(page.next_page).toBe("resource_page_02");
  });
});
