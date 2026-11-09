/** CF alarm wall time is 15 minutes. Stop new work after 13 minutes, leaving
 * two minutes for ACP cancellation, persistence and execution settlement.
 * https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type
 * This is not a Promise.race: the invocation always awaits the turn's cleanup.
 * An uncooperative runtime reset is recovered by the persisted execution lease. */
export class TurnInvocation {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly signal = this.#controller.signal;
  constructor(budgetMs = 13 * 60_000) {
    this.#timer = setTimeout(() => this.#controller.abort(
      new Error("Turn exceeded the Cloudflare invocation wall-time budget"),
    ), budgetMs);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    try { return await work(); }
    finally { this.signal.throwIfAborted(); }
  }
  close(): void { clearTimeout(this.#timer); }
}
