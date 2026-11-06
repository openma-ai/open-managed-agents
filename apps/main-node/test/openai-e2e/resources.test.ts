import { once } from "node:events";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedMcpServer } from "../../../../test/fakes/scripted-mcp-server";
import { bootOpenAINode } from "../_helpers/openai-node-process";

const fixtures: Array<Awaited<ReturnType<typeof bootOpenAINode>>> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose(); });
async function boot() {
  const fixture = await bootOpenAINode(() => ({ text: "RESOURCE_SESSION_DONE" }), { startupTimeoutMs: 60_000 });
  fixtures.push(fixture);
  return fixture;
}
const model = "claude-sonnet-4-20250514";

describe("OpenAI resources through the production Node service", () => {
  // Catches saved-agent edits retroactively changing an existing session snapshot,
  // unstable pagination identities, and deletion leaking back into active listings.
  it("keeps session configuration immutable while saved agents are edited and deleted", async () => {
    const f = await boot();
    const first = await f.client.beta.agents.create({ model, name: "Original", instructions: "ORIGINAL_INSTRUCTIONS", metadata: { old: "remove" } });
    const before = await f.client.beta.agents.sessions.create({ agent_id: first.id, environment: { type: "none" }, input: "First task" });
    await expect.poll(async () => (await f.client.beta.agents.sessions.turns.list(before.id)).data[0]?.status, { timeout: 15_000 }).toBe("completed");
    await f.client.beta.agents.update(first.id, { name: "Updated", instructions: "UPDATED_INSTRUCTIONS", metadata: { current: "keep" } });
    const second = await f.client.beta.agents.create({ model, name: "Second" });
    const after = await f.client.beta.agents.sessions.create({ agent_id: first.id, environment: { type: "none" }, input: "Second task" });
    await expect.poll(async () => (await f.client.beta.agents.sessions.turns.list(after.id)).data[0]?.status, { timeout: 15_000 }).toBe("completed");

    expect((await f.client.beta.agents.sessions.retrieve(before.id)).agent.instructions).toBe("ORIGINAL_INSTRUCTIONS");
    expect((await f.client.beta.agents.sessions.retrieve(after.id)).agent.instructions).toBe("UPDATED_INSTRUCTIONS");
    expect(await f.client.beta.agents.retrieve(first.id)).toMatchObject({ name: "Updated", metadata: { current: "keep" } });
    const ids: string[] = [];
    for await (const agent of f.client.beta.agents.list({ order: "asc", limit: 1 })) ids.push(agent.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(await f.client.beta.agents.delete(first.id)).toMatchObject({ id: first.id, deleted: true });
    await expect(f.client.beta.agents.retrieve(first.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect((await f.client.beta.agents.list()).data.map(agent => agent.id)).toEqual([second.id]);
    expect((await f.client.beta.agents.sessions.retrieve(before.id)).agent.instructions).toBe("ORIGINAL_INSTRUCTIONS");
  }, 150_000);

  it("creates, retrieves, and lists sessions for a saved agent with HTTP MCP", async () => {
    const mcp = createScriptedMcpServer({
      tools: [{ name: "ping", description: "Return a test value", inputSchema: { type: "object" } }],
      callTool: () => ({ content: [{ type: "text", text: "MCP_PING_OK" }] }),
    });
    const server = serve({ fetch: request => mcp.fetch(request), port: 0, hostname: "127.0.0.1" });
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address for the MCP server");
      const transport = { type: "http" as const, server_url: `http://127.0.0.1:${address.port}/mcp` };
      const f = await bootOpenAINode(input => JSON.stringify(input.messages).includes("MCP_PING_OK")
        ? { text: "RESOURCE_SESSION_DONE" }
        : { name: "mcp__lookup__ping", input: {} }, { localSandbox: true });
      fixtures.push(f);
      const api = f.client.beta.agents;
      const saved = await api.create({ model, tools: [{ type: "mcp", server_label: "lookup", transport }] });
      expect((await api.retrieve(saved.id)).tools).toEqual([
        expect.objectContaining({ transport: { ...transport, headers: {} } }),
      ]);
      const template = await api.environments.templates.create({ name: "MCP session environment" });
      const input = "Call ping once";
      const session = await api.sessions.create({
        agent_id: saved.id, environment: { type: "openai_hosted", environment_template_id: template.id }, input,
      });
      expect(session.agent.tools).toEqual([expect.objectContaining({ type: "mcp", server_label: "lookup", transport })]);
      expect((await api.sessions.retrieve(session.id)).agent.tools).toEqual(session.agent.tools);
      expect((await api.sessions.list({ agent_id: saved.id })).data).toEqual([
        expect.objectContaining({ id: session.id, agent: expect.objectContaining({ tools: session.agent.tools }) }),
      ]);
      await expect.poll(async () => (await api.sessions.turns.list(session.id)).data, { timeout: 30_000 }).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      const items = (await api.sessions.items.list(session.id)).data;
      expect(items.filter(item => item.type === "message" && item.role === "user")).toEqual([
        expect.objectContaining({ content: [expect.objectContaining({ type: "input_text", text: input })] }),
      ]);
      expect(mcp.state.counts["tools/call"]).toBe(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 150_000);

  // Catches loss of real SQL-backed resource configuration on restart and secret
  // disclosure through SDK responses; no tool connects to the synthetic MCP URL.
  it("persists vaults and environment templates across restart without disclosing secrets", async () => {
    const f = await boot();
    const vault = await f.client.beta.agents.vaults.create({ name: "E2E vault" });
    const credential = await f.client.beta.agents.vaults.credentials.create(vault.id, {
      name: "Service", auth: { type: "static_bearer", token: "e2e-private-token", mcp_server_url: "https://mcp.example.test" },
    });
    const template = await f.client.beta.agents.environments.templates.create({ name: "Stored configuration", env: { TOKEN: "e2e-private-env" }, files: [{ type: "inline", path: "/workspace/input.txt", data: "aGVsbG8=" }] });
    await f.restart();
    expect(await f.client.beta.agents.vaults.retrieve(vault.id)).toMatchObject({ id: vault.id, name: "E2E vault" });
    const restoredCredential = await f.client.beta.agents.vaults.credentials.retrieve(credential.id, { vault_id: vault.id });
    const restoredTemplate = await f.client.beta.agents.environments.templates.retrieve(template.id);
    expect(restoredCredential).toMatchObject({ id: credential.id, auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.test" } });
    expect(restoredTemplate).toMatchObject({ id: template.id, files: [{ type: "inline", path: "/workspace/input.txt", size_bytes: 5 }] });
    expect(JSON.stringify([restoredCredential, restoredTemplate])).not.toMatch(/e2e-private-token|e2e-private-env|aGVsbG8=/);

    await f.client.beta.agents.vaults.credentials.update(credential.id, { vault_id: vault.id, auth: { type: "static_bearer", token: "e2e-rotated-private-token" } });
    expect((await f.client.beta.agents.vaults.credentials.list(vault.id)).data).toEqual([expect.objectContaining({ id: credential.id, name: "Service" })]);
    expect(JSON.stringify(await f.client.beta.agents.vaults.credentials.retrieve(credential.id, { vault_id: vault.id }))).not.toContain("e2e-rotated-private-token");
    await f.client.beta.agents.environments.templates.update(template.id, { name: "Cleared", env: null, files: null });
    expect(await f.client.beta.agents.environments.templates.retrieve(template.id)).toMatchObject({ name: "Cleared", files: [] });
    await f.client.beta.agents.environments.templates.delete(template.id);
    await expect(f.client.beta.agents.environments.templates.retrieve(template.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await f.client.beta.agents.vaults.delete(vault.id);
    await expect(f.client.beta.agents.vaults.retrieve(vault.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await expect(f.client.beta.agents.vaults.credentials.retrieve(credential.id, { vault_id: vault.id })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  }, 150_000);

  // Catches accidental acceptance of unimplemented runtime configuration and
  // partial session creation before validation fails.
  it("rejects unsupported execution settings without leaving a session behind", async () => {
    const f = await boot();
    const saved = await f.client.beta.agents.create({ model, reasoning: { effort: "low" } });
    const sessionsBefore = (await f.client.beta.agents.sessions.list()).data.map(session => session.id);
    await expect(f.client.beta.agents.sessions.create({ agent_id: saved.id, environment: { type: "none" }, input: "This must not run" })).rejects.toMatchObject({ status: 501 });
    expect((await f.client.beta.agents.sessions.list()).data.map(session => session.id)).toEqual(sessionsBefore);
    expect(f.requests).toHaveLength(0);
    await expect(f.client.beta.agents.sessions.retrieve("missing-session")).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  }, 150_000);
});
