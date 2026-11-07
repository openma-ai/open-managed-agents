import type { SandboxFactoryContext, SandboxPort } from "./ports";
import {
  SandboxCapabilityMissingError,
  SandboxNotReadyError,
  SandboxProvisionFailedError,
  SandboxReleasedError,
  type SandboxPersistenceCapabilities,
  type SandboxReleaseReason,
  type SessionSandbox,
  type SessionSandboxDriver,
  type SessionSandboxState,
} from "./session-sandbox-port";

/*
 * Shared readiness semantics for every runtime (ADR 0014 §2, §9).
 *
 * A Session sandbox moves idle → provisioning → ready, or → failed after a
 * bounded round of attempts; a later wait starts a new round. Release is
 * terminal. Provisioning runs in the background: `provision()` and
 * `whenReady()` start it, nothing awaits it except callers that need the
 * sandbox. What triggers `provision()` durably (Session Execution on Node,
 * the Durable Object alarm on Cloudflare) is the host's concern, not this
 * module's.
 */

export interface SessionSandboxRetryPolicy {
  /** Attempts per provisioning round. Default 3, matching Node's accept-time
   * start. */
  maxAttempts?: number;
  /** Delay after failed attempt `n` (n ≥ 1). Default 250 ms · 2^(n−1),
   * capped at 5 s. */
  backoffMs?(failedAttempt: number): number;
}

export type SessionSandboxErrorEvent =
  | { readonly kind: "attempt_failed"; readonly attempt: number; readonly error: unknown }
  | {
      readonly kind: "release_failed";
      readonly reason: SandboxReleaseReason;
      readonly error: unknown;
    };

export interface OpenSessionSandboxOptions {
  retry?: SessionSandboxRetryPolicy;
  /** Abortable delay; injected by deterministic tests. */
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
  /** Observes provider failures for logs. Never shown to the model. */
  onError?(event: SessionSandboxErrorEvent): void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function defaultBackoffMs(failedAttempt: number): number {
  return Math.min(5_000, 250 * 2 ** (failedAttempt - 1));
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
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
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("sandbox readiness timeoutMs must be a finite, non-negative number");
  }
}

/** Open one Session's sandbox over a driver. Nothing is acquired until
 * `provision()` or `whenReady()` is called. */
export function openSessionSandbox(
  driver: SessionSandboxDriver,
  context: SandboxFactoryContext,
  options: OpenSessionSandboxOptions = {},
): SessionSandbox {
  const maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("sandbox provisioning maxAttempts must be a positive integer");
  }
  return new DefaultSessionSandbox(driver, context, {
    maxAttempts,
    backoffMs: options.retry?.backoffMs ?? defaultBackoffMs,
    sleep: options.sleep ?? abortableSleep,
    onError: options.onError,
  });
}

interface Settings {
  maxAttempts: number;
  backoffMs(failedAttempt: number): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  onError: ((event: SessionSandboxErrorEvent) => void) | undefined;
}

const IDLE: SessionSandboxState = Object.freeze({ phase: "idle" });
const READY: SessionSandboxState = Object.freeze({ phase: "ready" });

class DefaultSessionSandbox implements SessionSandbox {
  readonly capabilities: SandboxPersistenceCapabilities;
  readonly #driver: SessionSandboxDriver;
  readonly #settings: Settings;
  /** Aborted once, with a SandboxReleasedError, by release(). */
  readonly #lifecycle = new AbortController();
  /** Acquired and not yet handed to driver.release. */
  readonly #held = new Set<SandboxPort>();
  readonly #releases = new WeakMap<SandboxPort, Promise<void>>();
  #state: SessionSandboxState = IDLE;
  #ready: SandboxPort | null = null;
  #round: Promise<SandboxPort> | null = null;
  #roundToken: object | null = null;
  #released: Promise<void> | null = null;

  constructor(
    driver: SessionSandboxDriver,
    readonly context: SandboxFactoryContext,
    settings: Settings,
  ) {
    this.#driver = driver;
    this.#settings = settings;
    this.capabilities = driver.capabilities;
  }

  state(): SessionSandboxState {
    return this.#state;
  }

  current(): SandboxPort | null {
    return this.#ready;
  }

