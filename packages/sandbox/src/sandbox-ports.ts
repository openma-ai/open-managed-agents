// Sandbox SDK v2 domain contract (research/sandbox-sdk-v2-design.md §0.1).
//
// The core calls only these three Ports. There are no capability fields and
// no `typeof` probing: an implementation that has no use for a method makes
// it a no-op. The declarations are {@link SandboxLifecyclePort.handle},
// because the core takes different paths on it, and the optional pair
// {@link SandboxLifecyclePort.snapshotEnvironment} /
// {@link SandboxLifecyclePort.deleteEnvironmentSnapshot}: an adapter that
// cannot snapshot an environment leaves both out and the core then never
// builds an environment cache for it. Whether storage and egress are provider-native or generic is decided
// once, at composition time, by `createSandboxPorts` in
// @open-managed-agents/sandbox-port-kit; the core never sees which it got.
//
// What each choice guarantees (sync vs native storage, provider firewall vs
// gateway-only policy) is a deployer decision documented in §0.3, not a mode
// in code.

import type {
  RuntimeResourceFence,
  RuntimeResourceScope,
  SessionOutputBinding,
} from "@open-managed-agents/runtime-resource-contract";
import type { OrchestratorMemoryMount } from "./orchestrator";

type OpaqueMetadata = Readonly<Record<string, string | number | boolean | null>>;

/** The three Ports the core calls. */
export interface SandboxPorts<R> {
  /** Compute lifecycle: only the provider can do it, so every adapter supplies it. */
  sandbox: SandboxLifecyclePort<R>;
  storage: SandboxStoragePort<R>;
  egress: SandboxEgressPort<R>;
}

/**
 * Compute lifecycle. No optional methods; the only declarations are
 * {@link handle} and {@link maxLifetimeMs}. Anything a provider cannot do
 * degrades as the method comments say; the core does not branch on it.
 *
 * Not found is an expected result, never an error: `attach`, `resume` and
 * `keepAlive` return `"gone"`. Provider throttling or busy states throw
 * {@link RetryableSandboxError}; a sandbox that disappears mid-execution
 * throws {@link SandboxGoneError}.
 */
export interface SandboxLifecyclePort<R> {
  /** Whether the handle can change. `"fixed"`: derived from the sessionId
   * and stable for the whole Session (the Cloudflare DO name). `"changes"`:
   * provider-assigned and may change after a rebuild or resume. The core uses
   * it to decide whether a new handle is written before anything else,
   * whether a sandbox started by a fenced-out owner is released, and whether
   * orphan reaping scans by label. */
  readonly handle: "fixed" | "changes";
  /** Provider cap on continuous running: past it the provider stops the
   * sandbox; a pause and resume restarts the clock (design §0.0 rule 11).
   * From the deployer's adapter configuration (it must match the account
   * plan), never a plan API. `null` = no cap (Cloudflare). The core uses it
   * to pause → attach in a gap between tool calls before the cap. */
  readonly maxLifetimeMs: number | null;
  /** Start a new sandbox from an environment snapshot or an image digest.
   * Providers that can only configure a firewall or mount storage at creation
   * do it here from `plan`. An environment snapshot in `plan.from` that no
   * longer works → `"gone"`, including one the adapter only finds dead after
   * starting it (a failed first exec); the core then deletes its record,
   * warns, starts from the image and rebuilds. */
  acquire(input: { scope: RuntimeResourceScope; plan: SandboxPlan; signal: AbortSignal }): Promise<Acquired<R> | "gone">;
  /** Find this sandbox again by handle (prewarmed, paused, or left by a
   * previous owner) and wake it if paused. Not found, or its disk is gone → `"gone"`. */
  attach(input: { scope: RuntimeResourceScope; handle: SandboxHandle; signal: AbortSignal }): Promise<Acquired<R> | "gone">;
  /** Called during an execution only: checks liveness and sets the
   * provider's own timeout (its idle reclaim) to `ttlMs` from now, the
   * adapter's lease when omitted (design §0.0b A.10): it sets the timeout, it
   * does not extend it. A provider whose timeout cannot be set per call
   * ignores `ttlMs`. */
  keepAlive(input: { runtime: R; handle: SandboxHandle; ttlMs?: number }): Promise<"alive" | "gone">;
  /** Take a snapshot without stopping compute: a ref of kind `"snapshot"`
   * that outlives the sandbox (a new sandbox can be started from it). The
   * core takes one at every execution end and in tool-call gaps, keeps only
   * the latest and starts a new sandbox from it when the handle cannot be
   * found again (design §0.0 rule 11). An adapter that returns
   * `kind: "self"` here declares it has no snapshots (a bare v1 factory):
   * a lost sandbox is then replaced by a new one, with a warning. */
  checkpoint(input: { scope: RuntimeResourceScope; runtime: R; handle: SandboxHandle; signal: AbortSignal }): Promise<ResumeRef>;
  /** Keep the workspace and stop compute. Providers that pause in place do so
   * (`kind: "self"`, gone with the sandbox); providers without pause snapshot
   * instead (`kind: "snapshot"`, Cloudflare: backup then stop); providers
   * that keep running return `kind: "self"`. */
  pause(input: { scope: RuntimeResourceScope; runtime: R; handle: SandboxHandle; signal: AbortSignal }): Promise<ResumeRef>;
  /** After `attach` returned `"gone"`: `kind: "self"` wakes the same
   * sandbox; `kind: "snapshot"` starts a new one from the snapshot. The
   * handle may change. Expired or deleted → `"gone"`. */
  resume(input: { scope: RuntimeResourceScope; ref: ResumeRef; plan: SandboxPlan; signal: AbortSignal }): Promise<Acquired<R> | "gone">;
  /** Delete this sandbox, running or paused. Idempotent, and callable with
   * only the serialized handle (orphan reaping). Terminate + reap today. */
  release(input: { scope: RuntimeResourceScope; handle: SandboxHandle }): Promise<void>;
  /** Delete a separately stored restore point. A ref that is the sandbox
   * itself is a no-op (deleting sandboxes only goes through `release`); refs
   * the provider cannot delete are a no-op too and wait for expiry. */
  discard(input: { scope: RuntimeResourceScope; ref: ResumeRef }): Promise<void>;
  /** Snapshot a build sandbox's disk (its Environment setup) into a source
   * that starts any number of sandboxes (1:n), without the build sandbox's
   * memory or processes. Optional: adapters that cannot leave it out. The
   * ref is the adapter's own; the core stores and compares only its
   * `adapter` field. The source image is not checked here or at acquire: the
   * host's cache key carries the image digest. */
  snapshotEnvironment?(input: { runtime: R; handle: SandboxHandle; signal: AbortSignal }): Promise<EnvironmentSnapshotRef>;
  /** Delete an environment snapshot (expiry). Deleting a missing one succeeds.
   * Best effort: providers without a delete API make it a no-op and the
   * snapshot waits for the provider's own expiry; the core never depends on it. */
  deleteEnvironmentSnapshot?(input: { ref: EnvironmentSnapshotRef }): Promise<void>;
  /** Orphan reaping: list sandboxes carrying these labels. `"fixed"` handles
   * return an empty list (a rebuild reuses the same name, so no orphans). */
  list(input: { labels: Partial<SandboxPlan["labels"]>; signal: AbortSignal }): Promise<{ handle: SandboxHandle; labels: SandboxPlan["labels"]; createdAt: string }[]>;
}

