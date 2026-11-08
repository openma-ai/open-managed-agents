import type {
  SandboxCheckpointHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxExecutor,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
  ProcessHandle,
} from "@open-managed-agents/sandbox";
import type { Env } from "@open-managed-agents/shared";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import { cloudflareWorkspaceMountPrefix } from "@open-managed-agents/managed-runtime-cloudflare";
import type {
  OmaMountBucketRequest,
  OmaProvisionResult,
  OmaSandboxDescription,
} from "../oma-sandbox";
import type { WorkspaceBackupHandle } from "./workspace-backups";
// `bash-parser` is CJS; the bundler handles interop for worker builds.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import parseShell from "bash-parser";

/**
 * Operator catalog image a managed session runs on (resolved by the main
 * worker from its SANDBOX_IMAGES catalog and passed in the /init body).
 * `binding` is the agent worker's Durable Object binding of the container
 * class that was built from the image; `workdir` is the image's WORKDIR.
 * Absent: the default `SANDBOX` container and `/workspace`.
 */
export interface CloudflareSandboxImage {
  alias: string;
  binding: string;
  workdir?: string;
}

const CLOUDFLARE_DEFAULT_WORKSPACE_ROOT = "/workspace";
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Validate an /init `sandbox_image` and look up its container namespace.
 * Throws instead of falling back to `SANDBOX`: a session that selected a
 * task image must never silently run on the default image. */
export function resolveCloudflareSandboxNamespace(
  env: Env,
  image: CloudflareSandboxImage | null | undefined,
): unknown {
  if (image === null || image === undefined) return env.SANDBOX;
  if (typeof image.binding !== "string" || !BINDING_NAME.test(image.binding)) {
    throw new Error(`Sandbox image "${image.alias}" has an invalid container binding name`);
  }
  if (image.workdir !== undefined && (typeof image.workdir !== "string" || !image.workdir.startsWith("/") || image.workdir.split("/").includes(".."))) {
    throw new Error(`Sandbox image "${image.alias}" has an invalid workdir`);
  }
  const namespace = (env as unknown as Record<string, unknown>)[image.binding];
  if (namespace === undefined || namespace === null) {
    throw new Error(
      `Sandbox image "${image.alias}" needs container binding ${image.binding}, which this agent worker does not declare. ` +
        "Add the container class and Durable Object binding to apps/agent/wrangler.jsonc (docs/cloudflare-sandbox-images.md).",
    );
  }
  return namespace;
}

const parseShellCommand = parseShell as (command: string) => {
  type: string;
  commands?: Array<Record<string, any>>;
};

/** Vitest override — see test/sandbox-stub + cloudflare-sandbox-duplex.test.ts */
let cloudflareSandboxTestOverride: unknown;
export function setCloudflareSandboxForTest(sandbox: unknown): void {
  cloudflareSandboxTestOverride = sandbox;
}