  provision(): void {
    if (this.#state.phase === "released" || this.#ready !== null || this.#round !== null) return;
    this.#startRound();
  }

  whenReady(options: { timeoutMs: number; signal?: AbortSignal }): Promise<SandboxPort> {
    const { timeoutMs, signal } = options;
    try {
      assertTimeout(timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#lifecycle.signal.aborted) return Promise.reject(abortError(this.#lifecycle.signal));
    if (this.#ready !== null) return Promise.resolve(this.#ready);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const round = this.#round ?? this.#startRound();
    const lifecycle = this.#lifecycle.signal;

    return new Promise<SandboxPort>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        lifecycle.removeEventListener("abort", onRelease);
        finish();
      };
      const onAbort = () => settle(() => reject(abortError(signal!)));
      const onRelease = () => settle(() => reject(abortError(lifecycle)));
      const timer = setTimeout(
        () => settle(() => reject(new SandboxNotReadyError(timeoutMs, this.#state))),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      lifecycle.addEventListener("abort", onRelease, { once: true });
      round.then(
        (sandbox) => settle(() => resolve(sandbox)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  release(reason: SandboxReleaseReason): Promise<void> {
    if (this.#released !== null) return this.#released;
    this.#setState({ phase: "released", reason });
    this.#lifecycle.abort(new SandboxReleasedError(reason));
    this.#ready = null;
    this.#released = Promise.all(
      [...this.#held].map((sandbox) => this.#releaseSandbox(sandbox, reason)),
    ).then(() => undefined);
    return this.#released;
  }

  #setState(next: SessionSandboxState): void {
    if (this.#state.phase === "released") return;
    this.#state = Object.isFrozen(next) ? next : Object.freeze(next);
  }

  #startRound(): Promise<SandboxPort> {
    const token = {};
    this.#roundToken = token;
    const round = this.#runRound(token);
    // A round that settled synchronously already cleared its token.
    if (this.#roundToken === token) this.#round = round;
    // Waiters observe failures; an unobserved round must not be unhandled.
    round.catch(() => undefined);
    return round;
  }

  async #runRound(token: object): Promise<SandboxPort> {
    const signal = this.#lifecycle.signal;
    try {
      for (let attempt = 1; ; attempt += 1) {
        this.#setState({ phase: "provisioning", attempt, step: "acquire" });
        let sandbox: SandboxPort | null = null;
        try {
          sandbox = await this.#driver.acquire({ context: this.context, signal });
          if (signal.aborted) throw abortError(signal);
          this.#held.add(sandbox);
          this.#setState({ phase: "provisioning", attempt, step: "prepare" });
          await this.#driver.prepare({ sandbox, context: this.context, signal });
          if (signal.aborted) throw abortError(signal);
          this.#ready = sandbox;
          this.#setState(READY);
          return sandbox;
        } catch (error) {
          // A partially prepared sandbox is never reused.
          if (sandbox !== null) {
            await this.#releaseSandbox(sandbox, signal.aborted ? "cancelled" : "provision_failed");
          }
          if (signal.aborted) throw abortError(signal);
          this.#notify({ kind: "attempt_failed", attempt, error });
          if (attempt >= this.#settings.maxAttempts) {
            this.#setState({ phase: "failed", attempts: attempt, error });
            throw new SandboxProvisionFailedError(attempt, { cause: error });
          }
          this.#setState({ phase: "provisioning", attempt, step: "backoff" });
          await this.#settings.sleep(this.#settings.backoffMs(attempt), signal);
          if (signal.aborted) throw abortError(signal);
        }
      }
    } finally {
      if (this.#roundToken === token) {
        this.#roundToken = null;
        this.#round = null;
      }
    }
  }

  #releaseSandbox(sandbox: SandboxPort, reason: SandboxReleaseReason): Promise<void> {
    const existing = this.#releases.get(sandbox);
    if (existing !== undefined) return existing;
    this.#held.delete(sandbox);
    const pending = Promise.resolve()
      .then(() => this.#driver.release({ sandbox, context: this.context, reason }))
      .catch((error: unknown) => this.#notify({ kind: "release_failed", reason, error }));
    this.#releases.set(sandbox, pending);
    return pending;
  }

  #notify(event: SessionSandboxErrorEvent): void {
    try {
      this.#settings.onError?.(event);
    } catch {
      // An observer must not change provisioning.
    }
  }
}

// ─── Tool wall ────────────────────────────────────────────────────────

type RequiredBarrierMethod = "exec" | "readFile" | "writeFile";
export type OptionalBarrierMethod = "readFileBytes" | "writeFileBytes" | "startProcess";

const OPTIONAL_BARRIER_METHODS: ReadonlySet<string> = new Set<OptionalBarrierMethod>([
  "readFileBytes",
  "writeFileBytes",
  "startProcess",
]);

/** Exactly the sandbox methods a caller declared; nothing else is exposed,
 * so no caller can infer a capability from the presence of a method. */
export type SandboxBarrierPort<Optional extends OptionalBarrierMethod = never> =
  Pick<SandboxPort, RequiredBarrierMethod>
  & { readonly [Method in Optional]-?: NonNullable<SandboxPort[Method]> };

export interface SandboxReadinessBarrierOptions<Optional extends OptionalBarrierMethod> {
  /** Bound on the wait of each operation. */
  timeoutMs: number;
  /** Usually the turn's signal: aborting stops waiting, not provisioning. */
  signal?: AbortSignal;
  /** Optional methods the caller needs; declared, never probed for. */
  optionalMethods?: readonly Optional[];
}

/**
 * The wall on sandbox tools (ADR 0014 §2). Each operation waits at the
 * readiness barrier, then runs on the prepared sandbox. Waiting fails with a
 * {@link SandboxUnavailableError} the host returns as that tool call's error,
 * so the model keeps streaming and non-sandbox tools never wait.
 */
export function withSandboxReadinessBarrier<Optional extends OptionalBarrierMethod = never>(
  sandbox: SessionSandbox,
  options: SandboxReadinessBarrierOptions<Optional>,
): SandboxBarrierPort<Optional> {
  assertTimeout(options.timeoutMs);
  const names = new Set<string>(["exec", "readFile", "writeFile"]);
  for (const name of options.optionalMethods ?? []) {
    if (!OPTIONAL_BARRIER_METHODS.has(name)) {
      throw new TypeError(`unsupported optional sandbox barrier method: ${String(name)}`);
    }
    names.add(name);
  }
  const port: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of names) {
    port[name] = async (...args: unknown[]) => {
      const ready = await sandbox.whenReady({
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      const method = (ready as unknown as Record<string, unknown>)[name];
      if (typeof method !== "function") throw new SandboxCapabilityMissingError(name);
      return (method as (...input: unknown[]) => unknown).apply(ready, args);
    };
  }
  return Object.freeze(port) as unknown as SandboxBarrierPort<Optional>;
}
