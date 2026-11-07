import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureSessionExecutionCoordinatorSchema } from "../src/coordination";
import { ensureSessionSandboxBindingSchema, SqlSessionSandboxBindingStore } from "../src/sandbox-binding";
import { sessionSandboxBindingConformance } from "./sandbox-binding-conformance";

sessionSandboxBindingConformance("SQLite", async run => {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  await ensureSessionSandboxBindingSchema(sql);
  await run(sql);
});

it("reopens persisted intents and real handles through a new database connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "oma-sandbox-binding-"));
  try {
    const path = join(root, "bindings.sqlite");
    const sql = await createBetterSqlite3SqlClient(path);
    await ensureSessionSandboxBindingSchema(sql);
    const original = new SqlSessionSandboxBindingStore(sql);
    const scope = { workspaceId: "workspace", sessionId: "session" };
    const created = await original.createIntent({ ...scope, allocationId: "allocation", provider: "provider",
      configFingerprint: "config", expectedBindingRevision: null, ownerId: "manager-a",
      now: "2026-11-05T00:00:00.000Z", leaseTtlMs: 30_000 });
    if (created.type !== "created") throw new Error("Expected creation");
    const allocated = await original.recordHandle({ fence: created.fence, expectedRevision: 1,
      now: "2026-11-05T00:00:01.000Z", handle: { provider: "provider", runtimeId: "provider-owned-real-id" } });
    expect(allocated.type).toBe("updated");
    const reopened = new SqlSessionSandboxBindingStore(await createBetterSqlite3SqlClient(path));
    expect((await reopened.getCurrent(scope))!.resource).toMatchObject({
      allocationId: "allocation", handle: { provider: "provider", runtimeId: "provider-owned-real-id" },
      observedState: "allocated", readiness: "created", revision: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
