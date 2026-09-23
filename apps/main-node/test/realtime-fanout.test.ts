import { describe, expect, it } from "vitest";
import { resolveRealtimeFanout } from "../src/realtime-fanout";

describe("resolveRealtimeFanout", () => {
  it("selects the cross-replica mode from the database dialect by default", () => {
    expect(resolveRealtimeFanout({}, "sqlite")).toEqual({ mode: "memory", pollIntervalMs: 300 });
    expect(resolveRealtimeFanout({}, "postgres").mode).toBe("pg-notify");
    expect(resolveRealtimeFanout({}, "mysql").mode).toBe("sql-poll");
  });

  it("accepts explicit modes and poll interval", () => {
    expect(
      resolveRealtimeFanout(
        { OMA_REALTIME_FANOUT: "sql-poll", OMA_REALTIME_POLL_INTERVAL_MS: "500" },
        "postgres",
      ),
    ).toEqual({ mode: "sql-poll", pollIntervalMs: 500 });
    expect(resolveRealtimeFanout({ OMA_REALTIME_FANOUT: "memory" }, "mysql").mode).toBe("memory");
  });

  it("rejects invalid configuration", () => {
    expect(() => resolveRealtimeFanout({ OMA_REALTIME_FANOUT: "redis" }, "mysql")).toThrow(
      /OMA_REALTIME_FANOUT/,
    );
    expect(() => resolveRealtimeFanout({ OMA_REALTIME_FANOUT: "pg-notify" }, "mysql")).toThrow(
      /postgres/,
    );
    expect(() => resolveRealtimeFanout({ OMA_REALTIME_POLL_INTERVAL_MS: "10" }, "mysql")).toThrow(
      /OMA_REALTIME_POLL_INTERVAL_MS/,
    );
  });
});
