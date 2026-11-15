// Sandbox SDK v2 configuration SDK contracts (design §0.2). The core never
// imports these: an adapter hands a SandboxAdapterPort to createSandboxPorts,
// which returns the domain SandboxPorts.

import type {
  RuntimeResourceFence,
  RuntimeResourceScope,
  SessionMemoryAccessPort,
} from "@open-managed-agents/runtime-resource-contract";
import type { SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";
import type {
  SandboxEgressPort,
  SandboxLifecyclePort,
  SandboxPort,
  SandboxStoragePort,
} from "@open-managed-agents/sandbox";
import type { FirewallRules } from "./firewall";

/** What an adapter supplies: the lifecycle Port (required), provider
 * primitives for the generic implementations, and optional native storage /
 * egress. Lifecycle is handed to the core unchanged. */
export interface SandboxAdapterPort<R> {
  name: string;
  lifecycle: SandboxLifecyclePort<R>;
  vendor: SandboxVendorPort<R>;
  native?: {
    storage?(deps: SandboxStorageDepsPort): SandboxStoragePort<R>;
    /** `ingress`: an entry the composition layer mounts for routes 3 / 4
     * (a callback route, a tunnel listener). Omitted when there is none. */
    egress?(deps: SandboxEgressDepsPort): {
      port: SandboxEgressPort<R>; ingress?: EgressIngress;
      /** Native attach/update owns token binding, including typed legacy/no-token
       * handling. It must reject managed authorization/store failures. Default:
       * composition binds before delivery (also for native/no-relay adapters). */
      tokenBinding?: "native";
    };
  };
}

/** The only provider primitives the generic implementations use. */
export interface SandboxVendorPort<R> {
  /** Physical sandbox identity, stable across wrapper reattachment. */
  sandboxIdentity?(runtime: R): string | Promise<string>;
  exec(runtime: R, cmd: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** `null` when the file does not exist. */
  readFile(runtime: R, path: string): Promise<Uint8Array | null>;
  writeFile(runtime: R, path: string, bytes: Uint8Array): Promise<void>;
  setEnv(runtime: R, env: Record<string, string>): Promise<void>;
  /** Hand provider-neutral rules (from compileFirewall) to a provider whose
   * rules can change at runtime. Providers that only configure a firewall at
   * creation do it in acquire from the Plan. Absent = no provider firewall:
   * the policy is enforced only on traffic that reaches the gateway (§0.3). */
  applyFirewall?(runtime: R, rules: FirewallRules): Promise<void>;
  /** The runtime itself when it is a v1 SandboxPort (the v1 bridges): the
   * shared relay installer then uses its own path mapping (a local adapter
   * maps /workspace to a host directory). Absent = a view over the
   * primitives above. */
  asSandboxPort?(runtime: R): SandboxPort;
}

/** Injected by the core / composition layer. */
export interface SandboxPortDeps { storage: SandboxStorageDepsPort; egress: SandboxEgressDepsPort }

export interface SandboxStorageDepsPort {
  /** Per-workspace Memory API: list, read, CAS write-back. */
  memories(scope: RuntimeResourceScope): SessionMemoryAccessPort;
  /** Write end of the existing output collection. */
  outputs: SandboxOutputSinkPort;
  /** Whether this execution's fence is still valid; called before every write-back. */
  authorize(fence: RuntimeResourceFence): Promise<boolean>;
}

/** Receives the complete set of files under /mnt/session/outputs/ at a turn
 * boundary. Implementations replace the Session's published outputs. */
export interface SandboxOutputSinkPort {
  /** The Session's currently published outputs. createSyncStorage copies
   * them into a sandbox that has not received them yet, so the next
   * publish does not replace them with an empty directory. */
  read(input: { scope: RuntimeResourceScope; signal: AbortSignal }): AsyncIterable<readonly [logicalPath: string, bytes: Uint8Array]>;
  publish(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    files: AsyncIterable<readonly [logicalPath: string, bytes: Uint8Array]>;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface SandboxEgressDepsPort {
  gateway: {
    endpoint: { url: string; fixedIps?: readonly string[] };
    /** Short-lived token bound to one Session execution attempt (#561);
     * `attempt` is null when no execution is running. */
    issueToken(input: { scope: RuntimeResourceScope; attempt: SessionExecutionAttemptRef | null; sandbox?: object | string }): Promise<string>;
    authenticate(id: { via: "token"; token: string } | { via: "source"; claim: SourceClaim }): Promise<EgressScope | null>;
    /** = createCredentialEgressCore: policy decision first, then credential substitution. */
    handle(scope: EgressScope, req: PlainRequest): Promise<Response>;
  };
  /** Only for route 2 (provider substitution); without it no plaintext is available. */
  secrets?: { read(credentialId: string): Promise<{ value: string; expiresAt: number | null }> };
  /** Platform channels of this Session (compileFirewall `channels`): hosts
   * the platform itself needs under `limited` networking, e.g. an attached
   * repository's host (repositoryChannels). Omitted = none. */
  channels?(scope: RuntimeResourceScope): readonly string[] | Promise<readonly string[]>;
}

export interface EgressScope { workspaceId: string; sessionId: string; workId: string; generation: number; vaultIds: readonly string[] }
export interface PlainRequest { url: URL; method: string; headers: Headers; body: ReadableStream | null }
/** A provider-verified source claim (route 3). */
export interface SourceClaim { scope: RuntimeResourceScope; ownerId: string; generation: number }
/** A request entry the composition layer mounts for a native egress route. */
export interface EgressIngress { name: string; fetch(request: Request): Promise<Response> }

/** The adapter cannot be composed as configured. Thrown at composition time. */
export class SandboxAssemblyError extends Error {
  override readonly name = "SandboxAssemblyError";
}

