import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { guessSessionOutputMime } from "@open-managed-agents/shared";

const PREFIX = "managed-session-outputs";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_OUTPUT_FILE_BYTES = 256 * 1024 * 1024;

type Entry = { path: string; size: number };
type Manifest = { version: 1; files: Entry[]; uploadedAt: string };

function assertId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) throw new Error("Unsafe Session outputs scope");
}
function assertPath(value: string): void {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Unsafe Session output path");
  }
}
function prefix(workspaceId: string, sessionId: string): string {
  assertId(workspaceId);
  assertId(sessionId);
  return `${PREFIX}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}/`;
}
function candidateKey(root: string, id: string, path: string): string {
  assertPath(path);
  if (!/^out_[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid Session output candidate");
  return `${root}${id}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
async function boundedJson(blob: { body: ReadableStream<Uint8Array>; size: number }): Promise<Manifest> {
  if (blob.size > MAX_MANIFEST_BYTES) throw new Error("Session output manifest is too large");
  const reader = blob.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MANIFEST_BYTES) {
        await reader.cancel("Session output manifest is too large");
        throw new Error("Session output manifest is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Manifest;
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10_000 ||
    typeof manifest.uploadedAt !== "string") throw new Error("Invalid Session output manifest");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid Session output manifest entry");
    assertPath(file.path);
    if (seen.has(file.path)) throw new Error("Duplicate Session output manifest entry");
    seen.add(file.path);
  }
  return manifest;
}

/** Immutable output candidates in a shared blob backend, with one fenced SQL
 * pointer per Session. It is intentionally separate from workspace snapshots. */
export class NodeSharedSessionOutputs {
  /** Canonical candidate each live sandbox (runtime generation) was hydrated
   * from. Publication CASes against it, so a warm sandbox that missed another
   * replica's newer outputs can never replace them with its older full set. */
  private readonly bases = new Map<string, string | null>();

  constructor(private readonly deps: { sql: SqlClient; blobs: BlobStore }) {}

  private baseKey(workspaceId: string, sessionId: string, runtimeGeneration: string): string {
    return `${workspaceId}\0${sessionId}\0${runtimeGeneration}`;
  }

  /** False when another owner published since this sandbox was hydrated. */
  async isSandboxCurrent(workspaceId: string, sessionId: string, runtimeGeneration: string): Promise<boolean> {
    const key = this.baseKey(workspaceId, sessionId, runtimeGeneration);
    if (!this.bases.has(key)) return false;
    if (await this.pointer(workspaceId, sessionId) === this.bases.get(key)) return true;
    this.bases.delete(key);
    return false;
  }

  async ensureSchema(dialect?: "mysql" | "sqlite" | "postgres"): Promise<void> {
    // Node's consolidated MySQL execution schema uses utf8mb4_unicode_ci;
    // the database default can be 0900_ai_ci, which breaks cross-table joins.
    const mysqlSuffix = dialect === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci" : "";
    await this.deps.sql.exec(`CREATE TABLE IF NOT EXISTS managed_session_output_snapshots (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
      candidate_id VARCHAR(191) NOT NULL, published_at_ms BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, session_id)
    )${mysqlSuffix}`);
    // Record paths *before* PUT. An interrupted upload still leaves a durable
    // inventory for the eventual sweep, rather than untraceable S3 objects.
    await this.deps.sql.exec(`CREATE TABLE IF NOT EXISTS managed_session_output_candidates (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
      candidate_id VARCHAR(191) NOT NULL, execution_id VARCHAR(191) NOT NULL,
      attempt_id VARCHAR(191) NOT NULL, owner_id VARCHAR(191) NOT NULL,
      generation BIGINT NOT NULL, status VARCHAR(16) NOT NULL,
      file_paths_json ${dialect === "mysql" ? "MEDIUMTEXT" : "TEXT"} NOT NULL, updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, session_id, candidate_id)
    )${mysqlSuffix}`);
  }

  private async pointer(workspaceId: string, sessionId: string): Promise<string | null> {
    prefix(workspaceId, sessionId);
    const row = await this.deps.sql.prepare(`SELECT candidate_id FROM managed_session_output_snapshots
      WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId)
      .first<{ candidate_id: string }>();
    return row?.candidate_id ?? null;
  }

  private async manifest(workspaceId: string, sessionId: string): Promise<{ id: string; manifest: Manifest } | null> {
    const id = await this.pointer(workspaceId, sessionId);
    if (id === null) return null;
    const root = prefix(workspaceId, sessionId);
    const key = candidateKey(root, id, "manifest.json");
    const object = await this.deps.blobs.get(key);
    if (object === null) throw new Error("Canonical Session output manifest is missing");
    return { id, manifest: await boundedJson(object) };
  }

  async publish(input: {
    workspaceId: string; sessionId: string; fence: SessionExecutionFence;
    files: AsyncIterable<readonly [string, Uint8Array]> | Iterable<readonly [string, Uint8Array]>;
    /** The sandbox whose outputs are published; its hydration base is the CAS value. */
    runtimeGeneration?: string;
  }): Promise<void> {
    const { workspaceId, sessionId, fence, files } = input;
    const baseKey = input.runtimeGeneration === undefined ? null
      : this.baseKey(workspaceId, sessionId, input.runtimeGeneration);
    if (baseKey !== null && !this.bases.has(baseKey)) {
      throw new Error("Session output sandbox was not hydrated from a canonical version");
    }
    const root = prefix(workspaceId, sessionId);
    if (fence.workspaceId !== workspaceId || fence.sessionId !== sessionId) throw new Error("Session output fence scope mismatch");
    const id = `out_${randomUUID()}`;
    const uploadedAt = new Date().toISOString();
    await this.deps.sql.prepare(`INSERT INTO managed_session_output_candidates
      (workspace_id, session_id, candidate_id, execution_id, attempt_id, owner_id,
        generation, status, file_paths_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'building', '[]', ?)`)
      .bind(workspaceId, sessionId, id, fence.executionId, fence.attemptId, fence.ownerId,
        fence.generation, Date.now()).run();
    const entries: Entry[] = [];
    const seen = new Set<string>();
    try {
      for await (const [path, bytes] of files) {
        const key = candidateKey(root, id, path);
        if (path === "manifest.json") throw new Error("Reserved Session output filename");
        if (seen.has(path) || entries.length >= 10_000) throw new Error("Invalid Session output candidate inventory");
        seen.add(path);
        entries.push({ path, size: bytes.byteLength });
        const paths = JSON.stringify(entries.map((entry) => entry.path));
        if (Buffer.byteLength(paths) > MAX_MANIFEST_BYTES) throw new Error("Session output manifest is too large");
        // Persist the key before the PUT: process death after the PUT is recoverable.
        const recorded = await this.deps.sql.prepare(`UPDATE managed_session_output_candidates SET file_paths_json = ?, updated_at_ms = ?
          WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status = 'building'`)
          .bind(paths, Date.now(), workspaceId, sessionId, id).run();
        if (recorded.meta.changes !== 1) throw new Error("Session output candidate was retired during upload");
        const written = await this.deps.blobs.put(key, bytes, {
          precondition: { type: "ifNoneMatch", value: "*" },
          httpMetadata: { contentType: guessSessionOutputMime(path) },
        });
        if (written === null) throw new Error("Session output candidate already exists");
      }
      const manifest: Manifest = { version: 1, files: entries, uploadedAt };
      const encoded = JSON.stringify(manifest);
      if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) throw new Error("Session output manifest is too large");
      const written = await this.deps.blobs.put(candidateKey(root, id, "manifest.json"), encoded, {
        precondition: { type: "ifNoneMatch", value: "*" }, httpMetadata: { contentType: "application/json" },
      });
      if (written === null) throw new Error("Session output manifest already exists");
      const expected = baseKey === null ? await this.pointer(workspaceId, sessionId) : this.bases.get(baseKey)!;
      const now = Date.now();
      const where = `workspace_id = ? AND id = ? AND session_id = ? AND state = 'running'
        AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?`;
      const args = [workspaceId, fence.executionId, sessionId, fence.attemptId, fence.ownerId, fence.generation, now];
      // Claim this candidate row in the same transaction as the fenced pointer
      // CAS. A concurrent sweeper can mark it purging only before or after the
      // transaction, never between these statements.
      const publishing = `EXISTS (SELECT 1 FROM managed_session_output_candidates
        WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status = 'publishing')`;
      const candidateArgs = [workspaceId, sessionId, id];
      const results = await this.deps.sql.batch([
        this.deps.sql.prepare(`UPDATE managed_session_output_candidates SET status = 'publishing'
          WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status = 'building'
          AND EXISTS (SELECT 1 FROM managed_session_executions WHERE ${where})`)
          .bind(...candidateArgs, ...args),
        this.deps.sql.prepare(`UPDATE managed_session_executions SET revision = revision + 1 WHERE ${where}`).bind(...args),
        this.deps.sql.prepare(`INSERT INTO managed_session_output_snapshots
          (workspace_id, session_id, candidate_id, published_at_ms)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM managed_session_executions WHERE ${where})
            AND ${publishing}
          ON CONFLICT (workspace_id, session_id) DO NOTHING`)
          .bind(workspaceId, sessionId, id, now, ...args, ...candidateArgs),
        this.deps.sql.prepare(`UPDATE managed_session_output_snapshots SET candidate_id = ?, published_at_ms = ?
          WHERE workspace_id = ? AND session_id = ? AND candidate_id = ?
          AND EXISTS (SELECT 1 FROM managed_session_executions WHERE ${where}) AND ${publishing}`)
          .bind(id, now, workspaceId, sessionId, expected, ...args, ...candidateArgs),
        this.deps.sql.prepare(`UPDATE managed_session_output_candidates SET status = 'published'
          WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status = 'publishing'
          AND EXISTS (SELECT 1 FROM managed_session_output_snapshots
            WHERE workspace_id = ? AND session_id = ? AND candidate_id = ?)`)
          .bind(...candidateArgs, ...candidateArgs),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 ||
        (expected === null ? results[2]?.meta.changes !== 1 : results[3]?.meta.changes !== 1) ||
        results[4]?.meta.changes !== 1) {
        throw new Error("Session output publication lost its execution fence or canonical pointer");
      }
      if (baseKey !== null) this.bases.set(baseKey, id);
    } catch (error) {
      // Never delete a blob that may have become canonical. The GC scheduler
      // reclaims failed candidates (also covering crashes during upload).
      await this.deps.sql.prepare(`UPDATE managed_session_output_candidates SET status = 'failed'
        WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status IN ('building', 'publishing')
        AND NOT EXISTS (SELECT 1 FROM managed_session_output_snapshots
          WHERE workspace_id = ? AND session_id = ? AND candidate_id = ?)`)
        .bind(workspaceId, sessionId, id, workspaceId, sessionId, id).run().catch(() => undefined);
      throw error;
    }
  }

  /** Hydrate ordinary outputs in a fresh sandbox before input staging. This is
   * not a live mount; read/write on a turn is published at its next safe point. */
  async restoreToSandbox(workspaceId: string, sessionId: string, sandbox: SandboxExecutor, runtimeGeneration?: string): Promise<void> {
    const current = await this.manifest(workspaceId, sessionId);
    const record = (base: string | null) => {
      if (runtimeGeneration !== undefined) this.bases.set(this.baseKey(workspaceId, sessionId, runtimeGeneration), base);
    };
    if (current === null) { record(null); return; }
    if (!sandbox.writeFileBytes) throw new Error("Shared Session outputs require binary sandbox writes for restore");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const entry of current.manifest.files) {
      if (entry.size > MAX_SESSION_OUTPUT_FILE_BYTES) throw new Error("Session output file exceeds restore size limit");
      const key = candidateKey(prefix(workspaceId, sessionId), current.id, entry.path);
      const metadata = await this.deps.blobs.head(key);
      if (metadata === null || metadata.size !== entry.size) throw new Error("Canonical Session output blob is missing or corrupt");
      const object = await this.deps.blobs.get(key);
      if (object === null || object.size !== entry.size) throw new Error("Canonical Session output blob is missing or corrupt");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== entry.size) throw new Error("Canonical Session output blob is corrupt");
      const dest = `/mnt/session/outputs/${entry.path}`;
      const created = await sandbox.exec(`mkdir -p ${quote(posix.dirname(dest))}`);
      if (created.includes("[exit ") || created.includes("[error: ")) throw new Error("Session output restore failed to create directory");
      await sandbox.writeFileBytes(dest, bytes);
    }
    if (await this.pointer(workspaceId, sessionId) !== current.id) {
      throw new Error("Canonical Session outputs changed during restore; reacquire the sandbox");
    }
    record(current.id);
  }

  async list(workspaceId: string, sessionId: string) {
    const current = await this.manifest(workspaceId, sessionId);
    if (current === null) return [];
    return current.manifest.files.filter((entry) => !entry.path.includes("/")).map((entry) => ({
      filename: entry.path, size_bytes: entry.size,
      uploaded_at: current.manifest.uploadedAt,
      media_type: guessSessionOutputMime(entry.path),
    }));
  }

  async read(workspaceId: string, sessionId: string, filename: string) {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("\0") || filename === "." || filename === "..") return null;
    const current = await this.manifest(workspaceId, sessionId);
    if (current === null) return null;
    const entry = current.manifest.files.find((item) => item.path === filename);
    if (!entry) return null;
    const object = await this.deps.blobs.get(candidateKey(prefix(workspaceId, sessionId), current.id, filename));
    if (object === null || object.size !== entry.size) throw new Error("Canonical Session output blob is missing or corrupt");
    return { body: object.body, size: entry.size, contentType: guessSessionOutputMime(filename) };
  }

  /** Idempotent bounded sweep; safe on multiple replicas and across crashes.
   * Canonical candidates and candidates with a live execution fence are kept. */
  async collectGarbage(options: { beforeMs?: number; limit?: number; putGraceMs?: number } = {}): Promise<number> {
    const now = Date.now();
    const before = options.beforeMs ?? now - 60 * 60 * 1000;
    // A PUT already in flight when its candidate is retired can land after
    // the first delete. Keep the tombstone and re-delete until this grace ends.
    const putGraceMs = options.putGraceMs ?? 60 * 60 * 1000;
    const limit = Math.min(100, Math.max(1, options.limit ?? 100));
    // Exclude canonical/live rows in the SELECT itself: otherwise more than
    // `limit` old canonical rows would starve every later sweep.
    const candidates = await this.deps.sql.prepare(`SELECT c.workspace_id, c.session_id, c.candidate_id,
        c.file_paths_json, c.status, c.updated_at_ms
      FROM managed_session_output_candidates c
      WHERE (c.status IN ('failed', 'purging') OR c.updated_at_ms < ?)
        AND NOT EXISTS (SELECT 1 FROM managed_session_output_snapshots s
          WHERE s.workspace_id = c.workspace_id AND s.session_id = c.session_id AND s.candidate_id = c.candidate_id)
        AND NOT EXISTS (SELECT 1 FROM managed_session_executions e
          WHERE e.workspace_id = c.workspace_id AND e.id = c.execution_id AND e.attempt_id = c.attempt_id
            AND e.owner_id = c.owner_id AND e.generation = c.generation AND e.state = 'running'
            AND e.lease_expires_at_ms > ? AND c.status IN ('building', 'publishing'))
      ORDER BY c.updated_at_ms ASC LIMIT ?`).bind(before, now, limit)
      .all<{ workspace_id: string; session_id: string; candidate_id: string; file_paths_json: string; status: string; updated_at_ms: number | string }>();
    let removed = 0;
    for (const row of candidates.results ?? []) {
      const values = [row.workspace_id, row.session_id, row.candidate_id];
      if (row.status !== "purging") {
        const claimed = await this.deps.sql.prepare(`UPDATE managed_session_output_candidates SET status = 'purging', updated_at_ms = ?
          WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status = ?
            AND (status = 'failed' OR updated_at_ms < ?)
            AND NOT EXISTS (SELECT 1 FROM managed_session_output_snapshots
              WHERE workspace_id = ? AND session_id = ? AND candidate_id = ?)
            AND NOT EXISTS (SELECT 1 FROM managed_session_executions
              WHERE workspace_id = ? AND id = managed_session_output_candidates.execution_id
                AND attempt_id = managed_session_output_candidates.attempt_id
                AND owner_id = managed_session_output_candidates.owner_id
                AND generation = managed_session_output_candidates.generation
                AND state = 'running' AND lease_expires_at_ms > ?
                AND managed_session_output_candidates.status IN ('building', 'publishing'))`)
          .bind(now, ...values, row.status, before, ...values, row.workspace_id, now).run();
        if (claimed.meta.changes !== 1) continue;
      }
      const paths = JSON.parse(row.file_paths_json) as string[];
      if (!Array.isArray(paths) || paths.length > 10_000) throw new Error("Invalid output candidate inventory");
      const root = prefix(row.workspace_id, row.session_id);
      for (const path of [...paths, "manifest.json"]) {
        await this.deps.blobs.delete(candidateKey(root, row.candidate_id, path));
      }
      removed++;
      const purgeStarted = row.status === "purging" ? Number(row.updated_at_ms) : now;
      if (now - purgeStarted < putGraceMs) continue;
      await this.deps.sql.prepare(`DELETE FROM managed_session_output_candidates
        WHERE workspace_id = ? AND session_id = ? AND candidate_id = ? AND status = 'purging'`)
        .bind(...values).run();
    }
    return removed;
  }

  async deleteAll(workspaceId: string, sessionId: string): Promise<void> {
    const current = await this.manifest(workspaceId, sessionId);
    if (current === null) return;
    // Readers can still hold the old manifest. Delay blob reclamation until
    // the GC grace interval rather than deleting objects underneath a reader.
    await this.deps.sql.prepare(`DELETE FROM managed_session_output_snapshots
      WHERE workspace_id = ? AND session_id = ? AND candidate_id = ?`)
      .bind(workspaceId, sessionId, current.id).run();
  }
}
