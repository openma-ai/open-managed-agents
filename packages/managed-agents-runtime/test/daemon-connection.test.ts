import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DaemonConnection, type DaemonChannel, type DaemonConnectionState } from "../src/daemon-connection.js";

// Only the network boundary is substituted; lifecycle, callbacks and timers
// run through the same class that CLI and Backchat consume.
class Socket extends EventEmitter {
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  open() { this.readyState = 1; this.emit("open"); }
  receive(message: unknown) { this.emit("message", Buffer.from(JSON.stringify(message))); }
  send(payload: string) { if (this.readyState !== 1) throw new Error("closed"); this.frames.push(JSON.parse(payload)); }
  close() { this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
  terminate() { this.close(); }
}
const connections: DaemonConnection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.stop(); vi.useRealTimers(); });
function setup(onOpen?: (channel: DaemonChannel) => Promise<void>) {
  vi.useFakeTimers();
  const sockets: Socket[] = [], states: DaemonConnectionState[] = [], messages: Record<string, unknown>[] = [];
  const connection = new DaemonConnection({
    openSocket() { const socket = new Socket(); sockets.push(socket); return socket; },
    onOpen: onOpen ?? (async (channel) => { channel.send({ type: "hello", machine_id: "machine" }); }),
    onMessage(message) { messages.push(message); },
    onState(state) { states.push(state); },
  });
  connections.push(connection);
  return { connection, sockets, states, messages };
}

it("starts once, publishes the manifest, and waits for the service welcome before reporting online", async () => {
  const { connection, sockets, states, messages } = setup();
  connection.start(); connection.start();
  expect(sockets).toHaveLength(1);
  sockets[0].open(); await Promise.resolve();
  expect(sockets[0].frames).toEqual([{ type: "hello", machine_id: "machine" }]);
  expect(states).toEqual(["connecting"]);
  sockets[0].receive({ type: "welcome" });
  sockets[0].receive({ type: "session.prompt", session_id: "s", turn_id: "t", text: "go" });
  expect(states.at(-1)).toBe("online");
  expect(messages).toEqual([{ type: "welcome" }, { type: "session.prompt", session_id: "s", turn_id: "t", text: "go" }]);
});

it("fences an unresponsive socket and reconnects without replaying session input", async () => {
  const { connection, sockets, states, messages } = setup();
  connection.start(); sockets[0].open();
  sockets[0].receive({ type: "session.prompt", text: "only once" });
  await vi.advanceTimersByTimeAsync(75_000);
  expect(sockets[0].readyState).toBe(3);
  expect(states.at(-1)).toBe("offline");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets).toHaveLength(2);
  sockets[0].receive({ type: "session.prompt", text: "stale" });
  sockets[1].open(); await Promise.resolve();
  expect(sockets[1].frames).toEqual([{ type: "hello", machine_id: "machine" }]);
  expect(messages).toEqual([{ type: "session.prompt", text: "only once" }]);
});

it("extends liveness only on server pong and bounds a handshake that never opens", async () => {
  const first = setup(); first.connection.start(); first.sockets[0].open();
  await vi.advanceTimersByTimeAsync(50_000);
  first.sockets[0].receive({ type: "pong" });
  await vi.advanceTimersByTimeAsync(50_000);
  expect(first.sockets).toHaveLength(1);
  expect(first.sockets[0].readyState).toBe(1);
  first.connection.stop();
  const second = setup(); second.connection.start();
  await vi.advanceTimersByTimeAsync(76_000);
  expect(second.sockets).toHaveLength(2);
  expect(second.sockets[0].readyState).toBe(3);
});

it.each([[409, "occupied"], [401, "expired"], [403, "expired"], [404, "expired"]] as const)("does not retry a terminal HTTP %s attachment rejection", async (statusCode, state) => {
  const { connection, sockets, states } = setup(); connection.start();
  let consumed = false;
  sockets[0].emit("unexpected-response", {}, { statusCode, resume() { consumed = true; } });
  expect(consumed).toBe(true);
  expect(states.at(-1)).toBe(state);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(sockets).toHaveLength(1);
});

it("stops pending reconnects and makes a late asynchronous greeting unable to write", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { connection, sockets, states } = setup(async (channel) => { await pending; channel.send({ type: "hello" }); });
  connection.start(); sockets[0].open(); connection.stop();
  release(); await Promise.resolve();
  expect(sockets[0].frames).toEqual([]);
  expect(connection.send({ type: "session.complete" })).toBe(false);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(sockets).toHaveLength(1);
  expect(states.at(-1)).toBe("stopped");
});

it("recovers from transient rejection or socket creation errors with bounded backoff", async () => {
  const { connection, sockets, states } = setup(); connection.start();
  sockets[0].emit("unexpected-response", {}, { statusCode: 503, resume() {} });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets).toHaveLength(2);
  sockets[1].emit("error", new Error("offline"));
  await vi.advanceTimersByTimeAsync(1_999); expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(3);
  connection.stop();
  let attempts = 0;
  const failing = new DaemonConnection({ openSocket() { attempts++; throw new Error("offline"); }, onOpen: async () => {}, onMessage() {}, onState(state) { states.push(state); } });
  connections.push(failing); failing.start();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(attempts).toBe(2);
  expect(states.at(-1)).toBe("offline");
});
