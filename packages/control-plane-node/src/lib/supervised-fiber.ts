import { Effect, Fiber } from "effect";

/**
 * Run a background effect as a fiber. Typed failures and defects are logged
 * by `onFailure` and do not escape as unhandled rejections.
 */
export function runSupervised<A>(
  effect: Effect.Effect<A, unknown>,
  onFailure: (error: unknown) => void,
): Fiber.RuntimeFiber<void, never> {
  const supervised = effect.pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      onFailure(error);
    })),
    Effect.catchAllDefect((defect) => Effect.sync(() => {
      onFailure(defect);
    })),
    Effect.asVoid,
  );
  return Effect.runFork(supervised);
}

export function interruptFiber(fiber: Fiber.RuntimeFiber<unknown, unknown>): Promise<void> {
  return Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined);
}
