import type {
  RuntimeSessionSnapshot,
  SessionInputLifecycleContext,
  SessionMemoryAccessPort,
  SessionMemoryDocument,
} from "@open-managed-agents/runtime-resource-contract";
import { parseExecResult, UNKNOWN_EXIT_CODE, type SandboxPort } from "@open-managed-agents/sandbox";

const markerName = ".openma-memory-store";
const manifestVersion = 1;
const deleteSafetyLimit = 50;

export interface SessionMemoryWorkspaceFilePort {
  /** Returns relative text files, or null when the directory is absent/empty. */
  scan(root: string, signal: AbortSignal): Promise<ReadonlyMap<string, string> | null>;
  read(path: string, signal: AbortSignal): Promise<string | null>;
  write(path: string, content: string, signal: AbortSignal): Promise<void>;
  /** Replaces only this directory; callers validate it is a dedicated mount.
   * `readOnly` removes write permission from the result inside the sandbox. */
  replace(
    root: string,
    entries: ReadonlyMap<string, string>,
    signal: AbortSignal,
    options: { readOnly: boolean },
  ): Promise<void>;
}

/** What the lifecycle reads from a Session input context. Narrower than
 * {@link SessionInputLifecycleContext} so a host whose fence is a callback
 * (the Node control plane) passes real values only; full contexts still fit. */
export interface SessionMemoryWorkspaceContext {
  session: Pick<RuntimeSessionSnapshot, "id" | "resources">;
  resourceOwnership: SessionInputLifecycleContext["resourceOwnership"];
  access?: Pick<NonNullable<SessionInputLifecycleContext["access"]>, "memories">;
  /** Revalidated immediately before every canonical mutation. */
  authorize(): Promise<boolean>;
  signal: AbortSignal;
}

export interface DistrustedSessionMemoryWorkspace {
  memoryStoreId: string;
  mountPath: string;
  reason: "marker_missing" | "directory_missing" | "baseline_missing";
}

/** A writable Memory Store directory that could not be trusted at a sync
 * point. It has been reset to the canonical store; local changes made since
 * the last successful sync were not saved. */
export class SessionMemoryWorkspaceDistrustedError extends Error {
  constructor(readonly stores: readonly DistrustedSessionMemoryWorkspace[]) {
    super(
      `Writable Memory Store workspace became distrusted: ${stores
        .map((store) => `${store.memoryStoreId} at ${store.mountPath} (${store.reason})`)
        .join(", ")}. It was reset to the store's current contents; local changes since the last sync were not saved.`,
    );
    this.name = "SessionMemoryWorkspaceDistrustedError";
  }
}

/** The directory a Memory Store is synced into cannot be created or written
 * by the sandbox user: a sandbox-image precondition. */
export class SessionMemoryRootNotWritableError extends Error {
  constructor(readonly directory: string, readonly mountPath: string, detail: string) {
    super(
      `${directory} is not writable by the sandbox user, so Memory Store directory ${mountPath} cannot be created` +
        `${detail === "" ? "" : ` (${detail})`}. The sandbox image must provide a ${directory} this user can write; see docs/memory-stores.md.`,
    );
    this.name = "SessionMemoryRootNotWritableError";
  }
}

interface MemoryAttachment {
  memoryStoreId: string;
  mountPath: string;
  access: "read_only" | "read_write";
}

interface BaselineEntry {
  id: string;
  path: string;
  sha256: string;
}

interface MemoryManifest {
  version: 1;
  memoryStoreId: string;
  mountPath: string;
  baseline: BaselineEntry[];
}

/**
 * The one Memory Store file sync. Every sandbox that does not declare a
 * native mount goes through it: the Node control plane, the provider runtime
 * and the Docker runtime all drive it over
 * {@link createSandboxSessionMemoryFilePort} (see docs/memory-stores.md).
 *
 * `materialize` copies each store into its mount path before the turn.
 * `synchronize` is the fenced turn barrier: it writes local creates, edits
 * and deletes back with three-way CAS (the store wins a conflict) and rebases
 * the directory to the canonical result. Read-only stores are copied without
 * write permission and never written back. A durable manifest beside
 * /workspace lets a reclaimed execution reconcile edits left by the previous
 * process. A writable directory whose marker or baseline is gone is
 * distrusted: it is reset to the store and the call fails with
 * {@link SessionMemoryWorkspaceDistrustedError}; a wiped folder is never read
 * as mass deletion and never silently re-pulled.
 *
 * The official AMA worker keeps using the SDK's own SessionMemoryStores and
 * therefore never enters this writer.
 */