export class CloudflareSandbox
  implements SandboxExecutor, SandboxDuplexProcessPort, SandboxRuntimePort {
  private sandboxPromise: Promise<any> | null = null;
  private env: Env;
  private sessionId: string;
  private mounted = false;
  private commandSecrets = new Map<string, Record<string, string>>();
  private processEnv: Record<string, string> = {};
  private outboundRequired = false;
  private controlPlaneHostname: string | null = null;
  private readonly image: CloudflareSandboxImage | null;
  private readonly namespace: unknown;
  private readonly namespaceError: unknown;
  /** Workdir from the catalog entry; null keeps the SDK default /workspace. */
  private readonly workdir: string | null;

  constructor(env: Env, sessionId: string, image?: CloudflareSandboxImage | null) {
    this.env = env;
    this.sessionId = sessionId;
    this.image = image ?? null;
    this.workdir = this.image?.workdir ?? null;
    // An invalid or undeclared image fails on first use, never falls back to
    // the default SANDBOX container (resolveCloudflareSandboxNamespace).
    try {
      this.namespace = resolveCloudflareSandboxNamespace(env, this.image);
      this.namespaceError = null;
    } catch (err) {
      this.namespace = undefined;
      this.namespaceError = err;
    }
  }

  /** Resolve DO stub (or vitest override). Lazy so capability probes work without a binding. */
  private resolveSandboxStub(): Promise<any> {
    if (cloudflareSandboxTestOverride !== undefined) {
      return Promise.resolve(cloudflareSandboxTestOverride);
    }
    if (this.namespaceError !== null) return Promise.reject(this.namespaceError);
    const ns = this.namespace as DurableObjectNamespace | undefined;
    const binding = this.image?.binding ?? "SANDBOX";
    if (!ns || typeof (ns as any).getByName !== "function") {
      throw new Error(`${binding} binding missing getByName (got ${typeof ns})`);
    }
    // Sandbox SDK 1.0: Durable Object stub via getByName (replaces getSandbox).
    return Promise.resolve((ns as any).getByName(this.sessionId));
  }

  /** ADR 0016: the catalog entry's declared workdir, else /workspace. The
   * CF SDK cannot report the image WORKDIR, so the operator declares it. */
  async resolveWorkspaceRoot(): Promise<string> {
    return this.workdir ?? CLOUDFLARE_DEFAULT_WORKSPACE_ROOT;
  }

  private async getSandbox() {
    if (!this.sandboxPromise) {
      try {
        this.sandboxPromise = this.resolveSandboxStub();
      } catch (err: any) {
        this.sandboxPromise = Promise.reject(
          new Error(`getSandbox failed (${this.image?.binding ?? "SANDBOX"}, id: ${this.sessionId}): ${err?.message || err}`),
        );
      }
    }
    return this.sandboxPromise;
  }

  runtimeHandle(): SandboxRuntimeHandle {
    return { provider: "cloudflare", runtimeId: this.sessionId };
  }

  runtimeCapabilities(): SandboxRuntimeCapabilities {
    return {
      lease: true,
      suspend: ["filesystem"],
      checkpoint: ["filesystem"],
    };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    // The Cloudflare Sandbox proxy deliberately has no read-only container
    // status call. Probing with exec() would wake a sleeping container, so
    // report the honest portable value instead of mutating it during status.
    return "unknown";
  }

  async renewLease(input: { ttlMs: number }): Promise<void> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("Cloudflare sandbox lease ttlMs must be positive");
    }
    await this.renewActivityTimeout();
  }

  async checkpoint(input: {
    kind: "filesystem" | "memory";
    name?: string;
  }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Cloudflare sandbox supports filesystem checkpoints only");
    }
    const backup = await this.createWorkspaceBackup({
      ...(input.name ? { name: input.name } : {}),
      ttlSec: 7 * 24 * 60 * 60,
    });
    if (backup === null) {
      throw new Error("Cloudflare sandbox checkpoint creation returned no backup");
    }
    return {
      provider: "cloudflare",
      checkpointId: backup.id,
      sourceRuntimeId: this.sessionId,
      kind: "filesystem",
      scope: "portable",
      metadata: {
        dir: backup.dir,
        ...(backup.size !== undefined && { size: backup.size }),
        ...(backup.sha256 !== undefined && { sha256: backup.sha256 }),
        ...(backup.format !== undefined && { format: backup.format }),
        ...(backup.localBucket !== undefined && {
          localBucket: backup.localBucket,
        }),
      },
    };
  }

  async suspend(input: {
    kind: "filesystem" | "memory";
  }): Promise<SandboxCheckpointHandle> {
    const checkpoint = await this.checkpoint(input);
    await this.destroy();
    return checkpoint;
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== "cloudflare" ||
      checkpoint.kind !== "filesystem" ||
      checkpoint.scope !== "portable"
    ) {
      throw new Error("Cloudflare sandbox cannot resume this checkpoint");
    }
    const dir = checkpoint.metadata?.dir;
    const localBucket = checkpoint.metadata?.localBucket;
    if (typeof dir !== "string" || dir.length === 0) {
      throw new Error("Cloudflare sandbox checkpoint is missing its directory");
    }
    if (localBucket !== undefined && typeof localBucket !== "boolean") {
      throw new Error("Cloudflare sandbox checkpoint localBucket is invalid");
    }
    const { size, sha256, format } = checkpoint.metadata ?? {};
    const restored = await this.restoreWorkspaceBackup({
      id: checkpoint.checkpointId,
      dir,
      ...(typeof size === "number" && { size }),
      ...(typeof sha256 === "string" && { sha256 }),
      ...(typeof format === "string" && { format }),
      ...(typeof localBucket === "boolean" && { localBucket }),
    });
    if (!restored.ok) {
      throw new Error(restored.error ?? "Cloudflare sandbox checkpoint restore failed");
    }
  }

  /**
   * @deprecated /workspace persistence is now via createBackup/restoreBackup
   * (see restoreWorkspaceBackup + createWorkspaceBackup below). This is kept
   * as a no-op so callers that call mountWorkspace() during warmup don't
   * break, but it does NOT mount R2 anymore.
   *
   * Why dropped:
   *   - `localBucket: true` silently fails to push writes back in real CF
   *     (only works in `wrangler dev`). Workspace was effectively ephemeral.
   *   - FUSE/s3fs mode would make every `/workspace/...` write a synchronous
   *     R2 PUT (~100-500ms per write), unacceptable for typical agent flows
   *     (compile, build, scratch files).
   *   - Cloudflare's recommended pattern for "fast workspace + persist
   *     across sessions" is createBackup at session end + restoreBackup at
   *     session warmup. See changelog 2026-02-23.
   */
  async mountWorkspace(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;
    // Intentionally no-op. /workspace is plain container disk now.
    // Persistence is wired in session-do.ts via restoreWorkspaceBackup
    // (warmup) and createWorkspaceBackup (destroy).
  }

  /** Opt-in, live R2-backed /workspace. Mount contents are not included in
   * sandbox checkpoints and this path provides no version/rollback semantics.
   * Never substitute localBucket mode for a durable mount. */
  durableWorkspaceMount(input: { workspaceId: string; sessionId: string }): OmaMountBucketRequest {
    const prefix = `/${cloudflareWorkspaceMountPrefix(input.workspaceId, input.sessionId)}`;
    const fuse = this.fuseR2ConfigOrNull();
    const bucketName = this.env.WORKSPACE_BUCKET_NAME?.trim();
    if (!this.env.WORKSPACE_BUCKET || !bucketName || !fuse) {
      throw new Error("Workspace R2 credentials and bucket binding are required for durable_mount");
    }
    // Sandbox SDK 1.0 S3Gateway signs each request in the Worker; the
    // container never receives bucket credentials.
    return {
      bucket: bucketName,
      mountPath: "/workspace",
      options: {
        endpoint: fuse.endpoint,
        provider: "r2",
        credentials: fuse.credentials,
        prefix,
        readOnly: false,
      },
    };
  }

  async mountDurableWorkspace(input: { workspaceId: string; sessionId: string }): Promise<void> {
    const mount = this.durableWorkspaceMount(input);
    const sandbox = await this.getSandbox();
    if (typeof sandbox.mountBucket !== "function") {
      throw new Error("Cloudflare sandbox does not expose the workspace R2 mount primitive");
    }
    await sandbox.mountBucket(mount.bucket, mount.mountPath, mount.options);
  }

  /** Reads the container state without starting it. */
  async describeSandbox(): Promise<OmaSandboxDescription> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.describe !== "function") {
      // An SDK-shaped double without the provisioning RPC starts lazily.
      return { running: false, incarnation: null, mounts: [] };
    }
    return sandbox.describe();
  }

  /** Starts a container with its complete mount set, or reports the running
   * one. Sandbox SDK 1.0 attaches mounts only while a container starts. */
  async provisionSandbox(input: {
    incarnation: string;
    mounts: OmaMountBucketRequest[];
    autoStart?: boolean;
  }): Promise<OmaProvisionResult> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.provision !== "function") {
      for (const mount of input.mounts) {
        if (typeof sandbox.mountBucket === "function") {
          await sandbox.mountBucket(mount.bucket, mount.mountPath, mount.options);
        }
      }
      return { incarnation: input.incarnation, started: true, pendingMounts: [] };
    }
    const result = await sandbox.provision({
      incarnation: input.incarnation,
      mounts: input.mounts,
      autoStart: input.autoStart ?? false,
      // A new container starts with an empty process environment; warmup
      // publishes the current contract again.
      env: {},
    }) as OmaProvisionResult;
    if (result.started) this.processEnv = {};
    return result;
  }

  /**
   * Snapshot /workspace into R2 via squashfs. Returns a handle the caller
   * persists in D1 (workspace_backups table). Best-effort: failure is
   * logged but does not raise — losing a backup is recoverable (worst
   * case: next session starts from empty workspace).
   */
  async createWorkspaceBackup(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<WorkspaceBackupHandle | null> {
    const sandbox = await this.getSandbox();
    // Detect dev mode: in wrangler dev there are no R2 S3 keys (no
    // presigned URLs available), so the SDK requires localBucket: true
    // which uses BACKUP_BUCKET binding directly. In prod we omit it and
    // the SDK uses presigned URLs.
    const isDev = !this.env.R2_ENDPOINT || !this.env.R2_ACCESS_KEY_ID;
    // Don't catch — let caller surface the SDK error in trajectory.
    // Earlier swallowed errors made silent backup failures look identical
    // to "no backup needed" from the perspective of the next session.
    const backup = await sandbox.createBackup({
      dir: "/workspace",
      name: opts.name,
      ttl: opts.ttlSec,
      // Skip the obvious bloat. node_modules can be 100s of MB and is
      // re-installable. Same for build caches.
      excludes: ["node_modules", ".cache", "__pycache__", ".next", "target"],
      // If /workspace is a git repo, respect .gitignore — it covers
      // build artifacts the project itself declared as expendable.
      gitignore: true,
      ...(isDev ? { localBucket: true } : {}),
    });
    // Sandbox SDK 1.0 restore verifies size and sha256; keep the record whole.
    return {
      id: backup.id,
      dir: backup.dir,
      ...(backup.size !== undefined && { size: backup.size }),
      ...(backup.sha256 !== undefined && { sha256: backup.sha256 }),
      ...(backup.format !== undefined && { format: backup.format }),
      ...(backup.name !== undefined && { name: backup.name }),
      ...(backup.localBucket !== undefined && { localBucket: backup.localBucket }),
    };
  }

  /**
   * Restore a previously created backup into /workspace. Returns
   * `{ ok: true }` on success, `{ ok: false, error: <message> }` on
   * failure. Best-effort: failure is logged AND surfaced to the caller
   * so observability can capture the underlying reason (expired squashfs,
   * R2 fetch error, container restoreArchive non-success, etc.).
   *
   * Earlier shape (`Promise<boolean>`) only returned a bare boolean which
   * meant a silently-failing restore looked identical to "no backup
   * existed" — diagnosed during 2026-05-02 TB pilot when hello-world
   * file vanished post-recycle but no error surfaced.
   */
  async restoreWorkspaceBackup(handle: WorkspaceBackupHandle): Promise<{ ok: boolean; error?: string }> {
    try {
      const sandbox = await this.getSandbox();
      await sandbox.restoreBackup(handle);
      return { ok: true };
    } catch (err) {
      // Common: backup expired (BACKUP_EXPIRED), R2 lifecycle deleted the
      // squashfs, container's restoreArchive failed, etc. Either way, fall
      // through to empty workspace — agent can re-clone / re-install as
      // if it's a fresh session. Surface the message so callers can log.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[sandbox] restoreWorkspaceBackup failed: ${msg}`,
      );
      return { ok: false, error: msg.slice(0, 500) };
    }
  }

  /**
   * Mount a memory store into the sandbox at /mnt/memory/<store_name>/.
   * Uses sandbox.mountBucket with prefix scoping so the agent only sees this
   * store's keys (`<store_id>/...`) under the mount, regardless of what other
   * tenants have in MEMORY_BUCKET.
   *
   * Anthropic Managed Agents Memory contract: the agent reads/writes via
   * standard file tools — no bespoke memory_* tools (those were removed).
   *
   * Mode selection:
   *   - Production (FUSE / s3fs): used when R2_ENDPOINT + R2_ACCESS_KEY_ID
   *     + R2_SECRET_ACCESS_KEY are all bound. Writes flow synchronously
   *     over the S3 API and trigger R2 Event Notifications → CF Queue →
   *     consumer → D1 audit. This is the contract the rest of the memory
   *     subsystem assumes.
   *   - wrangler dev (`localBucket: true`): R2 binding-sync. Reads work,
   *     writes do NOT persist to R2 in real CF — only used here as a dev
   *     fallback so `pnpm wrangler dev` keeps working without R2 keys.
   */
  memoryStoreMount(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): OmaMountBucketRequest {
    if (!this.env.MEMORY_BUCKET) {
      throw new Error(
        `MEMORY_BUCKET binding missing — cannot mount memory store ${opts.storeName}`,
      );
    }
    const mountPath = `/mnt/memory/${opts.storeName}`;
    // Trailing slash on the prefix ensures we don't accidentally match
    // sibling prefixes (e.g. "abc/" vs "abcd/...").
    const prefix = `/${opts.storeId}/`;
    const fuse = this.fuseR2ConfigOrNull();
    const bucketName = this.env.MEMORY_BUCKET_NAME;
    if (fuse && bucketName) {
      return {
        bucket: bucketName,
        mountPath,
        options: {
          endpoint: fuse.endpoint,
          provider: "r2",
          credentials: fuse.credentials,
          prefix,
          readOnly: opts.readOnly,
        },
      };
    }
    // Dev fallback. Sandbox SDK 1.0 cannot mount through an R2 binding, so
    // this is a plain directory: agent writes to /mnt/memory/ never reach R2.
    console.warn(
      "[sandbox] mountMemoryStore: R2 FUSE creds missing (R2_ENDPOINT / " +
      "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / MEMORY_BUCKET_NAME) — " +
      "using a local, non-durable directory. Agent writes to /mnt/memory/ " +
      "will NOT persist; this is dev-only behavior.",
    );
    return {
      bucket: "MEMORY_BUCKET",
      mountPath,
      options: { localBucket: true, prefix, readOnly: opts.readOnly },
    };
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const mount = this.memoryStoreMount(opts);
    const sandbox = await this.getSandbox();
    // Sandbox SDK 1.0 reuses a matching mount and rejects a conflicting one;
    // the 0.12 unmount-before-mount cleanup would detach a live mount here.
    await sandbox.mountBucket(mount.bucket, mount.mountPath, mount.options);
  }

  /**
   * Mount FILES_BUCKET at /mnt/session/outputs/ scoped to (tenant, session)
   * via R2 prefix. Mirrors AMA's `/mnt/session/outputs/` magic dir — agent
   * writes here using the standard `write` tool, files appear in the
   * caller-visible session outputs listing in real time (s3fs PUT each
   * write).
   *
   * R2 key scheme: t/<tenant>/session-outputs/<session>/<filename>
   * Caller list:    GET /v1/sessions/:id/outputs   (R2 list_objects by prefix)
   * Caller fetch:   GET /v1/sessions/:id/outputs/:filename
   *
   * Mount failures are surfaced to the Port caller. A managed-runtime caller
   * that declares outputs must fail preparation rather than advertise a
   * durable output path that is not actually connected.
   */
  sessionOutputMountCapabilities(): {
    durability: "durable" | "best_effort";
  } | null {
    if (!this.env.FILES_BUCKET) return null;
    return {
      durability: this.fuseR2ConfigOrNull() === null
        ? "best_effort"
        : "durable",
    };
  }

  sessionOutputsMount(opts: {
    tenantId: string;
    sessionId: string;
  }): OmaMountBucketRequest | null {
    if (!this.env.FILES_BUCKET) return null;
    const mountPath = `/mnt/session/outputs`;
    // s3fs wants a leading-slash prefix for directory scope; the shared
    // helper returns the R2-key form (no leading slash) so we prepend.
    const prefix = `/${sessionOutputsPrefix(opts.tenantId, opts.sessionId)}`;
    const fuse = this.fuseR2ConfigOrNull();
    if (fuse) {
      return {
        bucket: "managed-agents-files",
        mountPath,
        options: {
          endpoint: fuse.endpoint,
          provider: "r2",
          credentials: fuse.credentials,
          prefix,
          readOnly: false,
        },
      };
    }
    // Dev fallback: a local directory, advertised as best_effort above.
    console.warn(
      "[sandbox] mountSessionOutputs: R2 FUSE creds missing — using a " +
      "local directory. Agent writes to /mnt/session/outputs/ will NOT " +
      "persist to R2; this is dev-only behavior.",
    );
    return {
      bucket: "FILES_BUCKET",
      mountPath,
      options: { localBucket: true, prefix, readOnly: false },
    };
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    const mount = this.sessionOutputsMount(opts);
    if (mount === null) {
      console.warn(
        "[sandbox] mountSessionOutputs: FILES_BUCKET binding missing — skipping",
      );
      return;
    }
    const sandbox = await this.getSandbox();

    // A plain-object test sandbox has no bucket mounts. Keep the filesystem
    // contract testable without claiming durability: create the directory
    // and advertise `best_effort` via the capability method above.
    if (mount.options.localBucket && typeof sandbox.mountBucket !== "function") {
      await sandbox.exec("mkdir -p /mnt/session/outputs", { timeout: 5000 });
      console.warn(
        "[sandbox] mountSessionOutputs: local dev stub has no bucket mount; " +
        "created a non-durable /mnt/session/outputs directory",
      );
      return;
    }

    try {
      await sandbox.mountBucket(mount.bucket, mount.mountPath, mount.options);
    } catch (err) {
      console.error(
        `[sandbox] mountSessionOutputs failed: ${(err as Error).message ?? err}`,
      );
      // The Port caller decides whether this capability is required.
      // Swallowing here made a failed mount indistinguishable from a durable
      // attachment.
      throw err;
    }
  }

  /**
   * Returns the R2 S3 credentials block if all three FUSE env vars are
   * present, else null (dev fallback). Centralized so memory + workspace
   * share the same gating.
   */
  private fuseR2ConfigOrNull(): {
    endpoint: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  } | null {
    const endpoint = this.env.R2_ENDPOINT;
    const accessKeyId = this.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) return null;
    return { endpoint, credentials: { accessKeyId, secretAccessKey } };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const sandbox = await this.getSandbox();
    const timeoutMs = timeout || 120000;
    const injectedSecrets = this.getSecretsForCommand(command);
    const processEnv = this.processEnvironmentForCommand(command);
    try {
      const execPromise = sandbox.exec(command, {
        timeout: timeoutMs,
        env: processEnv,
        ...(this.workdir !== null && { cwd: this.workdir }),
      }).then((result: { stdout?: string; stderr?: string; exitCode?: number }) => {
        const out = result.stdout || "";
        const err = result.stderr || "";
        const combined = `exit=${result.exitCode}\n${out}${err ? "\nstderr: " + err : ""}`;
        return this.appendSecretRetryHint(command, combined, injectedSecrets);
      });
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(
          `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 100)}`,
        )), timeoutMs + 10000),
      );
      return await Promise.race([execPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`exec("${command.slice(0, 80)}") failed: ${msg}`);
    }
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.startProcess !== "function") return null;
    try {
      const proc = await sandbox.startProcess(command, {
        env: this.processEnvironmentForCommand(command),
        ...(this.workdir !== null && { cwd: this.workdir }),
      });
      if (!proc?.id) return null;
      return {
        id: proc.id,
        pid: proc.pid,
        kill: (signal: string) => proc.kill(signal),
        getLogs: () => proc.getLogs(),
        getStatus: () => proc.getStatus(),
      };
    } catch {
      return null; // fallback to exec
    }
  }

  async spawnDuplexProcess(
    spec: SandboxDuplexProcessSpec,
  ): Promise<SandboxDuplexProcess> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.spawnDuplex === "function") {
      return this.spawnPipedDuplexProcess(sandbox, spec);
    }
    if (typeof sandbox.startProcess !== "function") {
      throw new Error("Cloudflare sandbox does not support background processes");
    }

    // The Cloudflare SDK streams process output but does not expose stdin.
    // Keep a FIFO open read/write inside the process and send each ACP NDJSON
    // frame through a short sandbox exec. The process-held writer prevents an
    // EOF between frames, preserving one long-lived ACP stdio session.
    const channelDir = `/tmp/openma-duplex-${crypto.randomUUID()}`;
    const stdinPath = `${channelDir}/stdin`;
    const setup = await sandbox.exec(
      `mkdir -p ${shellQuote(channelDir)} && mkfifo ${shellQuote(stdinPath)}`,
      { timeout: 10_000 },
    );
    assertSandboxCommandSucceeded(setup, "create duplex-process channel");

    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let streamsClosed = false;
    let cleanupStarted = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    });
    const encoder = new TextEncoder();
    let settleExit!: (value: { code: number | null; signal: string | null }) => void;
    let exitSettled = false;
    let killSignal: string | null = null;
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit) => { settleExit = resolveExit; },
    );
    const closeStreams = (error?: Error) => {
      if (!streamsClosed) {
        streamsClosed = true;
        for (const controller of [stdoutController, stderrController]) {
          try {
            if (error) controller.error(error);
            else controller.close();
          } catch {
            // A consumer may have cancelled its branch already.
          }
        }
      }
    };
    const cleanup = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void sandbox.exec(
        `rm -f ${shellQuote(stdinPath)} && rmdir ${shellQuote(channelDir)}`,
        { timeout: 10_000 },
      ).catch(() => undefined);
    };
    const finish = (code: number | null, signal: string | null) => {
      closeStreams();
      if (!exitSettled) {
        exitSettled = true;
        settleExit({ code, signal });
      }
      cleanup();
    };
    const fail = (error: Error) => {
      closeStreams(error);
      if (!exitSettled) {
        exitSettled = true;
        settleExit({ code: null, signal: killSignal });
      }
      cleanup();
    };

    const command = [spec.command, ...(spec.args ?? [])]
      .map(shellQuote)
      .join(" ");
    let process: {
      kill(signal?: string): Promise<void>;
    };
    try {
      process = await sandbox.startProcess(
        `exec 3<>${shellQuote(stdinPath)}; exec ${command} <&3 3>&-`,
        {
          cwd: spec.cwd,
          env: {
            ...this.processEnv,
            ...this.getSecretsForCommand(spec.command),
            ...spec.env,
          },
          onOutput: (stream: "stdout" | "stderr", data: string) => {
            if (streamsClosed || data.length === 0) return;
            try {
              (stream === "stdout" ? stdoutController : stderrController)
                .enqueue(encoder.encode(data));
            } catch {
              // The corresponding consumer already cancelled its stream.
            }
          },
          onExit: (code: number | null) => finish(code, killSignal),
          onError: (error: Error) => fail(error),
        },
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    const stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (exitSettled) throw new Error("cannot write to an exited sandbox process");
        const encoded = bytesToBase64(chunk);
        const result = await sandbox.exec(
          `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(stdinPath)}`,
          { timeout: 30_000 },
        );
        assertSandboxCommandSucceeded(result, "write duplex-process stdin");
      },
      // The FIFO is deliberately held O_RDWR by the child, so closing a host
      // writer does not terminate a multi-turn ACP session. Session disposal
      // uses kill(), which is the portable lifecycle primitive here.
      close: async () => {},
      abort: async () => {
        killSignal = "SIGTERM";
        await process.kill("SIGTERM");
        finish(null, killSignal);
      },
    });

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async (signal = "SIGTERM") => {
        if (exitSettled) return;
        killSignal = signal;
        await process.kill(signal);
        finish(null, killSignal);
      },
    };
  }

  /** Sandbox SDK 1.0: OmaSandbox pipes the process's stdio over RPC. */
  private async spawnPipedDuplexProcess(
    sandbox: { spawnDuplex(spec: { command: string; cwd?: string; env?: Record<string, string> }): Promise<any> },
    spec: SandboxDuplexProcessSpec,
  ): Promise<SandboxDuplexProcess> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...this.processEnv,
      ...this.getSecretsForCommand(spec.command),
      ...spec.env,
    })) {
      if (value !== undefined) env[key] = value;
    }
    const command = `exec ${[spec.command, ...(spec.args ?? [])].map(shellQuote).join(" ")}`;
    const process = await sandbox.spawnDuplex({
      command,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env,
    });
    const [stdin, stdout, stderr] = await Promise.all([
      process.stdin as Promise<WritableStream<Uint8Array>>,
      process.stdout as Promise<ReadableStream<Uint8Array>>,
      process.stderr as Promise<ReadableStream<Uint8Array>>,
    ]);
    let killSignal: string | null = null;
    const exited = Promise.resolve(process.wait() as Promise<number | null>).then(
      (code) => ({ code: killSignal === null ? code : null, signal: killSignal }),
      () => ({ code: null, signal: killSignal }),
    );
    void exited.finally(() => {
      (process as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    });
    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async (signal = "SIGTERM") => {
        killSignal = signal;
        await process.kill(signal === "SIGKILL" ? 9 : 15);
      },
    };
  }

  async readFile(path: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      const result = await sandbox.readFile(path, { encoding: "utf-8" });
      // Handle both string and {success, content} shapes
      if (typeof result === "string") return result;
      if ((result as { success?: boolean }).success === false) {
        throw new Error(`SDK returned success=false: ${JSON.stringify(result)}`);
      }
      return (result as { content: string }).content;
    } catch (err: any) {
      console.warn(`[sandbox.readFile] FAILED path=${path} err=${err?.message || err}`);
      throw new Error(`readFile(${path}) failed: ${err?.message || err}`);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      const result = await sandbox.writeFile(path, content);
      if (result && (result as { success?: boolean }).success === false) {
        throw new Error(`SDK returned success=false: ${JSON.stringify(result)}`);
      }
      return "ok";
    } catch (err: any) {
      console.warn(`[sandbox.writeFile] FAILED path=${path} err=${err?.message || err}`);
      throw new Error(`writeFile(${path}) failed: ${err?.message || err}`);
    }
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const sandbox = await this.getSandbox();
    // Encode to base64 client-side and ask the sandbox to decode. Avoids any
    // UTF-8 reinterpretation of the bytes in flight. The SDK's encoding hint
    // tells the sandbox how to interpret the string we send.
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    const b64 = btoa(bin);
    try {
      const result = await sandbox.writeFile(path, b64, { encoding: "base64" });
      if (result && (result as { success?: boolean }).success === false) {
        throw new Error(`SDK returned success=false: ${JSON.stringify(result)}`);
      }
      return "ok";
    } catch (err: any) {
      console.warn(`[sandbox.writeFileBytes] FAILED path=${path} err=${err?.message || err}`);
      throw new Error(`writeFileBytes(${path}) failed: ${err?.message || err}`);
    }
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    Object.assign(this.processEnv, envVars);
    const sandbox = await this.getSandbox();
    if (typeof sandbox.setEnvVars === "function") {
      await sandbox.setEnvVars(envVars);
    }
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.set(commandPrefix, secrets);
  }

  /**
   * Bind the OmaSandbox `inject_vault_creds` outbound handler with the
   * session's identifying context (tenantId, sessionId). The handler runs
   * in the agent worker scope; on every outbound HTTPS request the
   * sandbox makes, it RPCs to main with these identifiers, main does the
   * validates the current Session/fence and forwards through the shared
   * relay core. Neither the container nor this adapter receives a Vault token.
   */
  async setOutboundContext(opts: {
    tenantId: string;
    environmentId?: string;
    sessionId: string;
    workId?: string;
    ownerId?: string;
    generation?: number;
    fenceToken?: string;
    required?: boolean;
    controlPlaneBaseUrl?: string;
  }): Promise<void> {
    if (!opts.tenantId || !opts.sessionId) {
      throw new Error("Cloudflare outbound context requires tenantId and sessionId");
    }
    this.outboundRequired = opts.required === true;
    if (this.outboundRequired && this.env.MAIN_MCP === undefined) {
      throw new Error("Cloudflare required credential egress needs MAIN_MCP");
    }
    let controlPlane: URL | null = null;
    if (opts.controlPlaneBaseUrl) {
      try {
        controlPlane = new URL(opts.controlPlaneBaseUrl);
      } catch {
        throw new Error("Cloudflare control-plane base URL is invalid");
      }
      if (controlPlane.protocol !== "https:" && controlPlane.protocol !== "http:") {
        throw new Error("Cloudflare control-plane base URL must use HTTP(S)");
      }
    }
    this.controlPlaneHostname = controlPlane?.hostname ?? null;
    try {
      const sandbox = await this.getSandbox();
      const hasFn = typeof sandbox.setOutboundHandler === "function";
      console.log(
        `[sandbox] setOutboundContext tenant=${opts.tenantId.slice(0, 8)} sid=${opts.sessionId.slice(0, 12)} hasFn=${hasFn}`,
      );
      if (!hasFn) {
        if (this.outboundRequired) {
          throw new Error("Cloudflare Sandbox does not expose setOutboundHandler");
        }
        return;
      }
      await sandbox.setOutboundHandler("inject_vault_creds", {
        tenantId: opts.tenantId,
        environmentId: opts.environmentId,
        sessionId: opts.sessionId,
        workId: opts.workId,
        ownerId: opts.ownerId,
        generation: opts.generation,
        fenceToken: opts.fenceToken,
        required: this.outboundRequired,
      });
      if (typeof sandbox.setOutboundByHost === "function") {
        const context = {
          tenantId: opts.tenantId,
          environmentId: opts.environmentId,
          sessionId: opts.sessionId,
          workId: opts.workId,
          ownerId: opts.ownerId,
          generation: opts.generation,
          fenceToken: opts.fenceToken,
          required: this.outboundRequired,
          controlPlaneOrigin: controlPlane?.origin,
        };
        const bindings = [
          sandbox.setOutboundByHost("api.github.com", "github_auth", context),
          sandbox.setOutboundByHost("github.com", "github_auth", context),
        ];
        if (controlPlane) {
          bindings.push(sandbox.setOutboundByHost(
            controlPlane.hostname,
            "openma_control_plane",
            context,
          ));
        }
        await Promise.all(bindings);
      } else if (controlPlane && this.outboundRequired) {
        throw new Error("Cloudflare Sandbox does not expose setOutboundByHost");
      }
      console.log(`[sandbox] setOutboundHandler bound (RPC mode)`);
    } catch (err) {
      console.error(
        `[sandbox] setOutboundContext failed: ${(err as Error).message ?? err}`,
      );
      if (this.outboundRequired) throw err;
    }
  }

  /** Replace the live credential handler before compute is retained/stopped.
   * A stale container may still run briefly after lease loss, but every
   * intercepted request is denied once this binding lands. */
  async revokeOutboundContext(opts: {
    workId: string;
    generation: number;
    reason: "completed" | "failed" | "lease_lost";
  }): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.setOutboundHandler !== "function") {
        if (this.outboundRequired) {
          throw new Error("Cloudflare Sandbox does not expose setOutboundHandler");
        }
        return;
      }
      await sandbox.setOutboundHandler("deny_outbound", {
        workId: opts.workId,
        generation: opts.generation,
        reason: opts.reason,
      });
      if (typeof sandbox.setOutboundByHost === "function") {
        const denied = {
          workId: opts.workId,
          generation: opts.generation,
          reason: opts.reason,
        };
        const bindings = [
          sandbox.setOutboundByHost("api.github.com", "deny_outbound", denied),
          sandbox.setOutboundByHost("github.com", "deny_outbound", denied),
        ];
        if (this.controlPlaneHostname) {
          bindings.push(sandbox.setOutboundByHost(
            this.controlPlaneHostname,
            "deny_outbound",
            denied,
          ));
        }
        await Promise.all(bindings);
      }
      this.controlPlaneHostname = null;
    } catch (err) {
      console.error(
        `[sandbox] revokeOutboundContext failed work=${opts.workId.slice(0, 12)} generation=${opts.generation}: ${(err as Error).message ?? err}`,
      );
      if (this.outboundRequired) throw err;
    }
  }

  /**
   * Hand the (tenant, env, session) tuple to the OmaSandbox container DO so
   * its `onActivityExpired` hook (fires right before sleepAfter teardown)
   * can write the final /workspace snapshot into MAIN_DB scoped to this
   * session. Best-effort — failure here just means the next session in
   * this scope falls back to the previous backup or empty workspace.
   */
  async setBackupContext(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void> {
    if (!opts.tenantId || !opts.environmentId || !opts.sessionId) return;
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        setBackupContext?: (ctx: { tenantId: string; environmentId: string; sessionId: string }) => Promise<void>;
      };
      if (typeof sandbox.setBackupContext !== "function") return;
      await sandbox.setBackupContext({
        tenantId: opts.tenantId,
        environmentId: opts.environmentId,
        sessionId: opts.sessionId,
      });
    } catch (err) {
      console.error(
        `[sandbox] setBackupContext failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Trigger an immediate /workspace snapshot via the OmaSandbox helper.
   * Used by /destroy to get a final snapshot before sandbox.destroy() —
   * sleepAfter teardown handles itself via onActivityExpired. Best-effort.
   */
  async snapshotWorkspaceNow(): Promise<void> {
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        snapshotWorkspaceNow?: () => Promise<void>;
      };
      if (typeof sandbox.snapshotWorkspaceNow !== "function") return;
      await sandbox.snapshotWorkspaceNow();
    } catch (err) {
      console.error(
        `[sandbox] snapshotWorkspaceNow failed: ${(err as Error).message ?? err}`,
      );
    }
  }


  async destroy(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.destroy === "function") await sandbox.destroy();
    } catch {}
    // Invalidate the cached stub. Next `getSandbox()` call will rebuild via
    // getByName (or the vitest override), yielding a fresh RPC connection to
    // the same sessionId-keyed DO. Without this, the wrapper would hand the
    // next caller a stub pointing at the container we just destroyed —
    // followup exec calls would hit a stale RPC handle (observed staging
    // 2026-05-19: "An RPC stub was not disposed properly" warning preceded
    // the 53-min container wedge by ~12s, suggesting stale-stub reuse plays
    // a role in the hang loop).
    this.sandboxPromise = null;
    this.mounted = false;
  }

  /**
   * Forward (tenant, session, agent) tuple to OmaSandbox so its onStop /
   * pre-destroy emit can attribute the sandbox_active_seconds row. The
   * wrapper exists because SessionDO holds a CloudflareSandbox, not the
   * underlying DO stub — without this passthrough, the optional-chain
   * check at session-do.ts warmup silently no-ops.
   */
  async setBillingContext(opts: {
    tenantId: string;
    sessionId: string;
    agentId: string | null;
  }): Promise<void> {
    if (!opts.tenantId || !opts.sessionId) return;
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        setBillingContext?: (c: { tenantId: string; sessionId: string; agentId: string | null }) => Promise<void>;
      };
      if (typeof sandbox.setBillingContext !== "function") return;
      await sandbox.setBillingContext(opts);
    } catch (err) {
      console.error(
        `[sandbox] setBillingContext failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Trigger the sandbox_active_seconds emit synchronously. Called by
   * SessionDO's `/destroy` handler BEFORE `destroy()` so the write lands
   * in the request lifecycle (CF's onStop callback fires async to destroy
   * and can be dropped on DO eviction). Idempotent via storage-delete
   * inside OmaSandbox.
   */
  async emitSandboxActiveNow(): Promise<void> {
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        emitSandboxActiveNow?: () => Promise<void>;
      };
      if (typeof sandbox.emitSandboxActiveNow !== "function") return;
      await sandbox.emitSandboxActiveNow();
    } catch (err) {
      console.error(
        `[sandbox] emitSandboxActiveNow failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Reset the CF Container's sleepAfter inactivity timer. SessionDO calls
   * this from its alarm while there are background_tasks rows so a long-
   * running `python script.py &` survives past sleepAfter without us doing
   * any actual work for it. Fail-soft if SDK doesn't expose the method.
   */
  async renewActivityTimeout(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.renewActivityTimeout === "function") {
        await sandbox.renewActivityTimeout();
      }
    } catch {}
  }

  private getSecretsForCommand(command: string): Record<string, string> | undefined {
    const commandName = this.getSimpleCommandName(command);
    if (!commandName) return undefined;
    for (const [prefix, secrets] of this.commandSecrets) {
      if (commandName === prefix) return secrets;
    }
    return undefined;
  }

  private processEnvironmentForCommand(
    command: string,
  ): Record<string, string> | undefined {
    const secrets = this.getSecretsForCommand(command);
    if (Object.keys(this.processEnv).length === 0 && secrets === undefined) {
      return undefined;
    }
    return { ...this.processEnv, ...secrets };
  }


  private getSimpleCommandName(command: string): string | undefined {
    try {
      const ast = parseShellCommand(command);
      if (ast?.type !== "Script" || !Array.isArray(ast.commands) || ast.commands.length !== 1) return undefined;
      const [node] = ast.commands;
      if (node?.type !== "Command") return undefined;
      if (!node.name || typeof node.name.text !== "string" || !node.name.text) return undefined;
      if (Array.isArray(node.suffix) && node.suffix.some((part: any) => part?.type === "Redirect")) return undefined;
      if (Array.isArray(node.prefix) && node.prefix.some((part: any) => part?.type === "Redirect")) return undefined;
      return node.name.text;
    } catch {
      return undefined;
    }
  }

  private appendSecretRetryHint(
    command: string,
    result: string,
    injectedSecrets?: Record<string, string>,
  ): string {
    if (injectedSecrets) return result;
    const exitMatch = result.match(/^exit=(\d+)/);
    if (!exitMatch || exitMatch[1] === "0") return result;
    if (!this.isCompositeCommand(command)) return result;

    const matchedPrefix = this.findSecretBackedCommandPrefix(command);
    if (!matchedPrefix) return result;

    return `${result}\n\nHint: This chained shell command includes a secret-backed command (\`${matchedPrefix}\`) and failed. Retry with a single authenticated command when possible.`;
  }

  private isCompositeCommand(command: string): boolean {
    return /&&|\|\||;|\||\n/.test(command);
  }

  private findSecretBackedCommandPrefix(command: string): string | undefined {
    const atoms = command
      .split(/&&|\|\||;|\||\n/g)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const atom of atoms) {
      const commandName = this.getSimpleCommandName(atom);
      if (!commandName) continue;
      for (const prefix of this.commandSecrets.keys()) {
        if (commandName === prefix) return prefix;
      }
    }
    return undefined;
  }

  async gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<unknown> {
    const sandbox = await this.getSandbox();
    return sandbox.gitCheckout(repoUrl, options);
  }
}

export class TestSandbox implements SandboxExecutor {
  async exec(command: string): Promise<string> {
    return `exit=0\n(test: ${command})`;
  }
  async readFile(path: string): Promise<string> {
    return `(test: file ${path})`;
  }
  async writeFile(_path: string, _content: string): Promise<string> {
    return "ok";
  }
  async writeFileBytes(_path: string, _bytes: Uint8Array): Promise<string> {
    return "ok";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8_192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + chunkSize),
    );
  }
  return btoa(binary);
}

function assertSandboxCommandSucceeded(
  result: { success?: boolean; exitCode?: number; stderr?: string },
  operation: string,
): void {
  if (result.success === false || (result.exitCode ?? 0) !== 0) {
    throw new Error(
      `${operation} failed (exit ${result.exitCode ?? "unknown"}): ${result.stderr ?? ""}`,
    );
  }
}

export function createSandbox(
  env: Env,
  sessionId: string,
  image?: CloudflareSandboxImage | null,
): SandboxExecutor {
  return new CloudflareSandbox(env, sessionId, image);
}
