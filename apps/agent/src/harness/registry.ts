import type { HarnessCatalog, HarnessDescriptor } from "@open-managed-agents/api-types";
import type { HarnessDisposeReason, HarnessInterface } from "./interface";

export type { HarnessCatalog, HarnessDescriptor, HarnessExecutionPlacement } from "@open-managed-agents/api-types";
export type HarnessFactory = () => HarnessInterface;

// Process/isolate-scoped, shared by discovery and the existing session resolvers.
// Deployments needing distinct registrations must use distinct processes.
const registry = new Map<string, { descriptor: HarnessDescriptor; factory: HarnessFactory }>();
let defaultId: string | null = null;

/** Code-only registration: never imports a module or accepts remote source code.
 * Duplicate ids fail, even for the same factory. Core initialization separately
 * skips existing ids so it cannot replace deployment registrations. */
export function registerHarness(name: string, factory: HarnessFactory): void;
export function registerHarness(descriptor: HarnessDescriptor, factory: HarnessFactory): void;
export function registerHarness(input: string | HarnessDescriptor, factory: HarnessFactory): void {
  const descriptor: HarnessDescriptor = typeof input === "string"
    ? { id: input, label: input, description: "", execution: { placement: "unknown" }, capabilities: { runtime_binding: null }, requirements: [] }
    : input;
  if (typeof descriptor.id !== "string" || !descriptor.id.trim() || descriptor.id !== descriptor.id.trim()) {
    throw new Error("Harness id must be a non-empty string without surrounding whitespace");
  }
  if (registry.has(descriptor.id)) {
    throw new Error(`Harness already registered: "${descriptor.id}"`);
  }
  if (typeof factory !== "function" || typeof descriptor.label !== "string" || typeof descriptor.description !== "string" ||
    !["host", "sandbox", "runtime", "unknown"].includes(descriptor.execution?.placement) ||
    (descriptor.capabilities?.runtime_binding !== null && typeof descriptor.capabilities?.runtime_binding !== "boolean") ||
    !Array.isArray(descriptor.requirements) ||
    !descriptor.requirements.every((path) => typeof path === "string" && /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*(\|[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*)*$/.test(path))) {
    throw new Error(`Invalid harness descriptor or factory: "${descriptor.id}"`);
  }
  registry.set(descriptor.id, { descriptor: publicDescriptor(descriptor), factory });
  // Preserve the original registerHarness("default", factory) entrypoint.
  if (descriptor.id === "default") defaultId = "default";
}

function registered(id: string) {
  const entry = registry.get(id);
  if (!entry) {
    throw new Error(`Unknown harness: "${id}". Registered: ${[...registry.keys()].join(", ")}`);
  }
  return entry;
}

/** Deployment startup configuration; affects subsequent resolutions, not active leases. */
export function setDefaultHarness(id: string): void {
  if (id === "default") throw new Error('"default" is an alias; select a registered implementation id');
  registered(id);
  defaultId = id;
}

export function resolveHarness(name?: string): HarnessInterface {
  const key = name || "default";
  return registered(key === "default" ? defaultId ?? key : key).factory();
}

// Explicit allowlist at both registration and response boundaries. Do not spread
// registration objects: callers may carry private factory configuration on them.
function publicDescriptor(value: HarnessDescriptor): HarnessDescriptor {
  return {
    id: value.id, label: value.label, description: value.description,
    execution: { placement: value.execution.placement },
    capabilities: { runtime_binding: value.capabilities.runtime_binding },
    requirements: [...value.requirements],
  };
}

/** Live snapshot; does not instantiate a harness or expose factory configuration. */
export function getHarnessCatalog(): HarnessCatalog {
  return {
    object: "list",
    data: [...registry.values()]
      .filter(({ descriptor }) => descriptor.id !== "default" || defaultId === "default")
      .map(({ descriptor }) => publicDescriptor(descriptor)),
    default_harness_id: defaultId,
  };
}

/** Session-scoped harness owner. Stateful harnesses (notably ACP) retain one
 * process across turns, while agent version/harness changes dispose the old
 * instance before activating the replacement. */
export class HarnessLease {
  #active: { key: string; harness: HarnessInterface } | null = null;

  async resolve(key: string, name?: string): Promise<HarnessInterface> {
    if (this.#active?.key === key) return this.#active.harness;
    await this.dispose("replace");
    const harness = resolveHarness(name);
    this.#active = { key, harness };
    return harness;
  }

  async dispose(reason: HarnessDisposeReason = "destroy"): Promise<void> {
    const active = this.#active;
    this.#active = null;
    await active?.harness.dispose?.(reason);
  }
}
