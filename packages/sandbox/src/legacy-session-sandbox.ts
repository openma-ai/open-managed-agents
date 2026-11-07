import type {
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxPort,
} from "./ports";
import {
  declarePersistenceCapabilities,
  type SandboxPersistenceCapabilities,
  type SessionSandboxDriver,
} from "./session-sandbox-port";

/*
 * The single v0 compatibility wrapper (ADR 0014 §8). Existing adapters (E2B,
 * Daytona, OpenSandbox, BoxRun, LiteBox, local-subprocess, Cloudflare) keep
 * their `SandboxFactory`; callers only see a SessionSandboxDriver. Remove
 * this file once every adapter has a native driver.
 *
 * Persistence is declared by the composer, in the terms the deployment
 * actually wires. The wrapper never inspects the acquired sandbox:
 *
 *   workspace backup/restore wired (WorkspaceBackupService, CF snapshot)
 *                                → workspace: checkpoint_restore
 *   Session outputs mount         → outputs: { strategy, durability } as wired
 *   factory nativeMemoryStoreMount → memoryStores: native_mount
 *   factory preparedBase           → preparedBase: best_effort unless declared
 *   anything else                  → ephemeral / unsupported
 *
 * The prepared sandbox is the adapter's own object, so v0 primitives such as
 * SandboxRuntimePort pass through unchanged.
 */

export interface LegacySandboxDriverOptions {
  /** Provider name for diagnostics, e.g. `SANDBOX_PROVIDER`. */
  provider: string;
  /** Environment handed to the factory on every acquisition. */
  env: SandboxFactoryEnv;
  /** Persistence this deployment guarantees beyond the factory's own
   * declarations. Undeclared fields are unsupported. */
  persistence?: Partial<SandboxPersistenceCapabilities>;
  /** The v0 preparation (orchestrator.provision, environment packages,
   * resource materialization) run as the readiness step. */
  prepare?(input: {
    sandbox: SandboxPort;
    context: SandboxFactoryContext;
    signal: AbortSignal;
  }): Promise<void>;
}

export function wrapLegacySandboxFactory(
  factory: SandboxFactory,
  options: LegacySandboxDriverOptions,
): SessionSandboxDriver {
  const provider = options.provider;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new TypeError("legacy sandbox driver requires a provider name");
  }
  const declared = factory.capabilities ?? {};
  const overrides = options.persistence ?? {};
  if (overrides.memoryStores === "native_mount" && declared.nativeMemoryStoreMount !== true) {
    throw new TypeError(
      `${provider}: memoryStores "native_mount" requires a factory that declares nativeMemoryStoreMount`,
    );
  }
  if (
    overrides.preparedBase !== undefined
    && overrides.preparedBase !== "unsupported"
    && declared.preparedBase !== true
  ) {
    throw new TypeError(
      `${provider}: a preparedBase declaration requires a factory that declares preparedBase`,
    );
  }
  const capabilities = declarePersistenceCapabilities({
    memoryStores: declared.nativeMemoryStoreMount === true ? "native_mount" : "file_sync",
    preparedBase: declared.preparedBase === true ? { durability: "best_effort" } : "unsupported",
    ...overrides,
  });
  const prepare = options.prepare;

  return Object.freeze({
    provider,
    capabilities,
    // v0 factories cannot be cancelled; the shared lifecycle releases a
    // sandbox that resolves after abort.
    acquire: ({ context }: { context: SandboxFactoryContext }) => factory(context, options.env),
    prepare: async (input: {
      sandbox: SandboxPort;
      context: SandboxFactoryContext;
      signal: AbortSignal;
    }) => {
      await prepare?.(input);
    },
    release: async ({ sandbox }: { sandbox: SandboxPort }) => {
      await sandbox.destroy?.();
    },
  });
}
