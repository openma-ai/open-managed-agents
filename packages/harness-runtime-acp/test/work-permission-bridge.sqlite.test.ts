import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "../../sql-client/src/adapters/better-sqlite3.js";
import { SqlSessionEventStore } from "../../session-event-store-sql/src/index.js";
import { sessionExecutionCoordinatorSqlSchema } from "../../session-runtime-sql/src/coordination.js";
import { SessionEventsApplicationService } from "../../managed-agents-application/src/session-events/application.js";
import { WorkInputsApplication } from "../../managed-agents-application/src/session-execution/work-inputs.js";
import { SqlWorkInputs } from "../../managed-agents-adapters-sql/src/work-inputs.js";
import { workStorageContext } from "../../../apps/main-node/test/work-storage-fixture.js";
import type { Session } from "../../managed-agents-application/src/domain/session.js";
import { createWorkPermissionBridge } from "../src/work-permission-bridge.js";

// Real acceptance application -> canonical SQL writer -> private Work read/CAS.
// No copied confirmation document or mocked consume; transport/provider are not
// part of this test. The existing JSON-RPC tests cover the common callback wire.
async function fixture(outbox: boolean, selfHosted = false) {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(`
    CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER,revision INTEGER,document TEXT,status TEXT,updated_at INTEGER,PRIMARY KEY(workspace_id,id));
    CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,PRIMARY KEY(workspace_id,id));
    CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
    CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));
  `);
  await sql.exec(sessionExecutionCoordinatorSqlSchema);
  const migration = await readFile(new URL("../../../apps/main-node/migrations-sqlite/0034_work_inputs.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) await sql.prepare(statement).run();
  const context = workStorageContext();
  const scope = { workspaceId: "ws", sessionId: "sess", environmentId: "env", workId: "work", generation: 2, holder: "worker" };
  await sql.prepare("INSERT INTO managed_sessions VALUES ('ws','sess','env',NULL,1,?,'running',0)").bind(JSON.stringify(context.session)).run();
  await sql.prepare("INSERT INTO managed_environment_work VALUES ('ws','env','work','sess','active',2,'worker',?,90)").bind(Date.now()).run();
  const store = new SqlSessionEventStore(sql, { executionOutbox: outbox });
  const find = async () => {
    const row = await sql.prepare("SELECT document,revision FROM managed_sessions WHERE id='sess'").first<{ document: string; revision: number }>();
    return { session: JSON.parse(row!.document) as Session, revision: row!.revision };
  };
  let answerId = 0;
  const writer = new SessionEventsApplicationService({
    workspaceId: scope.workspaceId, store,
    sessions: { find: async () => (await find()).session },
    execution: { find: async () => ({ ...await find(), environment: selfHosted ? { ...context.environment, config: { type: "self_hosted" as const } } : context.environment }) },
    stream: { subscribe: () => (async function* () {})() },
    dispatch: { sessionEventsAccepted: async () => {} },
    clock: { now: () => new Date() },
    ids: { nextEventId: () => `answer-${++answerId}`, nextOutcomeId: () => "unused" },
  });
  const inputs = new WorkInputsApplication(new SqlWorkInputs(sql, { sourcePositionsValidated: true }));
  const order: string[] = [];
  let eventId = 0;
  let onPublished!: () => void;
  const published = new Promise<void>(resolve => { onPublished = resolve; });
  const bridge = createWorkPermissionBridge({
    scope, turnId: "original-acp-prompt", acpSessionId: "native-session",
    signal: new AbortController().signal, nextEventId: () => `permission-${++eventId}`, now: () => new Date(),
    consume: async ({ signal, ...input }) => {
      signal.throwIfAborted();
      const result = await inputs.consume({ ...input, claim: scope, boundary: "before_dispatch" });
      if (result.type !== "consumed") throw new Error(`CAS ${result.type}`);
      order.push(`consumed:${result.turnId}`);
    },
    publish: async ({ events, signal }) => {
      signal.throwIfAborted();
      // Real SQL event writer for output ordering evidence, not the production
      // HTTP projection/fence adapter. Field conversion is explicit at this port.
      const current = await find();
      const persisted = events.map(({ processed_at, stop_reason, evaluated_permission, ...rest }) => ({
        ...rest, processedAt: processed_at,
        ...(evaluated_permission ? { evaluatedPermission: evaluated_permission } : {}),
        ...(stop_reason ? { stopReason: { type: "requires_action", eventIds: (stop_reason as { event_ids: string[] }).event_ids } } : {}),
      }));
      const outputStore = new SqlSessionEventStore(sql);
      const result = await outputStore.append({ workspaceId: "ws", sessionId: "sess", expectedRevision: current.revision,
        events: persisted as never, nextSession: { ...current.session, updatedAt: new Date().toISOString() } });
      if (result.type !== "appended") throw new Error("output append failed");
      order.push(events.at(-1)!.type);
      onPublished();
    },
  });
  const response = bridge.requestPermission({ sessionId: "native-session", toolCall: { toolCallId: "native-tool", title: "Execute" }, options: [
    { optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "deny", kind: "reject_once", name: "Deny" },
  ] }).then(result => { order.push(`callback:${result.outcome.outcome}`); return result; });
  // Wait on actual persistence, not arbitrary timing.
  await published;
  const acceptance = await writer.sendSessionEvents({ sessionId: "sess", events: [
    // A legitimate outbox batch gives answer-2 execution_id=answer-1, proving
    // execution identity need not equal either the input id or original prompt.
    ...(outbox ? [{ type: "user.tool_confirmation" as const, toolUseId: "another-pending-tool", result: "deny" as const }] : []),
    { type: "user.tool_confirmation", toolUseId: bridge.toolUseIdFor("native-tool")!, result: "allow" },
  ] });
  expect(acceptance.type).toBe("accepted");
  const id = outbox ? "answer-2" : "answer-1";
  const page = await inputs.read({ claim: scope, cursor: null, limit: 100 });
  if (page.type !== "page") throw new Error(`read ${page.type}`);
  const document = page.rows.find(row => (row.event as { id: string }).id === id)!.document;
  const saved = async () => (await sql.prepare("SELECT document,processed_at FROM managed_session_events WHERE id=?").bind(id).first<{document:string;processed_at:number}>())!;
  return { sql, scope, bridge, response, inputs, order, document, saved, id };
}

it.each([false, true])("consumes writer-produced confirmation (outbox=%s) before status and original callback", async outbox => {
  const f = await fixture(outbox);
  try {
    const raw = JSON.parse(f.document);
    expect(raw.processedAt).toBeNull(); // Actual managed-cloud writer, not fixture assumption.
    expect((await f.saved()).processed_at).toBeGreaterThan(0); // SQL ordering time is not dispatch time.
    expect(raw.source_position.execution_id).toBe(outbox ? "answer-1" : undefined);
    // The old bridge's original-prompt identity is explicitly rejected by the
    // unchanged server, without consuming or stamping the canonical input.
    expect(await f.inputs.consume({ claim: f.scope, inputId: f.id, turnId: "original-acp-prompt", expectedDocument: f.document, boundary: "before_dispatch" })).toEqual({ type: "rejected" });
    expect((await f.saved()).document).toBe(f.document);
    expect(await f.bridge.confirm({ scope: f.scope, document: f.document })).toBe("answered");
    expect(await f.response).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(f.order.slice(-3)).toEqual(["consumed:answer-1", "session.status_running", "callback:selected"]);
    const consumed = JSON.parse((await f.saved()).document);
    expect(consumed.source_position.consumed_by_execution_id).toBe("answer-1");
    expect(Number.isFinite(Date.parse(consumed.processedAt))).toBe(true);
    expect(consumed.toolUseId).toBe(raw.toolUseId);
  } finally { f.bridge.close(); await f.response; }
});

it.each(["execution", "bytes", "already-consumed", "stamped"]) ("rejects %s without status-running or approval through real CAS", async mode => {
  const f = await fixture(false);
  try {
    let document = f.document;
    if (mode === "execution") document = JSON.stringify({ ...JSON.parse(document), source_position: { ...JSON.parse(document).source_position, execution_id: "forged" } });
    if (mode === "bytes") document += " ";
    if (mode === "already-consumed" || mode === "stamped") {
      expect(await f.inputs.consume({ claim: f.scope, inputId: f.id, turnId: f.id, expectedDocument: document, boundary: "before_dispatch" })).toMatchObject({ type: "consumed" });
      if (mode === "stamped") document = (await f.saved()).document;
    }
    const before = await f.saved();
    expect(await f.bridge.confirm({ scope: f.scope, document })).toBe("rejected");
    f.bridge.close();
    expect(await f.response).toEqual({ outcome: { outcome: "cancelled" } });
    expect(await f.saved()).toEqual(before);
    expect(f.order).not.toContain("session.status_running");
  } finally { f.bridge.close(); await f.response; }
});

it("keeps self_hosted stamped acceptance fail-closed rather than broadening the SQL contract", async () => {
  const f = await fixture(false, true);
  try {
    expect(Number.isFinite(Date.parse(JSON.parse(f.document).processedAt))).toBe(true);
    expect(await f.bridge.confirm({ scope: f.scope, document: f.document })).toBe("rejected");
    expect(await f.inputs.consume({ claim: f.scope, inputId: f.id, turnId: f.id, expectedDocument: f.document, boundary: "before_dispatch" })).toEqual({ type: "rejected" });
  } finally { f.bridge.close(); await f.response; }
});


it("rejects a revoked Work holder in real SQL without publishing resumed status", async () => {
  const f = await fixture(false);
  try {
    await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='replacement'").run();
    expect(await f.bridge.confirm({ scope: f.scope, document: f.document })).toBe("rejected");
    expect(await f.response).toEqual({ outcome: { outcome: "cancelled" } });
    expect((await f.saved()).document).toBe(f.document);
    expect(f.order).not.toContain("session.status_running");
  } finally { f.bridge.close(); await f.response; }
});