/** The sandbox owned by this Session, running or paused. Opaque,
 * serializable, may change; saved under the fence every time it is returned.
 * Same shape as ManagedSandboxLease. */
export interface SandboxHandle { provider: string; runtimeId: string; metadata?: OpaqueMetadata }
/** Restore point, returned by checkpoint / pause and published with the
 * fence. `kind` is the adapter's declaration the core branches on (never on
 * the provider): `"self"` = the sandbox itself (a pause in place; it is gone
 * when the sandbox is), `"snapshot"` = stored apart from the sandbox, so a
 * new sandbox can start from it. The core keeps the two apart: a pause ref
 * never replaces the latest snapshot. */
export interface ResumeRef { provider: string; ref: string; kind: "self" | "snapshot"; metadata?: OpaqueMetadata }
/** Environment setup snapshot, cached per workspace, never across tenants. */
export interface EnvironmentSnapshotRef { adapter: string; ref: string }
export interface Acquired<R> { runtime: R; handle: SandboxHandle }

/** A Memory Store mounted or copied at `/mnt/memory/<storeName>/`. */
export type MemoryStoreBinding = OrchestratorMemoryMount;

/** Given in full to acquire / resume. Holds no token and no plaintext: plans
 * are cached and logged. */
export interface SandboxPlan {
  /** `image` is the digest bound to the Session. Without setup, or before
   * its environment snapshot exists, sandboxes start straight from the image. */
  from: { environmentSnapshot: EnvironmentSnapshotRef } | { image: string };
  /** For providers that can only configure a firewall at creation. */
  egress: EgressPolicy | null;
  /** For native storage that can only be mounted at creation; others ignore it. */
  stores: MemoryStoreBinding[];
  outputs: SessionOutputBinding;
  /** How long the core stays idle before `pause`. Adapters set the provider's
   * own idle reclaim longer than this, or the provider reclaims first and the
   * disk is lost. */
  idleMs: number;
  /** Written to provider labels so a sandbox whose handle was never saved can
   * still be found and reaped. */
  labels: { workspaceId: string; sessionId: string };
}

/** Headroom of a provider lease over idlePauseMs (design §0.0b A.10): the
 * longest single tool call (10 min, bash MAX_BASH_TIMEOUT) plus 5 min, so a
 * running execution renewed only at exec boundaries keeps its sandbox. */
export const SANDBOX_LEASE_MARGIN_MS = 15 * 60_000;

