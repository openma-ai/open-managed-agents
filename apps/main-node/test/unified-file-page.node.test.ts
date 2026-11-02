import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileService, SqlFileRepo } from "@open-managed-agents/files-store";
import { createFsSessionOutputSource } from "../../../packages/control-plane-node/src/lib/fs-session-output-source";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";
import type { UnifiedPageHarness } from "../../../packages/files-store/src/unified-page.harness";
import { registerUnifiedFilePageScenarios } from "../../../packages/files-store/src/unified-page.scenarios";

let database: TestDb;
let outputsRoot: string;

beforeAll(async () => {
  database = await bootstrapTestDb();
  outputsRoot = mkdtempSync(join(tmpdir(), "oma-unified-outputs-"));
});

afterAll(() => {
  database?.cleanup();
  if (outputsRoot) rmSync(outputsRoot, { recursive: true, force: true });
});

describe("unified session file page (Node sqlite + filesystem)", () => {
  registerUnifiedFilePageScenarios(() => Promise.resolve(createNodeHarness()), {
    bulkOutputCount: 1001,
  });

  it("keeps FileRepo.list before_id lexicographic while the session keyset is not", async () => {
    const repo = new SqlFileRepo(database.db);
    const tenantId = `tenant_${crypto.randomUUID()}`;
    const sessionId = `sess_${crypto.randomUUID()}`;
    const newerId = `compat-id-a-${sessionId}`;
    const olderId = `compat-id-b-${sessionId}`;
    await database.sql.prepare(`DELETE FROM files WHERE id = ?`).bind(newerId).run();
    await database.sql.prepare(`DELETE FROM files WHERE id = ?`).bind(olderId).run();
    await repo.insert({
      id: newerId,
      tenantId,
      sessionId,
      scope: "session",
      filename: "newer.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      downloadable: true,
      r2Key: `t/${tenantId}/files/${newerId}`,
      createdAt: 3_000,
    });
    await repo.insert({
      id: olderId,
      tenantId,
      sessionId,
      scope: "session",
      filename: "older.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      downloadable: true,
      r2Key: `t/${tenantId}/files/${olderId}`,
      createdAt: 1_000,
    });

    const lexicographic = await repo.list(tenantId, {
      sessionId,
      beforeId: newerId,
      order: "desc",
      limit: 10,
    });
    expect(lexicographic.map((row) => row.id)).toEqual([]);

    const keyset = await repo.listKeyset(tenantId, {
      sessionId,
      order: "desc",
      limit: 10,
      after: { createdAtMs: 3_000, id: newerId },
    });
    expect(keyset.map((row) => row.id)).toEqual([olderId]);
  });
});

function createNodeHarness(): UnifiedPageHarness {
  const tenantId = `tenant_${crypto.randomUUID()}`;
  const sessionId = `sess_${crypto.randomUUID()}`;
  const otherTenantId = `tenant_${crypto.randomUUID()}`;
  const otherSessionId = `sess_${crypto.randomUUID()}`;
  const repo = new SqlFileRepo(database.db);
  const service = new FileService({ repo });
  const outputs = createFsSessionOutputSource(outputsRoot);
  return {
    tenantId,
    sessionId,
    otherTenantId,
    otherSessionId,
    async insertFile(input) {
      const owner = input.tenantId ?? tenantId;
      const session = input.sessionId ?? sessionId;
      await database.sql.prepare(`DELETE FROM files WHERE id = ?`).bind(input.id).run();
      await repo.insert({
        id: input.id,
        tenantId: owner,
        sessionId: session,
        scope: "session",
        filename: input.filename ?? `${input.id}.txt`,
        mediaType: "text/plain",
        sizeBytes: 1,
        downloadable: true,
        r2Key: `t/${owner}/files/${input.id}`,
        createdAt: input.createdAtMs,
      });
    },
    async insertOutput(input) {
      const owner = input.tenantId ?? tenantId;
      const session = input.sessionId ?? sessionId;
      const dir = join(outputsRoot, owner, session);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, input.filename), input.bytes ?? "x");
    },
    async deleteFile(id) {
      await repo.delete(tenantId, id);
    },
    async deleteOutput(filename, session) {
      unlinkSync(join(outputsRoot, tenantId, session ?? sessionId, filename));
    },
    list(input) {
      return service.listUnifiedPage({
        tenantId: input.tenantId ?? tenantId,
        scopeId: input.scopeId ?? sessionId,
        outputs,
        limit: input.limit,
        order: input.order,
        cursor: input.cursor,
        beforeId: input.beforeId,
        afterId: input.afterId,
      });
    },
  };
}
