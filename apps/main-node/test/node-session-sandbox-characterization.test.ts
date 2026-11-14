// Characterization (#545 sandbox core move): what a Node v1 Session does to
// its sandbox today, observed through the real local sandbox on disk. The
// Session sandbox core move keeps this green; deliberate changes are made in
// their own commit. Since a failed execution releases its sandbox (design
// §0.0 rule 16), the turn gets a local model that answers, so the sandbox
// outlives it.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", ...beta }, body: JSON.stringify(body) });

/** An Anthropic Messages endpoint that answers every turn with "pong". */
async function localModel(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { stream?: boolean };
    const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
    const events = [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    if (input.stream !== true) {
      // The model card capability probe.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...message, content: [{ type: "text", text: "" }], stop_reason: "end_turn" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function controlPlane(): Promise<{ cp: NodeControlPlane; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "oma-node-sandbox-"));
  dirs.push(dir);
  const config = loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  });
  const cp = await createNodeControlPlane(await nodeDefaults(config));
  created.push(cp);
  return { cp, dir };
}

function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found !== null) return found;
    } else if (entry.name === name) return path;
  }
  return null;
}

describe("Node v1 Session sandbox today (characterization)", () => {
  it("copies an attached Memory Store into the sandbox under /mnt/memory/<store>/ when the sandbox starts", async () => {
    const { cp, dir } = await controlPlane();
    const store = await (await cp.fetch(new Request("http://cp/v1/memory_stores", post({ name: "notes" })))).json() as { id: string };
    const memory = await cp.fetch(new Request(`http://cp/v1/memory_stores/${store.id}/memories`, post({ path: "/hello.md", content: "remembered" })));
    expect(memory.status).toBeLessThan(300);
    const env = await (await cp.fetch(new Request("http://cp/v1/environments", post({
      name: "env", config: { type: "cloud", networking: { type: "unrestricted" } },
    })))).json() as { id: string };
    const card = await cp.fetch(new Request("http://cp/v1/oma/model_cards", post({
      model_id: "claude-sonnet-4-6", model: "claude-sonnet-4-6", provider: "anthropic", base_url: await localModel(), api_key: "local-model",
    })));
    expect(card.status).toBeLessThan(300);
    const agent = await (await cp.fetch(new Request("http://cp/v1/agents", post({ name: "a", model: "claude-sonnet-4-6", system: "hi" })))).json() as { id: string };
    const session = await (await cp.fetch(new Request("http://cp/v1/sessions", post({
      agent: agent.id, environment_id: env.id,
      resources: [{ type: "memory_store", memory_store_id: store.id, access: "read_write" }],
    })))).json() as { id: string };
    expect(session.id).toMatch(/^session_/);

    await cp.start();
    const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, post({
      events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
    })));
    expect(sent.status).toBeLessThan(300);

    const sandboxRoot = join(dir, "sandboxes", session.id);
    let copied: string | null = null;
    for (let i = 0; i < 150 && copied === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      copied = findFile(join(sandboxRoot, ".mnt", "memory"), "hello.md");
    }
    expect(copied).not.toBeNull();
    expect(readFileSync(copied!, "utf8")).toBe("remembered");
  });
});
