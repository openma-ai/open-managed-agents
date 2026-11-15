import { exports } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";

const headers = { "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("Cloudflare mount filters lists and refuses disabled calls before upstream (#568)", async () => {
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== "tool-filter.example.test") return originalFetch(input, init);
    const rpc = await request.json() as { id: number; method: string; params?: { name: string } };
    seen.push(rpc.method + ":" + (rpc.params?.name ?? ""));
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "tools/list"
      ? { tools: [{ name: "echo" }, { name: "hidden" }] }
      : { content: [{ type: "text", text: "ok" }] } });
  };
  const post = async (path: string, body: unknown) => exports.default.fetch(new Request("http://localhost" + path,
    { method: "POST", headers, body: JSON.stringify(body) }));
  const agentResponse = await post("/v1/agents", {
    name: "filter", model: "claude-sonnet-4-6", system: "test",
    mcp_servers: [{ name: "public", type: "url", url: "https://tool-filter.example.test/mcp" }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "public", default_config: { enabled: false }, configs: [{ name: "echo", enabled: true }] }],
  });
  expect(agentResponse.status, await agentResponse.clone().text()).toBe(201);
  const agent = await agentResponse.json() as { id: string; version: number };
  const environment = await (await post("/v1/environments", { name: "filter", config: { type: "cloud", networking: { type: "unrestricted" } } })).json() as { id: string };
  const sessionResponse = await post("/v1/sessions", { environment_id: environment.id, agent: { type: "agent", id: agent.id, version: agent.version } });
  expect(sessionResponse.status, await sessionResponse.clone().text()).toBe(201);
  const session = await sessionResponse.json() as { id: string };
  const proxy = (method: string, name = "echo") => post("/v1/oma/mcp-proxy/" + session.id + "/public",
    { jsonrpc: "2.0", id: 1, method, params: { name } });
  expect(await (await proxy("tools/list")).json()).toMatchObject({ result: { tools: [{ name: "echo" }] } });
  expect(await (await proxy("tools/call", "hidden")).json()).toMatchObject({ id: 1, error: { code: -32601 } });
  expect(await (await proxy("tools/call")).json()).toMatchObject({ result: { content: [{ text: "ok" }] } });
  expect(seen).toEqual(["tools/list:echo", "tools/call:echo"]);
});
