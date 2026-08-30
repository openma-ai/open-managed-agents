import type { HarnessInterface } from "./interface";

type HarnessFactory = () => HarnessInterface;

const registry = new Map<string, HarnessFactory>();

export function registerHarness(name: string, factory: HarnessFactory) {
  registry.set(name, factory);
}

export function resolveHarness(name?: string): HarnessInterface {
  const key = name || "default";
  const factory = registry.get(key);
  if (!factory) {
    throw new Error(`Unknown harness: "${key}". Registered: ${[...registry.keys()].join(", ")}`);
  }
  return factory();
}

/** Session-scoped harness owner. Stateful harnesses (notably ACP) retain one
 * process across turns, while agent version/harness changes dispose the old
 * instance before activating the replacement. */
export class HarnessLease {
  #active: { key: string; harness: HarnessInterface } | null = null;

  async resolve(key: string, name?: string): Promise<HarnessInterface> {
    if (this.#active?.key === key) return this.#active.harness;
    await this.dispose();
    const harness = resolveHarness(name);
    this.#active = { key, harness };
    return harness;
  }

  async dispose(): Promise<void> {
    const active = this.#active;
    this.#active = null;
    await active?.harness.dispose?.();
  }
}
