/** Cancellation primitives one turn's startup and execution share. */

export function cancellationError(reason?: string): Error {
  const error = new Error(reason && reason.length > 0 ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return cancellationError(typeof reason === "string" ? reason : undefined);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => {};
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Rejects when `signal` aborts without waiting out `operation`. A value that
 * arrives afterwards is passed to `abandon` so a sandbox is not leaked. */
export function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abandon?: (value: T) => Promise<void>,
): Promise<T> {
  const leave = (value: T) => {
    if (abandon === undefined) return;
    void abandon(value).catch(() => undefined);
  };
  if (signal.aborted) {
    void operation.then(leave, () => undefined);
    return Promise.reject(abortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      finish(() => {
        void operation.then(leave, () => undefined);
        reject(abortedError(signal));
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        finish(() => {
          if (signal.aborted) {
            leave(value);
            reject(abortedError(signal));
            return;
          }
          resolve(value);
        });
      },
      (error) => {
        finish(() => {
          reject(signal.aborted ? abortedError(signal) : error);
        });
      },
    );
  });
}
