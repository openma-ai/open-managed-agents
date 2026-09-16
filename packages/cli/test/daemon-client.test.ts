import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createCliDaemonConnection } from "../src/bridge/lib/daemon-client.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse().splice(0)) await close(); });

it("publishes on the new connection before announcing retained sessions and routes tenant-scoped commands", async () => {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const ws = new WebSocketServer({ server });
  cleanup.push(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server");
  const frames: unknown[] = [], commands: unknown[] = [];
  let send: (message: Record<string, unknown>) => void = () => {};
  const daemon = createCliDaemonConnection({
    serverUrl: `http://127.0.0.1:${address.port}`, token: "test-only",
    manifest: async () => ({ type: "hello", machine_id: "machine", agents: [] }),
    sessions: {
      setSender(sender) { send = sender; },
      announceAll() { send({ type: "session.ready", session_id: "retained", acp_session_id: "native" }); },
      async start(input) { commands.push(input); }, async prompt(input) { commands.push(input); },
      cancel(...args) { commands.push(args); }, async dispose(sessionId) { commands.push(sessionId); },
    },
  });
  cleanup.push(() => daemon.stop());
  const connected = once(ws, "connection"); daemon.start();
  const [socket, request] = await connected;
  expect(request.headers.authorization).toBe("Bearer test-only");
  socket.on("message", (data: Buffer) => { frames.push(JSON.parse(data.toString())); });
  await expect.poll(() => frames).toEqual([{ type: "hello", machine_id: "machine", agents: [] }, { type: "session.ready", session_id: "retained", acp_session_id: "native" }]);
  socket.send(JSON.stringify({ type: "welcome" }));
  socket.send(JSON.stringify({ type: "session.start", session_id: "s", agent_id: "codex-acp", tenant_id: "workspace", resume: { acp_session_id: "old-native" } }));
  socket.send(JSON.stringify({ type: "session.prompt", session_id: "s", tenant_id: "workspace", turn_id: "t", text: "go" }));
  socket.send(JSON.stringify({ type: "session.cancel", session_id: "s", turn_id: "t" }));
  socket.send(JSON.stringify({ type: "session.dispose", session_id: "s" }));
  await expect.poll(() => commands).toEqual([
    { session_id: "s", agent_id: "codex-acp", tenant_id: "workspace", resume: { acp_session_id: "old-native" } },
    { session_id: "s", tenant_id: "workspace", turn_id: "t", text: "go" }, ["s", "t"], "s",
  ]);
  const reconnected = once(ws, "connection"); socket.terminate();
  const [next] = await reconnected;
  const replay: unknown[] = []; next.on("message", (data: Buffer) => replay.push(JSON.parse(data.toString())));
  await expect.poll(() => replay).toEqual([{ type: "hello", machine_id: "machine", agents: [] }, { type: "session.ready", session_id: "retained", acp_session_id: "native" }]);
  expect(commands).toHaveLength(4);
});
