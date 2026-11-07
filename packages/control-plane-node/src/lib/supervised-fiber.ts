import { Cause, Effect, Fiber } from "effect";

/**
 * Own a critical background fiber. The caller must handle expected operation
 * failures inside the loop; unhandled failures/defects go to its fatal owner.
 * Interruption is the only normal way to stop a still-required supervisor.
 */
export function runSupervised<A>(
  effect: Effect.Effect<A, unknown>,
  onFailure: (error: unknown) => void,
  onUnexpectedExit: () => void = () => {},
): Fiber.RuntimeFiber<void, never> {
  const supervised = effect.pipe(
    Effect.tap(() => Effect.sync(onUnexpectedExit)),
    Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
      ? Effect.void
      : Effect.sync(() => { onFailure(Cause.squash(cause)); })),
    Effect.asVoid,
  );
  return Effect.runFork(supervised);
}

export function interruptFiber(fiber: Fiber.RuntimeFiber<unknown, unknown>): Promise<void> {
  return Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined);
}
