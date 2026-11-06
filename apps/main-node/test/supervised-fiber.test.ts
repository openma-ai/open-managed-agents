import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { runSupervised, interruptFiber } from "../../../packages/control-plane-node/src/lib/supervised-fiber";
// Exercise the exact Effect version owned by control-plane-node.
const { Effect, Fiber } = createRequire(new URL("../../../packages/control-plane-node/package.json", import.meta.url))("effect");

it("escalates a critical supervisor defect instead of silently losing the renew loop", async () => {
  const error = new TypeError("supervisor defect"); const fatal = vi.fn();
  const fiber = runSupervised(Effect.die(error), fatal);
  await Effect.runPromise(Fiber.await(fiber)); expect(fatal).toHaveBeenCalledExactlyOnceWith(error);
});
it("escalates unexpected completion but treats deliberate interruption as normal", async () => {
  const fatal = vi.fn(); const completed = vi.fn();
  const exited = runSupervised(Effect.void, fatal, completed);
  await Effect.runPromise(Fiber.await(exited)); expect(completed).toHaveBeenCalledOnce();
  const running = runSupervised(Effect.never, fatal, completed);
  await interruptFiber(running); expect(fatal).not.toHaveBeenCalled(); expect(completed).toHaveBeenCalledOnce();
});
