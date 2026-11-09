import { TurnDeadlineError } from "@open-managed-agents/session-runtime";

/** Provisional limit (acceptance unresolved): execution stops at 13 minutes, with at most
 * 110 seconds more for cleanup; ten seconds remain for durable settlement.
 * No alarm relay is implemented. Uncooperative work is fenced by lease recovery.
 * https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type */
export class TurnInvocation {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #cleanupAt: number;
  readonly signal = this.#controller.signal;
  constructor(budgetMs = 13 * 60_000, cleanupMs = 110_000) {
    this.#cleanupAt = Date.now() + budgetMs + cleanupMs;
    this.#timer = setTimeout(() => this.#controller.abort(
      new TurnDeadlineError("invocation_deadline", "Turn exceeded the Cloudflare invocation wall-time budget"),
    ), budgetMs);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    try { return await work(); }
    finally { this.signal.throwIfAborted(); }
  }
  /** RPC cannot be cancelled, but may not hold the public turn running forever.
   * Its durable execution fence still rejects writes by a replacement owner. */
  async cleanup<T>(work: () => Promise<T>): Promise<T> {
    const remaining = this.#cleanupAt - Date.now();
    if (remaining <= 0) throw new TurnDeadlineError("cleanup_deadline", "Turn cleanup exceeded its total budget");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TurnDeadlineError("cleanup_deadline", "Turn cleanup exceeded its total budget")), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  close(): void { clearTimeout(this.#timer); }
}
