export type RuntimeHeartbeatAction = "ping" | "expired";

/** Monotonic connection-local lease. Sending ping is not proof of liveness;
 * only a server pong advances the deadline. */
export class RuntimeHeartbeatLease {
  readonly #pongDeadlineMs: number;
  #lastPongAt: number;

  constructor(input: { connectedAt: number; pongDeadlineMs: number }) {
    if (!Number.isFinite(input.connectedAt)) {
      throw new TypeError("runtime heartbeat connectedAt must be finite");
    }
    if (!Number.isFinite(input.pongDeadlineMs) || input.pongDeadlineMs <= 0) {
      throw new TypeError("runtime heartbeat pongDeadlineMs must be positive");
    }
    this.#lastPongAt = input.connectedAt;
    this.#pongDeadlineMs = input.pongDeadlineMs;
  }

  observePong(receivedAt: number): void {
    if (!Number.isFinite(receivedAt)) return;
    this.#lastPongAt = Math.max(this.#lastPongAt, receivedAt);
  }

  tick(now: number): RuntimeHeartbeatAction {
    return now - this.#lastPongAt >= this.#pongDeadlineMs
      ? "expired"
      : "ping";
  }
}
