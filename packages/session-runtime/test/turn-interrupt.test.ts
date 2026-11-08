import { describe, expect, it } from "vitest";
import { interruptTurn, type LaneStatus, type TurnInterruptPort } from "../src/turn-interrupt";

function lane(input: {
  active?: boolean;
  status?: LaneStatus | null;
  statusAfter?: LaneStatus | null;
  cancelled?: number;
  settled?: number | null;
  closed?: number;
}) {
  const calls: string[] = [];
  let statusReads = 0;
  const port: TurnInterruptPort = {
    activeTurn: () => input.active ? { abort: async () => { calls.push("abort"); } } : null,
    lastStatus: () => (statusReads++ === 0 ? input.status : input.statusAfter ?? input.status) ?? null,
    requestDurableInterrupt: async () => { calls.push("durable"); },
    ownInterruptedIdle: () => { calls.push("own"); },
    cancelQueuedInputs: () => { calls.push("cancel"); return input.cancelled ?? 0; },
    settlePendingActions: async () => { calls.push("settle"); return input.settled === undefined ? 0 : input.settled; },
    recordInterrupt: () => { calls.push("record"); },
    closeOpenToolUses: () => { calls.push("close"); return input.closed ?? 0; },
    emitIdle: () => { calls.push("idle"); },
  };
  return { port, calls };
}

describe("interruptTurn", () => {
  it("only records an interrupt against an idle lane", async () => {
    const { port, calls } = lane({ status: "idle" });
    expect(await interruptTurn(port)).toBe("recorded");
    expect(calls).toEqual(["record"]);
  });

  it("aborts the running turn, flushes the queue and ends the lane idle", async () => {
    const { port, calls } = lane({ active: true, status: "running" });
    expect(await interruptTurn(port)).toBe("interrupted");
    expect(calls).toEqual(["durable", "own", "abort", "cancel", "record", "close", "own", "idle"]);
  });

  it("ends a lane the log still shows running after its turn is gone", async () => {
    const { port, calls } = lane({ status: "running" });
    expect(await interruptTurn(port)).toBe("interrupted");
    expect(calls).toEqual(["durable", "cancel", "settle", "record", "close", "own", "idle"]);
  });

  it("emits idle without owning it when it only flushed queued inputs", async () => {
    const { port, calls } = lane({ status: null, cancelled: 2 });
    await interruptTurn(port);
    expect(calls).toEqual(["durable", "cancel", "settle", "record", "close", "idle"]);
  });

  it("emits no idle when nothing changed", async () => {
    const { port, calls } = lane({ status: null });
    await interruptTurn(port);
    expect(calls).not.toContain("idle");
  });

  it("records nothing when the runner did not confirm a parked action", async () => {
    const { port, calls } = lane({ status: null, settled: null });
    expect(await interruptTurn(port)).toBe("runner_unconfirmed");
    expect(calls).toEqual(["durable", "cancel", "settle"]);
  });
});
