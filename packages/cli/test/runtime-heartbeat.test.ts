import { describe, expect, it } from "vitest";

import { RuntimeHeartbeatLease } from "../src/bridge/lib/runtime-heartbeat";

describe("PC runtime heartbeat lease", () => {
  it("expires a half-open control-plane connection after the pong deadline", () => {
    const lease = new RuntimeHeartbeatLease({
      connectedAt: 1_000,
      pongDeadlineMs: 75_000,
    });

    expect(lease.tick(26_000)).toBe("ping");
    expect(lease.tick(75_999)).toBe("ping");
    expect(lease.tick(76_000)).toBe("expired");
  });

  it("moves the fencing deadline only when a pong is observed", () => {
    const lease = new RuntimeHeartbeatLease({
      connectedAt: 1_000,
      pongDeadlineMs: 75_000,
    });
    lease.observePong(50_000);

    expect(lease.tick(124_999)).toBe("ping");
    expect(lease.tick(125_000)).toBe("expired");
  });
});
