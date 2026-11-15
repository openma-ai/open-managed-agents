import type { ProcessHandle, SandboxPort } from "./ports";

/**
 * The minimum authority a sandbox call needs from its parent execution.
 *
 * This intentionally does not import SessionExecutionFence.  Sandbox
 * providers are reusable by Node, Cloudflare and self-hosted hosts; the
 * session-runtime package owns the durable fence while this package only
 * enforces the local, synchronous boundary.
 */
export interface SandboxExecutionGuard {
  signal?: AbortSignal;
  /** Check the existing lease authority or a provider-specific revocation. */
  isValid?: () => boolean | Promise<boolean>;
}

export class SandboxExecutionFencedError extends Error {
  override readonly name = "SandboxExecutionFencedError";

  constructor(reason = "sandbox execution fence is no longer valid") {
    super(reason);
  }
}

const SAFE_METHODS = new Set([
  "runtimeHandle",
  "runtimeCapabilities",
  "status",
  "capabilities",
  "inspect",
  "sessionOutputMountCapabilities",
  "registerCommandSecrets",
]);

async function assertValid(guard: SandboxExecutionGuard): Promise<void> {
  if (guard.signal?.aborted) {
    throw new SandboxExecutionFencedError(
      guard.signal.reason instanceof Error
        ? guard.signal.reason.message
        : "sandbox execution was aborted",
    );
  }
  if (guard.isValid && (!await guard.isValid() || guard.signal?.aborted)) {
    throw new SandboxExecutionFencedError();
  }
}

async function invokeWithGuard<T>(
  guard: SandboxExecutionGuard,
  operation: () => Promise<T>,
): Promise<T> {
  if (!guard.signal) {
    await assertValid(guard);
    const result = await operation();
    await assertValid(guard);
    return result;
  }
  const signal = guard.signal;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SandboxExecutionFencedError(
      signal.reason instanceof Error ? signal.reason.message : "sandbox execution was aborted",
    ));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const pending = (async () => {
    await assertValid(guard);
    // Authority can finish after abort won the race. Never dispatch then.
    if (signal.aborted) throw new SandboxExecutionFencedError();
    const result = await operation();
    await assertValid(guard);
    if (signal.aborted) throw new SandboxExecutionFencedError();
    return result;
  })();
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Both authority reads and provider calls may settle after cancellation.
    void pending.catch(() => undefined);
  }
}

/**
 * Bind a sandbox instance to a session execution fence.
 *
 * Every method that can cross into provider/container state is guarded,
 * including methods added by provider adapters in the future. Only
 * introspection and local secret registration are deliberately exempt.
 * Calls are checked both before and after the provider operation; a result
 * that arrives after lease loss is therefore never handed to the harness.
 * A long-lived ProcessHandle is also terminated on abort so a stale hand
 * cannot continue mutating the workspace after its parent lost authority.
 */
export function withSandboxExecutionGuard<T extends SandboxPort>(
  sandbox: T,
  guard: SandboxExecutionGuard,
): T {
  return new Proxy(sandbox, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const name = String(property);
      if (SAFE_METHODS.has(name)) return value.bind(target);
      return (...args: unknown[]) => invokeWithGuard(
        guard,
        async () => {
          const result = await (value as (...input: unknown[]) => unknown).apply(target, args);
          if (name === "startProcess" && result && typeof result === "object") {
            const process = result as ProcessHandle;
            if (typeof process.kill === "function" && guard.signal) {
              const kill = () => {
                void process.kill("SIGTERM").catch(() => undefined);
              };
              if (guard.signal.aborted) kill();
              else guard.signal.addEventListener("abort", kill, { once: true });
            }
          }
          return result;
        },
      );
    },
  }) as T;
}