export class SessionMemoryWorkspaceLifecycle {
  constructor(private readonly files: SessionMemoryWorkspaceFilePort) {}

  async materialize(input: SessionMemoryWorkspaceContext): Promise<void> {
    if (input.resourceOwnership.memoryStore === "worker") return;
    const attachments = memoryAttachments(input);
    if (attachments.length === 0) return;
    const access = requireMemoryAccess(input);
    const distrusted: DistrustedSessionMemoryWorkspace[] = [];
    for (const attachment of attachments) {
      input.signal.throwIfAborted();
      if (attachment.access === "read_only") {
        await this.hydrate(input, access, attachment);
        continue;
      }
      const manifest = await this.readManifest(input, attachment);
      const local = await this.files.scan(attachment.mountPath, input.signal);
      if (manifest !== null && local?.get(markerName) === markerValue(attachment.memoryStoreId)) {
        // Crash/reclaim recovery: reconcile the previous durable workspace
        // before downloading a new baseline, otherwise unsent edits vanish.
        await this.reconcileOne(input, access, attachment, manifest, local);
        continue;
      }
      await this.hydrate(input, access, attachment);
      // An absent directory is a fresh sandbox: nothing local to lose. A
      // directory with content but without the marker, under a known
      // baseline, held edits that can no longer be attributed.
      if (manifest !== null && local !== null) {
        distrusted.push({
          memoryStoreId: attachment.memoryStoreId,
          mountPath: attachment.mountPath,
          reason: "marker_missing",
        });
      }
    }
    if (distrusted.length > 0) throw new SessionMemoryWorkspaceDistrustedError(distrusted);
  }

  async synchronize(input: SessionMemoryWorkspaceContext): Promise<void> {
    if (input.resourceOwnership.memoryStore === "worker") return;
    const attachments = memoryAttachments(input);
    if (attachments.length === 0) return;
    const access = requireMemoryAccess(input);
    const distrusted: DistrustedSessionMemoryWorkspace[] = [];
    for (const attachment of attachments) {
      input.signal.throwIfAborted();
      if (attachment.access === "read_only") {
        await this.hydrate(input, access, attachment);
        continue;
      }
      const manifest = await this.readManifest(input, attachment);
      const local = await this.files.scan(attachment.mountPath, input.signal);
      if (
        manifest === null
        || local === null
        || local.get(markerName) !== markerValue(attachment.memoryStoreId)
      ) {
        // Never interpret an accidental whole-folder wipe as mass deletion:
        // reset to the store, then report it after the other stores synced.
        await this.hydrate(input, access, attachment);
        distrusted.push({
          memoryStoreId: attachment.memoryStoreId,
          mountPath: attachment.mountPath,
          reason: manifest === null
            ? "baseline_missing"
            : local === null ? "directory_missing" : "marker_missing",
        });
        continue;
      }
      await this.reconcileOne(input, access, attachment, manifest, local);
    }
    if (distrusted.length > 0) throw new SessionMemoryWorkspaceDistrustedError(distrusted);
  }

