// Ownership of long-lived resources created while assembling the Node control
// plane: database pools, pollers, workers, hubs, tracers.
//
// Every resource registers its stop hook at the point where it is created, so
// shutdown order is derived (reverse of creation) instead of being maintained
// by hand, a half-constructed control plane can be rolled back, and a stop
// failure never prevents the remaining resources from stopping.

export type StopHook = () => void | Promise<void>;

export interface DisposablesOptions {
  /** Called once per failing stop hook; dispose() itself never throws. */
  onError?: (name: string, error: unknown) => void;
}

export class Disposables {
  readonly #entries: Array<{ name: string; stop: StopHook }> = [];
  readonly #onError: (name: string, error: unknown) => void;
  #disposing: Promise<void> | null = null;

  constructor(options: DisposablesOptions = {}) {
    this.#onError = options.onError ?? (() => undefined);
  }

  get disposed(): boolean {
    return this.#disposing !== null;
  }

  /** Register a resource. After dispose() has started, the hook runs at once. */
  add(name: string, stop: StopHook): void {
    if (this.#disposing !== null) {
      void this.#run(name, stop);
      return;
    }
    this.#entries.push({ name, stop });
  }

  /**
   * Run a construction step; if it throws, every resource registered so far
   * (including inside the step) is stopped before the error propagates.
   */
  async guard<T>(construct: () => Promise<T> | T): Promise<T> {
    try {
      return await construct();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  /** Stop every resource in reverse registration order. Idempotent. */
  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      while (this.#entries.length > 0) {
        const { name, stop } = this.#entries.pop()!;
        await this.#run(name, stop);
      }
    })();
    return this.#disposing;
  }

  async #run(name: string, stop: StopHook): Promise<void> {
    try {
      await stop();
    } catch (error) {
      this.#onError(name, error);
    }
  }
}
