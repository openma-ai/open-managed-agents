import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildSessionEventRoutes } from "../src";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { sessionWire } from "./session-fixtures";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

async function collectGarbage() {
  for (let round = 0; round < 6; round += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Managed Agents API — events/stream memory", () => {
  it("does not keep delivered events reachable while the connection stays open", async () => {
    const total = 200;
    const delivered: WeakRef<object>[] = [];
    let stall: (result: IteratorResult<never>) => void = () => {};
    const iterator: AsyncIterator<never> = {
      next() {
        if (delivered.length >= total) {
          return new Promise((resolve) => {
            stall = resolve;
          });
        }
        const event = {
          id: `event_${delivered.length + 1}`,
          type: "agent.message" as const,
          processedAt: "2026-08-26T02:00:00.000Z",
          content: [{ type: "text" as const, text: "x".repeat(10_000) }],
        };
        delivered.push(new WeakRef(event));
        return Promise.resolve({ value: event as never, done: false });
      },
      return() {
        stall({ value: undefined as never, done: true });
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
    const port = makeSessionEventsPort({
      streamSessionEvents: async () => ({
        type: "stream",
        events: { [Symbol.asyncIterator]: () => iterator },
      }),
    });
    const api = new Hono().route(
      "/v1/sessions",
      buildSessionEventRoutes(port),
    );
    const response = await api.request(
      `/v1/sessions/${sessionWire.id}/events/stream`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );
    const reader = response.body!.getReader();
    let frames = 0;
    while (frames < total) {
      const { done } = await reader.read();
      if (done) throw new Error("stream ended early");
      frames += 1;
    }

    await collectGarbage();
    const stillReachable = delivered.filter((ref) => ref.deref() !== undefined)
      .length;
    await reader.cancel();

    expect(frames).toBe(total);
    // Only the event the route is currently handling may stay alive.
    expect(stillReachable).toBeLessThanOrEqual(1);
  });
});