/** Design §0.0b A.10: the provider's own idle reclaim (its lease) is
 * idlePauseMs + SANDBOX_LEASE_MARGIN_MS or more, so a sandbox whose idle
 * pause never ran still stops within idle start + lease. Composition calls
 * this and fails on a shorter lease. */
export function assertLeaseCoversIdle(name: string, leaseMs: number, idlePauseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < idlePauseMs + SANDBOX_LEASE_MARGIN_MS) {
    throw new RangeError(`${name}: the provider lease (${leaseMs} ms) must be at least idlePauseMs (${idlePauseMs} ms) + ${SANDBOX_LEASE_MARGIN_MS} ms`);
  }
}

/** Any method may throw it: provider throttling or busy. The core backs off
 * for {@link retryAfterMs} and retries. */
export class RetryableSandboxError extends Error {
  override readonly name = "RetryableSandboxError";
  constructor(message: string, readonly retryAfterMs: number, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The sandbox disappeared during an execution (found by checkpoint, pause
 * or exec). This execution fails; the next one's `attach` returns `"gone"`
 * and resumes from the latest ref. */
export class SandboxGoneError extends Error {
  override readonly name = "SandboxGoneError";
}

/** How Memory Stores (`/mnt/memory/<name>/`) and outputs
 * (`/mnt/session/outputs/`) enter and leave the sandbox. Mount or copy is
 * invisible to the core. */
export interface SandboxStoragePort<R> {
  /** After every acquire / attach / resume, after `egress.attach`: mount, or
   * copy in (writing back changes still in the sandbox first). Re-entrant
   * within one execution and idempotent. */
  attach(input: { runtime: R; scope: RuntimeResourceScope; fence: RuntimeResourceFence; stores: MemoryStoreBinding[]; outputs: SessionOutputBinding; signal: AbortSignal }): Promise<void>;
  /** `turn_end` / `before_stop`: write back and pull other Sessions' changes.
   * `interval` / `checkpoint`: write back only, never pull and never rewrite
   * the directory, so files the agent is editing are not overwritten. Mount
   * implementations may be a no-op. */
  sync(input: { runtime: R; scope: RuntimeResourceScope; fence: RuntimeResourceFence; stores: MemoryStoreBinding[]; outputs: SessionOutputBinding; reason: "turn_end" | "interval" | "checkpoint" | "before_stop"; signal: AbortSignal }): Promise<void>;
  /** Before snapshot, pause or stop, after sync: unmount. Copy
   * implementations may be a no-op. */
  detach(input: { runtime: R; scope: RuntimeResourceScope }): Promise<void>;
}

/** Egress: how requests from the sandbox carry Vault credentials and obey
 * the Environment `networking`. Invisible to the core. */
export interface SandboxEgressPort<R> {
  /** At the start of every execution (once per work item), before
   * `storage.attach`: configure the firewall from `policy` (providers that
   * can change it at runtime), then, when there are substitutions, install
   * the forwarder or interception and write placeholder env. `policy: null`
   * = unrestricted and no sandbox credentials. Called again in the same
   * execution after a re-acquired handle, fork or memory-snapshot restore,
   * so it must be idempotent. */
  attach(input: { runtime: R; scope: RuntimeResourceScope; fence: RuntimeResourceFence; policy: EgressPolicy | null; signal: AbortSignal }): Promise<void>;
  /** The policy or credentials changed mid-execution (Environment
   * `networking` or the Session's `vault_ids`). Providers that cannot apply
   * it until the next execution make it a no-op. */
  update(input: { runtime: R; scope: RuntimeResourceScope; fence: RuntimeResourceFence; policy: EgressPolicy | null; changedCredentialIds: readonly string[] }): Promise<void>;
  /** Before stop, pause or snapshot. Idempotent; on failure the host destroys
   * the sandbox. */
  revoke(input: { runtime: R; scope: RuntimeResourceScope; fence: RuntimeResourceFence; reason: "completed" | "failed" | "lease_lost" | "checkpoint" }): Promise<void>;
}

/** Exact host name or `*.example.com` (subdomains only, not the apex). No
 * scheme, port or path. Compared lower-cased, punycode, without a trailing dot. */
export type HostPattern = string;

/** Compiled by the control plane at Session creation and again for every
 * generation. Holds host lists, credential ids and placeholders only, never
 * plaintext. Given to acquire with the Plan (creation-time firewalls) and to
 * `egress.attach` / `update` at execution time. */
export interface EgressPolicy {
  scope: { workspaceId: string; sessionId: string; generation: number };
  networking:
    | { type: "unrestricted" }
    | { type: "limited"; hosts: HostPattern[]; packageSources: HostPattern[]; mcpHosts: string[] };
  /** environment_variable, cap_cli and credentialed github_repository
   * resources compile to this. Empty = no forwarder is installed. */
  substitutions: Substitution[];
}

export interface Substitution {
  credentialId: string;
  envName: string;
  placeholder: string;
  hosts: HostPattern[];
  inject: { header: boolean; body: boolean };
}