  private async reconcileOne(
    input: SessionMemoryWorkspaceContext,
    access: SessionMemoryAccessPort,
    attachment: MemoryAttachment,
    manifest: MemoryManifest,
    scanned: ReadonlyMap<string, string>,
  ): Promise<void> {
    const baseline = new Map(manifest.baseline.map((item) => [item.path, item]));
    const local = new Map<string, { content: string; sha256: string }>();
    for (const [relative, content] of scanned) {
      if (relative === markerName) continue;
      const path = wirePath(relative);
      local.set(path, { content, sha256: await sha256(content) });
    }
    const remote = byPath(await access.list({
      memoryStoreId: attachment.memoryStoreId,
      projection: "full",
      signal: input.signal,
    }), true);
    const deleteCandidates = [...baseline.values()].filter((base) => {
      const current = remote.get(base.path);
      return !local.has(base.path)
        && current !== undefined
        && current.contentSha256 === base.sha256;
    });
    if (deleteCandidates.length > deleteSafetyLimit) {
      throw new Error(
        `Session Memory deletion safety limit exceeded (${deleteCandidates.length})`,
      );
    }

    // Upserts precede deletes so a rename never destroys the only canonical
    // copy before the new path exists.
    for (const [path, localEntry] of [...local].sort(([a], [b]) => a.localeCompare(b))) {
      input.signal.throwIfAborted();
      const base = baseline.get(path);
      const current = remote.get(path);
      if (current === undefined) {
        if (base !== undefined && localEntry.sha256 === base.sha256) {
          // Deleted only remotely: the canonical deletion wins.
          continue;
        }
        await authorizeMutation(input);
        await access.create({
          memoryStoreId: attachment.memoryStoreId,
          path,
          content: localEntry.content,
          signal: input.signal,
        });
        continue;
      }
      if (current.contentSha256 === localEntry.sha256) continue;
      if (
        base === undefined
        || current.contentSha256 !== base.sha256
        || localEntry.sha256 === base.sha256
      ) {
        // New-path collision, two-sided change, or remote-only change: the
        // canonical state wins and is pulled during the rebase below.
        continue;
      }
      await authorizeMutation(input);
      await access.update({
        memoryStoreId: attachment.memoryStoreId,
        memoryId: current.id,
        path,
        content: localEntry.content,
        expectedContentSha256: base.sha256,
        signal: input.signal,
      });
    }

    for (const base of deleteCandidates.sort((a, b) => a.path.localeCompare(b.path))) {
      input.signal.throwIfAborted();
      const current = remote.get(base.path)!;
      // One scan-level marker check plus one immediate pre-delete re-check
      // bounds the accidental-wipe window without trusting harness content.
      if (
        await this.files.read(`${attachment.mountPath}/${markerName}`, input.signal)
        !== markerValue(attachment.memoryStoreId)
      ) {
        throw new Error("Session Memory marker changed during synchronization");
      }
      await authorizeMutation(input);
      await access.delete({
        memoryStoreId: attachment.memoryStoreId,
        memoryId: current.id,
        expectedContentSha256: base.sha256,
        signal: input.signal,
      });
    }

    // Re-list makes conflict/not-found responses idempotent: regardless of a
    // concurrent winner or a retry after partial success, disk and baseline
    // advance to exactly the current canonical state.
    await this.hydrate(input, access, attachment);
  }

  private async hydrate(
    input: SessionMemoryWorkspaceContext,
    access: SessionMemoryAccessPort,
    attachment: MemoryAttachment,
  ): Promise<void> {
    const canonical = byPath(await access.list({
      memoryStoreId: attachment.memoryStoreId,
      projection: "full",
      signal: input.signal,
    }), true);
    const entries = new Map<string, string>([
      [markerName, markerValue(attachment.memoryStoreId)],
    ]);
    const baseline: BaselineEntry[] = [];
    for (const memory of [...canonical.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const relative = relativeMemoryPath(memory.path);
      if (relative === markerName) {
        throw new Error(`Session Memory path ${memory.path} is reserved`);
      }
      entries.set(relative, memory.content!);
      baseline.push({ id: memory.id, path: memory.path, sha256: memory.contentSha256 });
    }
    await this.files.replace(attachment.mountPath, entries, input.signal, {
      readOnly: attachment.access === "read_only",
    });
    const manifest: MemoryManifest = {
      version: manifestVersion,
      memoryStoreId: attachment.memoryStoreId,
      mountPath: attachment.mountPath,
      baseline,
    };
    // The baseline advances last. A crash before this write safely retries
    // against the old ancestor; a crash after it has a complete rebase.
    await this.files.write(
      manifestPath(input, attachment),
      JSON.stringify(manifest),
      input.signal,
    );
  }

  private async readManifest(
    input: SessionMemoryWorkspaceContext,
    attachment: MemoryAttachment,
  ): Promise<MemoryManifest | null> {
    const raw = await this.files.read(manifestPath(input, attachment), input.signal);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      typeof value !== "object"
      || value === null
      || (value as { version?: unknown }).version !== manifestVersion
      || (value as { memoryStoreId?: unknown }).memoryStoreId !== attachment.memoryStoreId
      || (value as { mountPath?: unknown }).mountPath !== attachment.mountPath
      || !Array.isArray((value as { baseline?: unknown }).baseline)
    ) return null;
    const baseline: BaselineEntry[] = [];
    for (const item of (value as { baseline: unknown[] }).baseline) {
      if (
        typeof item !== "object"
        || item === null
        || typeof (item as { id?: unknown }).id !== "string"
        || typeof (item as { path?: unknown }).path !== "string"
        || typeof (item as { sha256?: unknown }).sha256 !== "string"
      ) return null;
      const entry = item as BaselineEntry;
      try {
        relativeMemoryPath(entry.path);
      } catch {
        return null;
      }
      baseline.push(entry);
    }
    if (new Set(baseline.map(({ path }) => path)).size !== baseline.length) return null;
    return { version: 1, memoryStoreId: attachment.memoryStoreId, mountPath: attachment.mountPath, baseline };
  }
}

