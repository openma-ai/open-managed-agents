export interface ConsumerRuntimeOptions<T> {
  /** Claim one item, or return null when no work is currently available.
   * Ownership, ordering and recovery belong to this adapter. */
  claim(): Promise<T | null>;
  /** Process an owned item, including any renewal and settlement it requires.
   * A rejection is reported; this runtime never acknowledges or retries it. */
  run(item: T): Promise<void> | void;
  maxConcurrent?: number;
  pollIntervalMs?: number;
  onError?(error: unknown): void;
}

/**
 * Process-local consumption only: no queue rows, leases or business state.
 * Manual polling works before start(); start() also enables periodic polling.
 */
export class ConsumerRuntime<T> {
  readonly #maxConcurrent: number;
  readonly #pollIntervalMs: number;
  readonly #active = new Set<Promise<void>>();
  #polling: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #stopped = false;
  #generation = 0;

  constructor(private readonly options: ConsumerRuntimeOptions<T>) {
    this.#maxConcurrent = options.maxConcurrent ?? 8;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (this.#maxConcurrent < 1 || !Number.isInteger(this.#maxConcurrent)) {
      throw new Error("Consumer maxConcurrent must be a positive integer");
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#tick(++this.#generation);
  }

  /**
   * Stop issuing claims until start(). Existing work is not cancelled.
   * At most one claim can be in flight: its result is still run and tracked,
   * even if it arrives after stop(), so an acquired item is never abandoned.
   */
  stop(): void {
    this.#stopped = true;
    this.#started = false;
    this.#generation++;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Wake up immediately; concurrent calls share the current fill operation.
   * Claim failures reject to the caller. Background callers report them. */
  poll(): Promise<void> {
    if (this.#polling !== null) return this.#polling;
    if (this.#stopped) return Promise.resolve();
    const polling = this.#fillCapacity();
    this.#polling = polling;
    const clear = () => { this.#polling = null; };
    // Observe both branches without creating a rejected finally() promise.
    void polling.then(clear, clear);
    return polling;
  }

  /**
   * While accepting, consume until a poll finds no work and all runs finish.
   * After stop(), only drain existing runs and the already-issued claim.
   * No deadline or cancellation is imposed on adapter operations.
   */
  async waitForIdle(): Promise<void> {
    while (true) {
      await this.poll();
      const active = [...this.#active];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  async #fillCapacity(): Promise<void> {
    while (!this.#stopped && this.#active.size < this.#maxConcurrent) {
      const item = await this.options.claim();
      if (item === null) return;
      // Do not discard an already-issued claim when stop() races its result.
      const running = this.#run(item)
        .catch((error: unknown) => { this.#reportError(error); })
        .then(() => {
          this.#active.delete(running);
          this.#pollInBackground();
        });
      this.#active.add(running);
    }
  }

  async #run(item: T): Promise<void> {
    // Start immediately, while turning a synchronous throw into a rejection.
    await this.options.run(item);
  }

  #tick(generation: number): void {
    const schedule = () => {
      if (!this.#started || generation !== this.#generation) return;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#tick(generation);
      }, this.#pollIntervalMs);
    };
    void this.poll().then(schedule, (error: unknown) => {
      this.#reportError(error);
      schedule();
    });
  }

  #pollInBackground(): void {
    void this.poll().catch((error: unknown) => { this.#reportError(error); });
  }

  #reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // A broken observer must not stop consumption or create a rejection.
    }
  }
}
