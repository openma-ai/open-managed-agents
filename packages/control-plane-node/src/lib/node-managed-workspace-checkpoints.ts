import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Parser } from "tar";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  RuntimeResourceFence,
  RuntimeResourceScope,
  WorkspaceCheckpointCandidate,
  WorkspacePersistencePort,
  WorkspaceBinding,
} from "@open-managed-agents/runtime-resource-contract";

const KEY = "openma.workspace.blob-key.v1";
const PREFIX = "managed-session-workspace-checkpoints";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SIZE_BEGIN = "__OPENMA_WS_SIZE_BEGIN__";
const SIZE_END = "__OPENMA_WS_SIZE_END__";

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Validate the effective (PAX/GNU-long-name-aware) entries before either
 * uploading or extracting. Symlinks may point anywhere (a venv links to
 * /usr/bin/python3); what is refused is any later entry whose path passes
 * *through* a symlink, which is how archives escape the extraction root.
 * Hardlinks must name an earlier in-archive path. */
async function validateWorkspaceArchive(bytes: Uint8Array): Promise<void> {
  // Checkpoints are produced with `tar -cf`, never compressed. Do not let a
  // hostile compressed archive expand without an uncompressed size bound.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error("Unsafe workspace archive: compressed input");
  const normalize = (name: string): string | null => {
    const trimmed = name.replace(/^(\.\/)+/u, "").replace(/\/+$/u, "");
    if (trimmed === "" || trimmed === ".") return "";
    if (posix.isAbsolute(trimmed) || trimmed.includes("\0")) return null;
    const parts = trimmed.split("/");
    if (parts.some((part) => part === ".." || part === "")) return null;
    return parts.filter((part) => part !== ".").join("/");
  };
  await new Promise<void>((resolve, reject) => {
    let invalid: Error | null = null;
    let entries = 0;
    const symlinks = new Set<string>();
    const throughSymlink = (path: string): boolean => {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) if (symlinks.has(parts.slice(0, i).join("/"))) return true;
      return false;
    };
    const fail = (reason: string) => { invalid ??= new Error(`Unsafe workspace archive: ${reason}`); };
    const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024,
      onReadEntry: (entry) => {
        if (++entries > 100_000) fail("too many entries");
        const name = normalize(entry.path);
        if (name === null) fail("invalid path");
        else if (!["Directory", "File", "OldFile", "ContiguousFile", "SymbolicLink", "Link", "FIFO"].includes(entry.type)) {
          fail("unsupported entry type");
        } else if (name !== "" && throughSymlink(name)) {
          // Includes re-declaring a symlink path as a file or directory.
          fail("entry passes through a symlink");
        } else if (entry.type === "SymbolicLink") {
          if (!entry.linkpath || entry.linkpath.includes("\0")) fail("invalid symlink");
          else if (name === "") fail("symlink replaces the workspace root");
          else symlinks.add(name);
        } else if (entry.type === "Link") {
          const target = normalize(entry.linkpath ?? "");
          if (target === null || target === "" || throughSymlink(target)) fail("hardlink escapes /workspace");
        }
        entry.resume();
      },
    });
    parser.once("error", reject);
    parser.once("end", () => invalid === null && entries > 0
      ? resolve() : reject(invalid ?? new Error("Unsafe workspace archive: empty archive")));
    parser.end(Buffer.from(bytes));
  });
}

