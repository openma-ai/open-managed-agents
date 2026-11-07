import type {
  OutputStrategy,
  RuntimeCheckpointKind,
  WorkspaceStrategy,
} from "@open-managed-agents/runtime-resource-contract";

import type { SandboxFactoryContext, SandboxPort } from "./ports";

/*
 * Session sandbox port (ADR 0014 §6–§9).
 *
 * The v0 {@link SandboxPort} models a sandbox that is usable as soon as its
 * factory resolves, and optional features are discovered by probing methods.
 * This port separates what callers used to conflate:
 *
 *   1. a driver that acquires, prepares and releases compute
 *      ({@link SessionSandboxDriver});
 *   2. one Session's sandbox with readiness as a first-class state
 *      ({@link SessionSandbox}): provisioning is started without being
 *      awaited, and sandbox operations wait at a bounded barrier;
 *   3. persistence capabilities declared by whoever composes the driver
 *      ({@link SandboxPersistenceCapabilities}), never probed.
 *
 * The shared semantics (barrier, timeout, retry, cleanup of late
 * allocations) live in ./session-sandbox.ts. Runtimes differ only in what
 * triggers provisioning and which driver they compose.
 */

export type DeclaredDurability = "durable" | "best_effort";

/** How `/workspace` survives the compute that wrote it. */
export type WorkspacePersistenceDeclaration =
  | {
      readonly strategy: Exclude<WorkspaceStrategy, "ephemeral">;
      readonly durability: DeclaredDurability;
    }
  | { readonly strategy: "ephemeral" };

/**
 * Persistence a driver guarantees in this deployment, in the existing
 * runtime-resource vocabulary. Declared by the composer; nothing here is
 * inferred from the methods a sandbox happens to expose (Workers RPC stubs
 * answer `typeof x === "function"` for every property). A capability that is
 * not declared is unsupported.
 */
export interface SandboxPersistenceCapabilities {
  readonly workspace: WorkspacePersistenceDeclaration;
  readonly outputs:
    | { readonly strategy: OutputStrategy; readonly durability: DeclaredDurability }
    | "unsupported";
  /** `native_mount` mounts Memory Stores; `file_sync` copies them through
   * file operations, which works on any sandbox. */
  readonly memoryStores: "native_mount" | "file_sync";
  readonly runtimeCheckpoint:
    | {
        readonly kinds: readonly RuntimeCheckpointKind[];
        readonly durability: DeclaredDurability;
      }
    | "unsupported";
  readonly preparedBase: { readonly durability: DeclaredDurability } | "unsupported";
}

const WORKSPACE_STRATEGIES: Readonly<Record<WorkspaceStrategy, true>> = {
  durable_mount: true,
  retained_runtime: true,
  checkpoint_restore: true,
  ephemeral: true,
};
const OUTPUT_STRATEGIES: Readonly<Record<OutputStrategy, true>> = {
  durable_mount: true,
  watch_and_upload: true,
  final_collect: true,
};
const RUNTIME_CHECKPOINT_KINDS: Readonly<Record<RuntimeCheckpointKind, true>> = {
  filesystem: true,
  process: true,
};
const DURABILITIES: Readonly<Record<DeclaredDurability, true>> = {
  durable: true,
  best_effort: true,
};
const MEMORY_STORE_MODES = { native_mount: true, file_sync: true } as const;
const DECLARATION_KEYS = new Set<string>([
  "workspace",
  "outputs",
  "memoryStores",
  "runtimeCheckpoint",
  "preparedBase",
]);

function invalid(path: string, value: unknown): never {
  throw new TypeError(
    `Invalid sandbox persistence declaration: ${path}=${JSON.stringify(value)}`,
  );
}

