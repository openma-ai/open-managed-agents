import { BidirectionalPageCursor, PageCursor, PagePromise } from "@anthropic-ai/sdk/core/pagination";
import { expect, expectTypeOf, it } from "vitest";
import { OpenMA, type OpenMaAgent, type OpenMaSession } from "../src/index.js";

const agent: OpenMaAgent = {
  id: "agent_parent", type: "agent", name: "Parent", version: 1,
  description: null, model: { id: "claude-opus-5" }, mcp_servers: [],
  skills: [], system: null, tools: [], metadata: {}, archived_at: null,
  created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z",
  multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" }, subagents: { type: "disabled" }, workflows: { type: "disabled" } },
};
const session = {
  id: "session_parent", type: "session", agent,
  archived_at: null, budget: null, created_at: "2026-10-22T00:00:00Z", environment_id: "env_test", metadata: {}, outcome_evaluations: [], resources: [], stats: {}, status: "idle", title: null, updated_at: "2026-10-22T00:00:00Z", usage: {}, vault_ids: [],
};

function paginationClient(item: unknown) {
  const requests: Request[] = [];
  const client = new OpenMA({ apiKey: "test", baseURL: "https://openma.test", maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const next = new URL(request.url).searchParams.get("page") === "page_two";
      return new Response(JSON.stringify({ data: [item], next_page: next ? null : "page_two", prev_page: next ? "page_one" : null }), { headers: { "content-type": "application/json" } });
    },
  });
  return { client, requests };
}

it.each(["agents", "versions"] as const)("preserves real %s PagePromise iteration and resolved topology types", async (resource) => {
  const { client, requests } = paginationClient(agent);
  const pending = resource === "agents"
    ? client.beta.agents.list({ limit: 1 })
    : client.beta.agents.versions.list("agent_parent", { limit: 1 });
  expectTypeOf(pending).toEqualTypeOf<PagePromise<PageCursor<OpenMaAgent>, OpenMaAgent>>();
  expect(pending).toBeInstanceOf(PagePromise);
  const page = await pending;
  expect(page).toBeInstanceOf(PageCursor);
  expectTypeOf(page.data).toEqualTypeOf<OpenMaAgent[]>();
  expect(page.hasNextPage()).toBe(true);
  const versions: number[] = [];
  for await (const entry of pending) {
    expectTypeOf(entry).toEqualTypeOf<OpenMaAgent>();
    expect(entry.multiagent?.type).toBe("multiagent_20261001");
    versions.push(entry.version);
  }
  expect(versions).toEqual([1, 1]);
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(resource === "agents" ? ["/v1/agents", "/v1/agents"] : ["/v1/agents/agent_parent/versions", "/v1/agents/agent_parent/versions"]);
  expect(requests.map((r) => new URL(r.url).searchParams.get("page"))).toEqual([null, "page_two"]);
  expect(requests.every((r) => r.method === "GET" && new URL(r.url).searchParams.get("limit") === "1")).toBe(true);
});

it("preserves bidirectional session pages and typed snapshots across getNextPage", async () => {
  const { client, requests } = paginationClient(session);
  const pending = client.beta.sessions.list({ limit: 1 });
  expectTypeOf(pending).toEqualTypeOf<PagePromise<BidirectionalPageCursor<OpenMaSession>, OpenMaSession>>();
  const page = await pending;
  expect(page).toBeInstanceOf(BidirectionalPageCursor);
  expectTypeOf(page.data).toEqualTypeOf<OpenMaSession[]>();
  const next = await page.getNextPage();
  expectTypeOf(next.data).toEqualTypeOf<OpenMaSession[]>();
  expect(next.prev_page).toBe("page_one");
  expect(next.hasNextPage()).toBe(false);
  expect(next.data[0]?.agent.multiagent?.type).toBe("multiagent_20261001");
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/sessions", "/v1/sessions"]);
  expect(new URL(requests[1]!.url).searchParams.get("page")).toBe("page_two");
});

it("archives agents with the resolved topology response and official transport", async () => {
  let captured: Request | undefined;
  const client = new OpenMA({ apiKey: "test", baseURL: "https://openma.test", maxRetries: 0,
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return new Response(JSON.stringify({ ...agent, archived_at: "2026-10-22T01:00:00Z" }), { headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.beta.agents.archive("agent_parent", null, { headers: { "x-test": "archive" } });
  expectTypeOf(result.multiagent).toEqualTypeOf<OpenMaAgent["multiagent"]>();
  expect(result.multiagent?.type).toBe("multiagent_20261001");
  expect(result.archived_at).toBe("2026-10-22T01:00:00Z");
  expect(captured!.method).toBe("POST");
  expect(new URL(captured!.url).pathname).toBe("/v1/agents/agent_parent/archive");
  expect(captured!.headers.get("x-test")).toBe("archive");
});