async function readBoundedArchive(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel("Workspace checkpoint archive exceeds maximum size").catch(() => {});
        throw new Error("Workspace checkpoint archive exceeds maximum size");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function prefix(scope: Pick<RuntimeResourceScope, "workspaceId" | "sessionId">): string {
  return `${PREFIX}/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.sessionId)}/`;
}

function archiveKey(candidate: { id: string; metadata?: Readonly<Record<string, string | number | boolean | null>> }, scope: RuntimeResourceScope): string {
  const key = candidate.metadata?.[KEY];
  if (!/^wsc_[A-Za-z0-9-]+$/u.test(candidate.id) || key !== `${prefix(scope)}${candidate.id}.tar`) {
    throw new Error("Workspace checkpoint has an invalid archive key");
  }
  return key;
}

function failed(command: string): boolean {
  // SandboxExecutor adapters append an exit marker only on nonzero exit.
  // LocalSubprocess uses `[exit exit=2]` (or `[exit signal=SIGTERM]`),
  // while remote adapters use `[exit 2]`; spawning can return `[error: ...]`.
  return command.includes("[exit ") || command.includes("[error: ");
}

/** Blob-backed implementation of the existing workspace resource Port. It
 * never mounts OSS: checkpoint_restore and durable_mount are separate plans. */
class NodeBlobWorkspacePort implements WorkspacePersistencePort {
  private readonly active = new Map<string, { id: string; contentHash: string; metadata?: Readonly<Record<string, string | number | boolean | null>> }>();

  constructor(private readonly sandbox: SandboxExecutor, private readonly blobs: BlobStore) {}

  async capabilities() {
    return { strategies: ["checkpoint_restore" as const] };
  }

  async materialize(input: Parameters<WorkspacePersistencePort["materialize"]>[0]): Promise<WorkspaceBinding> {
    input.signal.throwIfAborted();
    if (input.strategy !== "checkpoint_restore") throw new Error(`Node workspace does not support ${input.strategy}`);
    const bindingId = `node-ws-${randomUUID()}`;
    if (input.activeCheckpoint !== null) {
      archiveKey(input.activeCheckpoint, input.scope);
      this.active.set(bindingId, input.activeCheckpoint);
    }
    return { bindingId, mountPath: "/workspace" };
  }

  async attach(input: Parameters<WorkspacePersistencePort["attach"]>[0]): Promise<void> {
    input.signal.throwIfAborted();
    if (input.strategy !== "checkpoint_restore") throw new Error(`Node workspace does not support ${input.strategy}`);
    const candidate = this.active.get(input.binding.bindingId);
    if (candidate === undefined) return;
    const key = archiveKey(candidate, input.scope);
    // S3BlobStore.get may begin draining its body immediately. HEAD first so
    // an obviously oversized object is rejected before allocating its bytes.
    const metadata = await this.blobs.head(key);
    if (metadata === null) throw new Error(`Workspace checkpoint restore failed: archive ${candidate.id} is missing`);
    if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error("Workspace checkpoint archive exceeds maximum size");
    const blob = await this.blobs.get(key);
    if (blob === null) throw new Error(`Workspace checkpoint restore failed: archive ${candidate.id} is missing`);
    if (blob.size > MAX_ARCHIVE_BYTES) throw new Error("Workspace checkpoint archive exceeds maximum size");
    const bytes = await readBoundedArchive(blob.body, input.signal);
    if (digest(bytes) !== candidate.contentHash) {
      throw new Error(`Workspace checkpoint restore failed: archive ${candidate.id} is corrupt`);
    }
    await validateWorkspaceArchive(bytes);
    if (!this.sandbox.writeFileBytes) throw new Error("Workspace restore requires binary sandbox writes");
    const temp = `/var/tmp/openma-workspace-restore-${randomUUID()}.tar`;
    try {
      input.signal.throwIfAborted();
      await this.sandbox.writeFileBytes(temp, bytes);
      const result = await this.sandbox.exec(`mkdir -p /workspace && tar -xf '${temp}' -C /workspace`, 120_000);
      if (failed(result)) throw new Error(`Workspace checkpoint restore failed: ${result.slice(0, 200)}`);
      input.signal.throwIfAborted();
    } finally {
      await this.sandbox.exec(`rm -f '${temp}'`, 5_000).catch(() => undefined);
    }
  }

  async checkpoint(input: Parameters<WorkspacePersistencePort["checkpoint"]>[0]): Promise<WorkspaceCheckpointCandidate> {
    input.signal.throwIfAborted();
    if (input.strategy !== "checkpoint_restore") throw new Error(`Node workspace does not support ${input.strategy}`);
    if (!this.sandbox.readFileBytes) throw new Error("Workspace checkpoint requires binary sandbox reads");
    const temp = `/var/tmp/openma-workspace-${randomUUID()}.tar`;
    let bytes: Uint8Array;
    try {
      const result = await this.sandbox.exec(`tar -C /workspace -cf '${temp}' .`, 120_000);
      if (failed(result)) throw new Error(`Workspace checkpoint archive failed: ${result.slice(0, 200)}`);
      const sizeOutput = await this.sandbox.exec(
        `printf '${SIZE_BEGIN}'; wc -c < '${temp}'; printf '${SIZE_END}'`, 5_000,
      );
      const start = sizeOutput.indexOf(SIZE_BEGIN);
      const end = sizeOutput.indexOf(SIZE_END);
      const reportedSize = start >= 0 && end > start
        ? sizeOutput.slice(start + SIZE_BEGIN.length, end).trim()
        : "";
      const size = Number(reportedSize);
      if (failed(sizeOutput) || !/^\d+$/u.test(reportedSize) || !Number.isSafeInteger(size)) {
        throw new Error("Workspace checkpoint archive size could not be verified");
      }
      if (size > MAX_ARCHIVE_BYTES) throw new Error("Workspace checkpoint archive exceeds maximum size");
      bytes = await this.sandbox.readFileBytes(temp);
      if (bytes.byteLength > MAX_ARCHIVE_BYTES || bytes.byteLength !== size) {
        throw new Error("Workspace checkpoint archive exceeds maximum size or changed during read");
      }
    } finally {
      await this.sandbox.exec(`rm -f '${temp}'`, 5_000).catch(() => undefined);
    }
    input.signal.throwIfAborted();
    await validateWorkspaceArchive(bytes);
    const id = `wsc_${randomUUID()}`;
    const key = `${prefix(input.scope)}${id}.tar`;
    const stored = await this.blobs.put(key, bytes, {
      precondition: { type: "ifNoneMatch", value: "*" },
      httpMetadata: { contentType: "application/x-tar" },
    });
    if (stored === null) throw new Error("Workspace checkpoint archive key already exists");
    input.signal.throwIfAborted();
    return { id, contentHash: digest(bytes), revision: input.fence.generation, metadata: { [KEY]: key } };
  }

  async release(input: Parameters<WorkspacePersistencePort["release"]>[0]): Promise<void> {
    this.active.delete(input.binding.bindingId);
  }
}

export interface NodeManagedWorkspaceCheckpointsDependencies {
  sql: SqlClient;
  blobs: BlobStore;
  /** A target between safe turn barriers, not a guaranteed RPO. */
  intervalMs: number;
  nowMs?: () => number;
}

/** Session-scoped canonical pointer; publication is serialized against the SQL
 * Session Execution row, not a separate in-memory check of lease ownership. */
export class NodeManagedWorkspaceCheckpoints {
  private readonly nowMs: () => number;

  constructor(private readonly deps: NodeManagedWorkspaceCheckpointsDependencies) {
    if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs <= 0) {
      throw new RangeError("Workspace checkpoint interval must be a positive integer");
    }
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async ensureSchema(): Promise<void> {
    await this.deps.sql.exec(`CREATE TABLE IF NOT EXISTS managed_session_workspace_checkpoints (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
      candidate_id VARCHAR(191), candidate_json TEXT,
      published_at_ms BIGINT, revision BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, session_id)
    )`);
  }

  port(sandbox: SandboxExecutor): WorkspacePersistencePort {
    return new NodeBlobWorkspacePort(sandbox, this.deps.blobs);
  }

  runtimeFence(fence: SessionExecutionFence, environmentId: string): RuntimeResourceFence {
    return {
      workspaceId: fence.workspaceId, environmentId, sessionId: fence.sessionId,
      workId: fence.executionId, ownerId: fence.ownerId, generation: fence.generation,
      token: fence.attemptId, expiresAt: fence.expiresAt,
    };
  }

  async active(scope: Pick<RuntimeResourceScope, "workspaceId" | "sessionId">): Promise<{
    candidate: WorkspaceCheckpointCandidate;
    publishedAtMs: number;
  } | null> {
    const row = await this.deps.sql.prepare(`SELECT candidate_json, published_at_ms
      FROM managed_session_workspace_checkpoints WHERE workspace_id = ? AND session_id = ?`)
      .bind(scope.workspaceId, scope.sessionId)
      .first<{ candidate_json: string | null; published_at_ms: number | string | null }>();
    if (row?.candidate_json == null) return null;
    const candidate = JSON.parse(row.candidate_json) as WorkspaceCheckpointCandidate;
    if (!candidate || typeof candidate.id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidate.contentHash)) {
      throw new Error("Canonical workspace checkpoint pointer is invalid");
    }
    archiveKey(candidate, { ...scope, environmentId: "", workId: "" });
    return { candidate, publishedAtMs: Number(row.published_at_ms) };
  }

  due(active: { publishedAtMs: number } | null): boolean {
    return active === null || this.nowMs() - active.publishedAtMs >= this.deps.intervalMs;
  }

  async publish(input: {
    fence: SessionExecutionFence;
    candidate: WorkspaceCheckpointCandidate;
    expectedId: string | null;
  }): Promise<boolean> {
    const { fence, candidate, expectedId } = input;
    const now = this.nowMs();
    archiveKey(candidate, { ...fence, environmentId: "", workId: fence.executionId });
    if (!/^sha256:[a-f0-9]{64}$/u.test(candidate.contentHash)) throw new Error("Invalid workspace checkpoint hash");
    const current = `workspace_id = ? AND id = ? AND session_id = ? AND state = 'running'
      AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?`;
    const args = [fence.workspaceId, fence.executionId, fence.sessionId, fence.attemptId, fence.ownerId, fence.generation, now];
    // batch() is an atomic transaction. Touching the execution row first
    // acquires its write lock, serializing publication with claim/settle.
    const results = await this.deps.sql.batch([
      this.deps.sql.prepare(`UPDATE managed_session_executions SET revision = revision + 1 WHERE ${current}`).bind(...args),
      this.deps.sql.prepare(`INSERT INTO managed_session_workspace_checkpoints
        (workspace_id, session_id, candidate_id, candidate_json, published_at_ms, revision)
        SELECT ?, ?, NULL, NULL, NULL, 0 WHERE EXISTS
          (SELECT 1 FROM managed_session_executions WHERE ${current})
        ON CONFLICT (workspace_id, session_id) DO NOTHING`)
        .bind(fence.workspaceId, fence.sessionId, ...args),
      this.deps.sql.prepare(`UPDATE managed_session_workspace_checkpoints
        SET candidate_id = ?, candidate_json = ?, published_at_ms = ?, revision = revision + 1
        WHERE workspace_id = ? AND session_id = ?
          AND ((? IS NULL AND candidate_id IS NULL) OR candidate_id = ?)
          AND EXISTS (SELECT 1 FROM managed_session_executions WHERE ${current})`)
        .bind(candidate.id, JSON.stringify(candidate), now,
          fence.workspaceId, fence.sessionId, expectedId, expectedId, ...args),
    ]);
    return results[2]?.meta.changes === 1;
  }
}
