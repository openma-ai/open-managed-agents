import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];
async function fixture(status = 200) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { id: "agent_1", name: "Team" } : { error: "invalid multiagent" }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return {
    requests,
    run: (...args: string[]) => exec(process.execPath, ["--import", "tsx", entry, "agents", ...args], {
      env: { ...process.env, OMA_BASE_URL: `http://127.0.0.1:${address.port}`, OMA_API_KEY: "test-key" },
      timeout: 10000,
    }),
  };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))));
});

it("does not use a flag value as the create name", async () => {
  const f = await fixture();
  await f.run("create", "--model", "model-x", "Team");
  expect(f.requests).toEqual([{ method: "POST", path: "/v1/agents", body: { name: "Team", model: "model-x", system: "", tools: [{ type: "agent_toolset_20260401" }] } }]);
});

it.each(["create", "update"])("%s preserves explicit nulls and self/pinned JSON references", async command => {
  const f = await fixture();
  const json = '{"type":"multiagent_20261001","advisor":null,"subagents":{"type":"enabled","inline_agents":null,"predefined_agents":["agent_latest",{"type":"self"},{"type":"agent","id":"agent_pinned","version":3}]}}';
  await f.run(command, command === "create" ? "Team" : "agent_1", "--multiagent", json);
  expect(f.requests).toEqual([{ method: "POST", path: command === "create" ? "/v1/agents" : "/v1/agents/agent_1", body: {
    ...(command === "create" ? { name: "Team", model: "claude-sonnet-4-6", system: "", tools: [{ type: "agent_toolset_20260401" }] } : {}),
    multiagent: { type: "multiagent_20261001", advisor: null, subagents: { type: "enabled", inline_agents: null, predefined_agents: ["agent_latest", { type: "self" }, { type: "agent", id: "agent_pinned", version: 3 }] } },
  } }]);
});

it.each([
  ["--name", "Renamed"], ["--multiagent", "null"],
  ["--multiagent", '{"type":"multiagent_20261001"}'],
  ["--multiagent", '{"type":"multiagent_20261001","subagents":null}'],
])("update sends only supplied patch fields: %s %s", async (flag, value) => {
  const f = await fixture();
  await f.run("update", "agent_1", flag, value);
  expect(f.requests).toEqual([{ method: "POST", path: "/v1/agents/agent_1", body: flag === "--name" ? { name: "Renamed" } : { multiagent: JSON.parse(value) } }]);
});

it("retains inline-only and repeated subagent shortcuts", async () => {
  const f = await fixture();
  await f.run("create", "Team", "--inline-only");
  await f.run("update", "agent_1", "--subagent", "agent_a", "--subagent", "agent_b:2");
  expect(f.requests).toMatchObject([
    { body: { multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] } } } },
    { body: { multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [{ type: "agent", id: "agent_a" }, { type: "agent", id: "agent_b", version: 2 }] } } } },
  ]);
});

it.each([
  ["create", "--model", "model-x"], ["create", "Team", "--subagent"],
  ["create", "Team", "--subagent", "--inline-only"], ["create", "Team", "--model"],
  ["create", "Team", "--runtime", "runtime_1"], ["create", "Team", "--unknown", "x"],
  ["create", "Team", "--name", "Other"], ["create", "Team", "Extra"],
  ["create", "Team", "--inline-only", "--subagent", "agent_a"],
  ["create", "Team", "--subagent", "agent_a:0"],
  ["update", "agent_1"], ["update", "--name", "Team"],
  ["update", "agent_1", "--multiagent"], ["update", "agent_1", "--multiagent", "{"],
  ["update", "agent_1", "--multiagent", "[]"],
  ["update", "agent_1", "--multiagent", '{"type":"old"}'],
  ["update", "agent_1", "--multiagent", "null", "--inline-only"],
  ["update", "agent_1", "--name", "One", "--name", "Two"],
])("rejects invalid arguments before any HTTP request: %j", async (...args) => {
  const f = await fixture();
  await expect(f.run(...args)).rejects.toMatchObject({ code: 1, stderr: expect.any(String) });
  expect(f.requests).toEqual([]);
});

it("propagates API validation errors instead of reporting success", async () => {
  const f = await fixture(400);
  await expect(f.run("update", "agent_1", "--multiagent", '{"type":"multiagent_20261001","advisor":{"type":"enabled"}}')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("invalid multiagent") });
  expect(f.requests).toHaveLength(1);
});