function requireMemoryAccess(input: SessionMemoryWorkspaceContext): SessionMemoryAccessPort {
  const access = input.access?.memories;
  if (access === undefined) {
    throw new Error("Session Memory materialization requires per-claim Memory access");
  }
  return access;
}

function memoryAttachments(input: SessionMemoryWorkspaceContext): MemoryAttachment[] {
  return input.session.resources
    .filter((resource) => resource.type === "memory_store")
    .map((resource) => {
      const memoryStoreId = requiredString(resource, "memory_store_id");
      const mountPath = dedicatedMountPath(resource);
      const access = resource.access === "read_only" ? "read_only" : "read_write";
      return { memoryStoreId, mountPath, access };
    });
}

function dedicatedMountPath(resource: Readonly<Record<string, unknown>>): string {
  const path = requiredString(resource, "mount_path").replace(/\/+$/u, "");
  if (
    path === ""
    || path === "/"
    || path === "/workspace"
    || !path.startsWith("/")
    || path.split("/").includes("..")
    || path.includes("\0")
    || pathsOverlap(path, "/workspace/.openma/session-inputs")
  ) {
    throw new Error("Session Memory mount_path must be a dedicated safe absolute directory");
  }
  return path;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function requiredString(resource: Readonly<Record<string, unknown>>, field: string): string {
  const value = resource[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Session ${resource.type} resource requires ${field}`);
  }
  return value;
}

function manifestPath(
  input: SessionMemoryWorkspaceContext,
  attachment: MemoryAttachment,
): string {
  return `/workspace/.openma/session-inputs/${safeSegment(input.session.id)}/memory/${safeSegment(attachment.memoryStoreId)}.json`;
}

function safeSegment(value: string): string {
  if (value.length === 0 || value === "." || value === ".." || value.includes("\0")) {
    throw new Error("Session Memory identity is unsafe");
  }
  return encodeURIComponent(value);
}

function markerValue(memoryStoreId: string): string {
  return `openma-memory-store-v1\n${memoryStoreId}`;
}

function wirePath(relative: string): string {
  return `/${relativeMemoryPath(`/${relative}`)}`;
}

function relativeMemoryPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Session Memory path ${path} is unsafe`);
  }
  const relative = path.replace(/^\/+/, "");
  if (
    relative.length === 0
    || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Session Memory path ${path} is unsafe`);
  }
  return relative;
}

function byPath(
  memories: readonly SessionMemoryDocument[],
  requireContent: boolean,
): Map<string, SessionMemoryDocument> {
  const result = new Map<string, SessionMemoryDocument>();
  for (const memory of memories) {
    relativeMemoryPath(memory.path);
    if (requireContent && memory.content === undefined) {
      throw new Error(`Session Memory ${memory.id} omitted full content`);
    }
    if (result.has(memory.path)) {
      throw new Error(`Session Memory API returned duplicate path ${memory.path}`);
    }
    result.set(memory.path, memory);
  }
  return result;
}

async function authorizeMutation(input: SessionMemoryWorkspaceContext): Promise<void> {
  input.signal.throwIfAborted();
  if (!await input.authorize()) throw new Error("Session Memory resource fence lost");
  input.signal.throwIfAborted();
}

async function sha256(content: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What the file sync needs from a sandbox; every SandboxPort has it. */
export type SessionMemorySandboxFiles = Pick<SandboxPort, "exec" | "readFile" | "writeFile">;

/**
 * File access for {@link SessionMemoryWorkspaceLifecycle} over any sandbox:
 * shell commands list, probe, create and protect directories; `readFile` and
 * `writeFile` move content. Every command's exit status is read with the
 * shared `parseExecResult`, so a failed `mkdir`, `rm` or `chmod` stops the
 * sync instead of leaving a half-written Memory directory behind.
 */
export function createSandboxSessionMemoryFilePort(
  sandbox: SessionMemorySandboxFiles,
): SessionMemoryWorkspaceFilePort {
  async function run(command: string, timeoutMs: number, operation: string): Promise<string> {
    const result = parseExecResult(await sandbox.exec(command, timeoutMs));
    if (result.exitCode !== 0) {
      throw new Error(`Session Memory ${operation} failed (${exitDescription(result.exitCode)}): ${commandDetail(result)}`);
    }
    return result.stdout;
  }

  async function ensureDirectories(paths: Iterable<string>, signal: AbortSignal): Promise<void> {
    const unique = [...new Set(paths)];
    for (let index = 0; index < unique.length; index += 50) {
      signal.throwIfAborted();
      const batch = unique.slice(index, index + 50).map(shellQuote).join(" ");
      await run(`mkdir -p -- ${batch}`, 30_000, "directory creation");
    }
  }

  return {
    async scan(root, signal) {
      signal.throwIfAborted();
      // Relative paths from inside the root: adapters that map logical paths
      // to host paths (LocalSubprocess) then still report paths we can read
      // back through readFile. The listing goes through a temporary file so
      // a failing `find` is not hidden behind the pipeline's exit status.
      const encoded = (await run(
        [
          `if [ -d ${shellQuote(root)} ]; then`,
          `t=$(mktemp) || exit 1;`,
          `if (cd ${shellQuote(root)} && find . -type f -print0) > "$t"; then base64 < "$t" | tr -d '\\n'; s=0; else s=1; fi;`,
          `rm -f "$t"; exit $s;`,
          `fi`,
        ].join(" "),
        30_000,
        `scan of ${root}`,
      )).trim();
      signal.throwIfAborted();
      if (encoded === "") return null;
      const entries = new Map<string, string>();
      for (const listed of atob(encoded).split("\0").filter((path) => path.length > 0)) {
        if (!listed.startsWith("./")) {
          throw new Error("Session Memory scan escaped its mount root");
        }
        const relative = listed.slice(2);
        if (
          relative.length === 0
          || relative.split("/").some((part) => part === "" || part === "." || part === "..")
        ) {
          throw new Error("Session Memory scan returned an unsafe path");
        }
        signal.throwIfAborted();
        entries.set(relative, await sandbox.readFile(`${root}/${relative}`));
      }
      return entries.size === 0 ? null : entries;
    },
    async read(path, signal) {
      signal.throwIfAborted();
      const exists = (await run(
        `if [ -f ${shellQuote(path)} ]; then printf 1; else printf 0; fi`,
        10_000,
        `probe of ${path}`,
      )).trim();
      if (exists === "0") return null;
      if (exists !== "1") {
        throw new Error("Session Memory file probe returned invalid output");
      }
      signal.throwIfAborted();
      return sandbox.readFile(path);
    },
    async write(path, content, signal) {
      await ensureDirectories([parentDirectory(path)], signal);
      signal.throwIfAborted();
      await sandbox.writeFile(path, content);
    },
    async replace(root, entries, signal, options) {
      signal.throwIfAborted();
      // Image precondition, checked on its own so it fails with one clear
      // error: the parent (for /mnt/memory/<name>, /mnt/memory) must exist
      // or be creatable, and be writable by the sandbox user.
      const parent = parentDirectory(root);
      const precondition = parseExecResult(await sandbox.exec(
        `mkdir -p -- ${shellQuote(parent)} && [ -w ${shellQuote(parent)} ]`,
        10_000,
      ));
      if (precondition.exitCode !== 0) {
        throw new SessionMemoryRootNotWritableError(parent, root, commandDetail(precondition));
      }
      signal.throwIfAborted();
      // A previous read-only copy has no write bits; restore them first.
      await run(
        `if [ -e ${shellQuote(root)} ]; then chmod -R u+w ${shellQuote(root)}; fi && rm -rf -- ${shellQuote(root)} && mkdir -p -- ${shellQuote(root)}`,
        30_000,
        `reset of ${root}`,
      );
      await ensureDirectories(
        [...entries.keys()]
          .map((relative) => parentDirectory(`${root}/${relative}`))
          .filter((directory) => directory !== root),
        signal,
      );
      for (const [relative, content] of entries) {
        signal.throwIfAborted();
        await sandbox.writeFile(`${root}/${relative}`, content);
      }
      if (options.readOnly) {
        signal.throwIfAborted();
        await run(`chmod -R a-w ${shellQuote(root)}`, 30_000, `read-only protection of ${root}`);
      }
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function exitDescription(exitCode: number): string {
  return exitCode === UNKNOWN_EXIT_CODE ? "unknown exit status" : `exit ${exitCode}`;
}

function commandDetail(result: { stdout: string; stderr: string }): string {
  const detail = `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`.trim();
  return detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
}

/** The Memory Store file sync for one sandbox. The single entry point that
 * the Node control plane, the provider runtime and the Docker runtime use. */
export function sandboxMemoryStoreSync(
  sandbox: SessionMemorySandboxFiles,
): SessionMemoryWorkspaceLifecycle {
  return new SessionMemoryWorkspaceLifecycle(createSandboxSessionMemoryFilePort(sandbox));
}
