import { supportsSandboxRuntime, type SandboxPort } from "./ports";

/**
 * Sandbox loss recovery (ADR 0005, "Sandbox disappears": reacquire, restore
 * the last committed workspace, continue from the Session event log).
 *
 * Sandboxes are cattle: the provider may reclaim one at any time (lifetime
 * expiry, node eviction, backend restart). A host wraps the sandbox it hands
 * to tools with {@link withSandboxRecovery}; when an operation fails and the
 * sandbox no longer answers a liveness probe, the host replaces it and the
 * failed operation reports that replacement explicitly. The operation is not
 * retried: it may have had effects outside the sandbox, and the files it
 * relied on may be older in the replacement, so the caller (the agent)
 * decides what to redo.
 */

export class SandboxReplacedError extends Error {
  override readonly name = "SandboxReplacedError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class SandboxRecoveryFailedError extends Error {
  override readonly name = "SandboxRecoveryFailedError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export type SandboxLiveness = "alive" | "lost" | "unknown";

/**
 * Ask the provider whether the sandbox still exists. A sandbox without the
 * runtime Port cannot be probed and reports `unknown`; hosts never replace a
 * sandbox they cannot prove lost. A failed probe is retried once so a single
 * network blip is not mistaken for a lost sandbox.
 */
export async function probeSandboxLiveness(
  sandbox: SandboxPort,
  options: { retryDelayMs?: number } = {},
): Promise<SandboxLiveness> {
  if (!supportsSandboxRuntime(sandbox)) return "unknown";
  for (let attempt = 1; ; attempt++) {
    try {
      const status = await sandbox.status();
      // A suspended sandbox resumes on its next operation; "unknown" means
      // the provider cannot tell, which is not proof of loss.
      return status === "running" || status === "suspended" || status === "unknown"
        ? "alive"
        : "lost";
    } catch {
      if (attempt >= 2) return "lost";
      const delay = options.retryDelayMs ?? 500;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Methods that never reach the provider's sandbox and so cannot reveal loss. */
const LOCAL_METHODS = new Set([
  "runtimeHandle",
  "runtimeCapabilities",
  "capabilities",
  "sessionOutputMountCapabilities",
  "supportsNativeMemoryStoreMount",
  "registerCommandSecrets",
  "setEnvVars",
]);

export interface SandboxRecoveryOptions {
  /** The sandbox currently serving the Session. */
  current(): SandboxPort;
  probe?(sandbox: SandboxPort): Promise<SandboxLiveness>;
  /**
   * Replace a lost sandbox: acquire a new one, restore the workspace and
   * prepare it, then make it `current()`. Resolves to a sentence describing
   * what the replacement contains (used in the error the caller sees).
   * Concurrent failures share one replacement.
   */
  replace(lost: SandboxPort, cause: unknown): Promise<string>;
  /** Replacements allowed before recovery gives up (default 3). */
  maxReplacements?: number;
  /** Called once when recovery gives up (too many losses or a failed
   * replacement); hosts usually fail the turn. */
  onGiveUp?(error: SandboxRecoveryFailedError): void;
}

export interface SandboxRecovery {
  sandbox: SandboxPort;
  /** Replace now if `sandbox` is lost (for example a failed lease renewal).
   * The next operation reports the replacement instead of running. */
  check(sandbox: SandboxPort, cause: unknown): Promise<void>;
  /** Stop replacing (the turn is over) after any replacement in flight has
   * settled. Resolves to the notice of a replacement no operation has
   * reported yet: the caller never learned its files were lost. */
  close(): Promise<string | null>;
  readonly replacements: number;
}

/**
 * Wrap a Session's sandbox so a lost sandbox is replaced instead of failing
 * every later operation. Only the operation that observed the loss (and
 * operations already in flight on the lost sandbox) fail, with a
 * {@link SandboxReplacedError}; later operations run on the replacement.
 */
export function withSandboxRecovery(options: SandboxRecoveryOptions): SandboxRecovery {
  const probe = options.probe ?? ((sandbox: SandboxPort) => probeSandboxLiveness(sandbox));
  const maxReplacements = options.maxReplacements ?? 3;
  let replacements = 0;
  let replacing: { lost: SandboxPort; done: Promise<string> } | null = null;
  let lastReplacement: { lost: SandboxPort; summary: string } | null = null;
  let failure: SandboxRecoveryFailedError | null = null;
  let closed = false;
  /** A proactive replacement that no operation has reported yet. */
  let unreported: string | null = null;
  const giveUp = (error: SandboxRecoveryFailedError): SandboxRecoveryFailedError => {
    if (failure === null) {
      failure = error;
      options.onGiveUp?.(error);
    }
    return failure;
  };

  const replace = (lost: SandboxPort, cause: unknown): Promise<string> => {
    if (replacing !== null && replacing.lost === lost) return replacing.done;
    if (lastReplacement !== null && lastReplacement.lost === lost) {
      return Promise.resolve(lastReplacement.summary);
    }
    if (failure !== null) return Promise.reject(failure);
    if (closed) return Promise.reject(new SandboxRecoveryFailedError("The environment stopped after the turn ended.", { cause }));
    if (replacements >= maxReplacements) {
      return Promise.reject(giveUp(new SandboxRecoveryFailedError(
        `The environment restarted ${replacements + 1} times in this turn; giving up.`,
        { cause },
      )));
    }
    replacements += 1;
    const done = options.replace(lost, cause).then(
      (summary) => {
        lastReplacement = { lost, summary };
        return summary;
      },
      (error: unknown) => {
        // The provider's reason stays with the host (cause), not the model.
        throw giveUp(new SandboxRecoveryFailedError(
          "The environment stopped and could not be restarted.",
          { cause: error },
        ));
      },
    ).finally(() => {
      if (replacing?.done === done) replacing = null;
    });
    replacing = { lost, done };
    return done;
  };

  // What the agent sees: the effect on its environment, never the sandbox,
  // the provider or its error (hosts log those from `replace`).
  const notice = (summary: string) =>
    `This tool call was interrupted because the environment restarted. ${summary} Background processes were stopped. Re-run the tool call if it is still needed.`;

  /** Turn an operation failure into a replacement when the sandbox is gone. */
  const recover = async (used: SandboxPort, error: unknown): Promise<never> => {
    if (failure !== null) throw failure;
    let lost = used !== options.current();
    if (!lost) lost = (await probe(used)) === "lost";
    if (!lost) throw error;
    const summary = await replace(used, error);
    unreported = null;
    throw new SandboxReplacedError(notice(summary));
  };

  const sandbox = new Proxy({} as SandboxPort, {
    get(_target, property) {
      const target = options.current();
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const name = String(property);
      if (LOCAL_METHODS.has(name)) return value.bind(target);
      return (...args: unknown[]) => {
        if (failure !== null) return Promise.reject(failure);
        if (unreported !== null) {
          const message = unreported;
          unreported = null;
          return Promise.reject(new SandboxReplacedError(message));
        }
        const used = options.current();
        const method = Reflect.get(used, property, used) as (...input: unknown[]) => unknown;
        let result: unknown;
        try {
          result = method.apply(used, args);
        } catch (error) {
          return recover(used, error);
        }
        if (result instanceof Promise) return result.catch((error: unknown) => recover(used, error));
        return result;
      };
    },
    has(_target, property) {
      return Reflect.has(options.current(), property);
    },
  });

  return {
    sandbox,
    async check(used, cause) {
      if (closed || failure !== null || used !== options.current()) return;
      if ((await probe(used)) !== "lost") return;
      if (closed || used !== options.current()) return;
      const pending = replace(used, cause);
      try {
        unreported = notice(await pending);
      } catch {
        // Recovery gave up; every later operation reports that failure.
      }
    },
    async close() {
      closed = true;
      await replacing?.done.catch(() => undefined);
      const pending = unreported;
      unreported = null;
      return pending;
    },
    get replacements() {
      return replacements;
    },
  };
}

export interface SandboxHeartbeatOptions {
  ttlMs: number;
  intervalMs?: number;
  /** Called when a renewal fails, with the sandbox it was sent to. */
  onRenewFailed?(sandbox: SandboxPort, error: unknown): Promise<void> | void;
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/**
 * Keep the current sandbox alive while a turn runs by renewing its provider
 * lease. Unlike {@link runWithSandboxLease}, one failed renewal does not
 * abort the turn: the host decides (usually by probing and replacing).
 * Returns a stop function; the sandbox then lives for at most `ttlMs` idle,
 * after which the provider may reclaim it and the next turn cold-restores.
 */
export function startSandboxHeartbeat(
  current: () => SandboxPort,
  options: SandboxHeartbeatOptions,
): () => Promise<void> {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new TypeError("sandbox heartbeat ttlMs must be a positive integer");
  }
  const intervalMs = options.intervalMs ?? Math.min(60_000, Math.floor(options.ttlMs / 3));
  if (!(intervalMs > 0 && intervalMs < options.ttlMs)) {
    throw new TypeError("sandbox heartbeat intervalMs must be positive and less than ttlMs");
  }
  const sleep = options.sleep ?? ((milliseconds: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, milliseconds);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    }));
  const stop = new AbortController();
  const renew = async () => {
    const sandbox = current();
    if (!supportsSandboxRuntime(sandbox) || !sandbox.runtimeCapabilities().lease) return;
    try {
      await sandbox.renewLease({ ttlMs: options.ttlMs });
    } catch (error) {
      await Promise.resolve(options.onRenewFailed?.(sandbox, error)).catch(() => undefined);
    }
  };
  const loop = (async () => {
    await renew();
    while (!stop.signal.aborted) {
      await sleep(intervalMs, stop.signal);
      if (stop.signal.aborted) return;
      await renew();
    }
  })();
  return async () => {
    stop.abort();
    await loop.catch(() => undefined);
  };
}