function isMember<T extends string>(
  table: Readonly<Record<T, true>>,
  value: unknown,
): value is T {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function durability(path: string, value: unknown): DeclaredDurability {
  if (!isMember(DURABILITIES, value)) invalid(path, value);
  return value;
}

function exactKeys(path: string, value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${path}.${key}`, value[key]);
  }
}

/**
 * Validate and freeze a persistence declaration. Omitted fields mean
 * unsupported (`ephemeral` workspace, `file_sync` Memory Stores). Unknown
 * fields, unknown strategies, and contradictions (for example a durability
 * on an ephemeral workspace) throw instead of being silently ignored.
 */
export function declarePersistenceCapabilities(
  declaration: Partial<SandboxPersistenceCapabilities> = {},
): SandboxPersistenceCapabilities {
  if (!isRecord(declaration)) invalid("(root)", declaration);
  for (const key of Object.keys(declaration)) {
    if (!DECLARATION_KEYS.has(key)) invalid(key, (declaration as Record<string, unknown>)[key]);
  }

  const workspaceInput: unknown = declaration.workspace ?? { strategy: "ephemeral" };
  if (!isRecord(workspaceInput)) invalid("workspace", workspaceInput);
  const strategy = workspaceInput.strategy;
  if (!isMember(WORKSPACE_STRATEGIES, strategy)) invalid("workspace.strategy", strategy);
  let workspace: WorkspacePersistenceDeclaration;
  if (strategy === "ephemeral") {
    exactKeys("workspace", workspaceInput, ["strategy"]);
    workspace = Object.freeze({ strategy });
  } else {
    exactKeys("workspace", workspaceInput, ["strategy", "durability"]);
    workspace = Object.freeze({
      strategy,
      durability: durability("workspace.durability", workspaceInput.durability),
    });
  }

  const outputsInput: unknown = declaration.outputs ?? "unsupported";
  let outputs: SandboxPersistenceCapabilities["outputs"];
  if (outputsInput === "unsupported") {
    outputs = "unsupported";
  } else {
    if (!isRecord(outputsInput)) invalid("outputs", outputsInput);
    exactKeys("outputs", outputsInput, ["strategy", "durability"]);
    if (!isMember(OUTPUT_STRATEGIES, outputsInput.strategy)) {
      invalid("outputs.strategy", outputsInput.strategy);
    }
    outputs = Object.freeze({
      strategy: outputsInput.strategy,
      durability: durability("outputs.durability", outputsInput.durability),
    });
  }

  const memoryStores: unknown = declaration.memoryStores ?? "file_sync";
  if (!isMember(MEMORY_STORE_MODES, memoryStores)) invalid("memoryStores", memoryStores);

  const checkpointInput: unknown = declaration.runtimeCheckpoint ?? "unsupported";
  let runtimeCheckpoint: SandboxPersistenceCapabilities["runtimeCheckpoint"];
  if (checkpointInput === "unsupported") {
    runtimeCheckpoint = "unsupported";
  } else {
    if (!isRecord(checkpointInput)) invalid("runtimeCheckpoint", checkpointInput);
    exactKeys("runtimeCheckpoint", checkpointInput, ["kinds", "durability"]);
    const kinds = checkpointInput.kinds;
    if (
      !Array.isArray(kinds)
      || kinds.length === 0
      || new Set(kinds).size !== kinds.length
      || !kinds.every((kind) => isMember(RUNTIME_CHECKPOINT_KINDS, kind))
    ) {
      invalid("runtimeCheckpoint.kinds", kinds);
    }
    runtimeCheckpoint = Object.freeze({
      kinds: Object.freeze([...kinds]) as readonly RuntimeCheckpointKind[],
      durability: durability("runtimeCheckpoint.durability", checkpointInput.durability),
    });
  }

  const preparedBaseInput: unknown = declaration.preparedBase ?? "unsupported";
  let preparedBase: SandboxPersistenceCapabilities["preparedBase"];
  if (preparedBaseInput === "unsupported") {
    preparedBase = "unsupported";
  } else {
    if (!isRecord(preparedBaseInput)) invalid("preparedBase", preparedBaseInput);
    exactKeys("preparedBase", preparedBaseInput, ["durability"]);
    preparedBase = Object.freeze({
      durability: durability("preparedBase.durability", preparedBaseInput.durability),
    });
  }

  return Object.freeze({ workspace, outputs, memoryStores, runtimeCheckpoint, preparedBase });
}

/** Nothing declared: an ephemeral sandbox with file-synced Memory Stores. */
export const UNDECLARED_PERSISTENCE: SandboxPersistenceCapabilities =
  declarePersistenceCapabilities();

export type SandboxReleaseReason =
  | "archived"
  | "deleted"
  /** Provisioned but never used before the unused-provision TTL. */
  | "unused"
  /** Provisioning was abandoned, for example by a release that raced it. */
  | "cancelled"
  /** A failed attempt; its partial state is never reused. */
  | "provision_failed";

/**
 * Acquires, prepares and releases compute for one Session. Native
 * implementations and the v0 compatibility wrapper both implement this;
 * neither implements readiness, retry or timeouts, which are shared.
 */
export interface SessionSandboxDriver {
  /** Provider name for diagnostics. Never shown to the model. */
  readonly provider: string;
  readonly capabilities: SandboxPersistenceCapabilities;
  /** Acquire compute. Should honour `signal` where the provider can; a
   * sandbox that resolves after abort is released by the caller. */
  acquire(input: {
    context: SandboxFactoryContext;
    signal: AbortSignal;
  }): Promise<SandboxPort>;
  /** Make the sandbox prepared: resources, skills, environment packages and
   * workspace restore. "Ready" means this resolved, not that compute is up. */
  prepare(input: {
    sandbox: SandboxPort;
    context: SandboxFactoryContext;
    signal: AbortSignal;
  }): Promise<void>;
  /** Release compute. Never deletes canonical durable workspace or finalized
   * outputs (ADR 0005 invariant 7). */
  release(input: {
    sandbox: SandboxPort;
    context: SandboxFactoryContext;
    reason: SandboxReleaseReason;
  }): Promise<void>;
}

export type SessionSandboxState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "provisioning";
      readonly attempt: number;
      readonly step: "acquire" | "prepare" | "backoff";
    }
  | { readonly phase: "ready" }
  | { readonly phase: "failed"; readonly attempts: number; readonly error: unknown }
  | { readonly phase: "released"; readonly reason: SandboxReleaseReason };

/** One Session's sandbox. Obtain it with `openSessionSandbox`. */
export interface SessionSandbox {
  readonly context: SandboxFactoryContext;
  readonly capabilities: SandboxPersistenceCapabilities;
  /** Start acquisition and preparation unless already running or ready, and
   * return immediately. After a failed round this starts a new one. */
  provision(): void;
  state(): SessionSandboxState;
  /** The prepared sandbox if ready now, else null. Never starts provisioning;
   * post-turn work uses it to run only when the sandbox became ready. */
  current(): SandboxPort | null;
  /**
   * Wait at most `timeoutMs` for a prepared sandbox, starting provisioning
   * when idle or failed. Rejects with {@link SandboxNotReadyError} on timeout,
   * {@link SandboxProvisionFailedError} when the round exhausts its attempts,
   * {@link SandboxReleasedError} after release, or the signal's reason on
   * abort. Aborting a waiter never cancels provisioning.
   */
  whenReady(options: { timeoutMs: number; signal?: AbortSignal }): Promise<SandboxPort>;
  /** Terminal. Rejects current and future waiters, abandons provisioning and
   * releases every allocation, including one that resolves later. */
  release(reason: SandboxReleaseReason): Promise<void>;
}

/**
 * A sandbox operation could not run because the sandbox is not available.
 * Hosts return {@link toolMessage} as the tool error of the call; it never
 * contains provider details (those stay on `cause` for logs). This is a
 * tool error, not a turn-level session error (ADR 0014 §2).
 */
export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly toolMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class SandboxNotReadyError extends SandboxUnavailableError {
  override readonly name = "SandboxNotReadyError";

  constructor(
    readonly waitedMs: number,
    readonly state: SessionSandboxState,
  ) {
    super(
      `sandbox was not ready after ${waitedMs}ms (${state.phase})`,
      "The environment is still starting. Retry the tool call shortly.",
    );
  }
}

export class SandboxProvisionFailedError extends SandboxUnavailableError {
  override readonly name = "SandboxProvisionFailedError";

  constructor(
    readonly attempts: number,
    options: { cause: unknown },
  ) {
    super(
      `sandbox provisioning failed after ${attempts} attempt(s)`,
      "The environment could not be started. Retry the tool call to try again.",
      options,
    );
  }
}

export class SandboxReleasedError extends SandboxUnavailableError {
  override readonly name = "SandboxReleasedError";

  constructor(readonly reason: SandboxReleaseReason) {
    super(
      `sandbox was released (${reason})`,
      "The environment for this session is no longer available.",
    );
  }
}

/** A caller declared an optional sandbox method that the prepared sandbox
 * does not implement. A composition error, not a transient condition. */
export class SandboxCapabilityMissingError extends Error {
  override readonly name = "SandboxCapabilityMissingError";

  constructor(readonly method: string) {
    super(`the prepared sandbox does not implement ${method}`);
  }
}
