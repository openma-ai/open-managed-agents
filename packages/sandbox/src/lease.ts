import type { SandboxRuntimePort } from "./ports";

export interface SandboxLeaseScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface RunWithSandboxLeaseOptions {
  ttlMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  scheduler?: SandboxLeaseScheduler;
}

export class SandboxLeaseLostError extends Error {
  override readonly name = "SandboxLeaseLostError";

  constructor(
    readonly runtimeId: string,
    options?: { cause?: unknown },
  ) {
    super(`sandbox runtime ${runtimeId} lost its lease`, options);
  }
}

const systemLeaseScheduler: SandboxLeaseScheduler = {
  sleep(milliseconds, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      signal.addEventListener("abort", finish, { once: true });
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
    });
  },
};

/** Keep a provider-owned sandbox lease alive only while `operation` runs.
 * Losing a renewal fences the operation through its abort signal and rejects
 * immediately, so the caller can dispose protocol children and recover from
 * its logical checkpoint. */
export async function runWithSandboxLease<Result>(
  runtime: SandboxRuntimePort,
  options: RunWithSandboxLeaseOptions,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new TypeError("sandbox lease ttlMs must be positive");
  }
  const intervalMs = options.intervalMs ?? Math.min(30_000, options.ttlMs / 2);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= options.ttlMs) {
    throw new TypeError("sandbox lease intervalMs must be positive and less than ttlMs");
  }
  const handle = runtime.runtimeHandle();
  const lost = (cause: unknown) =>
    new SandboxLeaseLostError(handle.runtimeId, { cause });

  try {
    await runtime.renewLease({ ttlMs: options.ttlMs });
  } catch (cause) {
    throw lost(cause);
  }

  const operationController = new AbortController();
  const heartbeatController = new AbortController();
  const forwardExternalAbort = () =>
    operationController.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardExternalAbort();
  else options.signal?.addEventListener("abort", forwardExternalAbort, { once: true });

  let rejectLeaseLoss!: (error: SandboxLeaseLostError) => void;
  const leaseLoss = new Promise<never>((_resolve, reject) => {
    rejectLeaseLoss = reject;
  });
  const scheduler = options.scheduler ?? systemLeaseScheduler;
  const operationPromise = Promise.resolve().then(() =>
    operation(operationController.signal)
  );
  const heartbeatPromise = (async () => {
    while (!heartbeatController.signal.aborted) {
      await scheduler.sleep(intervalMs, heartbeatController.signal);
      if (heartbeatController.signal.aborted) return;
      try {
        await runtime.renewLease({ ttlMs: options.ttlMs });
      } catch (cause) {
        const error = lost(cause);
        operationController.abort(error);
        rejectLeaseLoss(error);
        return;
      }
    }
  })();

  try {
    return await Promise.race([operationPromise, leaseLoss]);
  } finally {
    heartbeatController.abort();
    options.signal?.removeEventListener("abort", forwardExternalAbort);
    await heartbeatPromise.catch(() => undefined);
    // If lease loss won the race, observe a later operation rejection rather
    // than leaving it as an unhandled promise.
    void operationPromise.catch(() => undefined);
  }
}
