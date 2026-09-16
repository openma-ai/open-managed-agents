export interface DaemonDrainSummary {
  initialTurns: number;
  abortedTurns: number;
  sessions: number;
}
export type DaemonStopResult =
  | { kind: "drained"; summary: DaemonDrainSummary }
  | { kind: "forced" };

export interface DaemonHostOptions {
  connection: { start(): void; stop(): void };
  sessions: {
    /** Must close admission synchronously, then drain and dispose owned sessions. */
    drain(deadlineMs: number, options?: { onProgress?: (active: number, msLeft: number) => void }): Promise<DaemonDrainSummary>;
    disposeAll(): Promise<void>;
  };
  drainDeadlineMs: number;
  onProgress?: (active: number, msLeft: number) => void;
}

/** Lifecycle of an execution host owned by this caller, never an external daemon.
 * Session admission/execution remain with the supplied session manager. Process
 * signals, PID files, IPC, discovery and process exit belong to outer adapters.
 */
export class DaemonHost {
  readonly #options: DaemonHostOptions;
  #phase: "idle" | "running" | "stopping" | "stopped" = "idle";
  #forced = false;
  #closed = false;
  #disposal?: Promise<void>;
  #stopped?: Promise<DaemonStopResult>;
  #resolve!: (result: DaemonStopResult) => void;
  #reject!: (error: unknown) => void;

  constructor(options: DaemonHostOptions) { this.#options = options; }

  start(): void {
    if (this.#phase !== "idle") return;
    this.#phase = "running";
    this.#options.connection.start();
  }

  stop(options: { force?: boolean } = {}): Promise<DaemonStopResult> {
    if (!this.#stopped) {
      this.#stopped = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
      this.#phase = "stopping";
      if (!options.force) void this.#drain();
    }
    if (options.force && !this.#forced && this.#phase !== "stopped") {
      this.#forced = true;
      // Release the transport immediately on escalation. Disposal still needs
      // to finish before the embedding host can consider shutdown complete.
      let closeError: unknown;
      try { this.#close(); } catch (error) { closeError = error; }
      void this.#dispose().then(
        () => this.#finish({ kind: "forced" }, closeError),
        (error) => this.#finish({ kind: "forced" }, error),
      );
    }
    return this.#stopped;
  }

  async #drain(): Promise<void> {
    try {
      const summary = await this.#options.sessions.drain(this.#options.drainDeadlineMs, { onProgress: this.#options.onProgress });
      if (!this.#forced) this.#finish({ kind: "drained", summary });
    } catch (error) {
      if (this.#forced) return;
      let failure = error;
      try { await this.#dispose(); }
      catch (cleanupError) { failure = new AggregateError([error, cleanupError], "Daemon drain and cleanup failed"); }
      if (!this.#forced) this.#finish({ kind: "forced" }, failure);
    }
  }

  #dispose(): Promise<void> {
    return this.#disposal ??= (async () => { await this.#options.sessions.disposeAll(); })();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.connection.stop();
  }

  #finish(result: DaemonStopResult, error?: unknown): void {
    if (this.#phase === "stopped") return;
    this.#phase = "stopped";
    try { this.#close(); } catch (closeError) { error ??= closeError; }
    if (error !== undefined) this.#reject(error);
    else this.#resolve(result);
  }
}
