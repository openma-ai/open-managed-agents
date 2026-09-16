import { expect, it } from "vitest";
import { DaemonHost } from "../src/daemon-host.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const summary = { initialTurns: 1, abortedTurns: 0, sessions: 1 };
function setup() {
  const drain = deferred<typeof summary>();
  const dispose = deferred<void>();
  const events: string[] = [];
  const host = new DaemonHost({
    connection: { start() { events.push("connect"); }, stop() { events.push("disconnect"); } },
    sessions: {
      drain(deadlineMs) { events.push(`drain:${deadlineMs}`); return drain.promise; },
      disposeAll() { events.push("dispose"); return dispose.promise; },
    },
    drainDeadlineMs: 10_000,
  });
  return { host, events, drain, dispose };
}

it("keeps the connection until session drain completes and shares concurrent shutdown", async () => {
  const { host, events, drain } = setup();
  host.start(); host.start();
  const stopped = host.stop();
  expect(host.stop()).toBe(stopped);
  expect(events).toEqual(["connect", "drain:10000"]);
  drain.resolve(summary);
  await expect(stopped).resolves.toEqual({ kind: "drained", summary });
  host.start();
  expect(events).toEqual(["connect", "drain:10000", "disconnect"]);
});

it("forces owned session disposal without waiting for a stuck drain", async () => {
  const { host, events, dispose, drain } = setup();
  host.start();
  const stopped = host.stop();
  expect(host.stop({ force: true })).toBe(stopped);
  expect(host.stop({ force: true })).toBe(stopped);
  expect(events).toEqual(["connect", "drain:10000", "disconnect", "dispose"]);
  dispose.resolve();
  await expect(stopped).resolves.toEqual({ kind: "forced" });
  // A late drain failure must be handled, and must not repeat shutdown.
  drain.reject(new Error("late drain failure"));
  await Promise.resolve(); await Promise.resolve();
  expect(events).toEqual(["connect", "drain:10000", "disconnect", "dispose"]);
});

it("cleans up owned sessions after drain failure before reporting the error", async () => {
  const { host, events, dispose, drain } = setup();
  host.start();
  const stopped = host.stop();
  const failure = expect(stopped).rejects.toThrow("drain failed");
  drain.reject(new Error("drain failed"));
  await Promise.resolve(); await Promise.resolve();
  expect(events).toContain("dispose");
  dispose.resolve();
  await failure;
  expect(events.at(-1)).toBe("disconnect");
});

it("still releases the connection when both drain and cleanup fail", async () => {
  const { host, events, dispose, drain } = setup();
  host.start();
  const stopped = host.stop();
  const failure = expect(stopped).rejects.toThrow();
  drain.reject(new Error("drain failed"));
  await Promise.resolve();
  dispose.reject(new Error("cleanup failed"));
  await failure;
  expect(events.at(-1)).toBe("disconnect");
});

it("stopping before start prevents acquiring any connection", async () => {
  const { host, events, drain } = setup();
  const stopped = host.stop();
  host.start();
  drain.resolve(summary);
  await stopped;
  expect(events).not.toContain("connect");
});
