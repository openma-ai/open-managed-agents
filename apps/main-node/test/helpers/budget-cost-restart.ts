// Shared cross-dialect driver: session budget cost must survive a restart.
//
// Each "process" is a fresh DefaultNodeManagedSessionRunner that loads the
// Session from SQL, charges one metered model request through the real domain
// gate, and commits the produced frames through the real runtime decoder and
// SQL projection — the same path node-managed wires in production.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import { SessionRuntimeProjectionApplicationService } from "@open-managed-agents/managed-agents-application";
import { SqlSessionRuntimeProjectionPersistence, SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { recordModelEgress, type SessionBudgetGate } from "../../../../packages/managed-agents-domain/src/sessions/index.js";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { createSessionClockRegistry } from "@open-managed-agents/shared";
import { DefaultNodeManagedSessionRunner } from "../../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";

const WORKSPACE = "workspace_budget";
const SESSION = "session_budget";
const T = Date.UTC(2026, 10, 1);

const environment: Environment = {
  id: "env_1", archivedAt: null, config: { type: "self_hosted" }, createdAt: new Date(T).toISOString(),
  description: null, metadata: {}, name: "Node runtime", updatedAt: new Date(T).toISOString(),
};

async function insertSession(sql: SqlClient): Promise<void> {
  await sql.prepare("DELETE FROM managed_session_events WHERE session_id = ?").bind(SESSION).run();
  await sql.prepare("DELETE FROM managed_sessions WHERE id = ?").bind(SESSION).run();
  const document: Omit<Session, "id" | "createdAt" | "updatedAt" | "archivedAt"> = {
    agent: { id: "agent_1", description: null, mcpServers: [], model: { id: "deepseek-flash" }, multiagent: null, name: "Agent", skills: [], system: null, tools: [], version: 1 },
    budget: { amountMinor: "10000", currency: "USD" },
    environmentId: "env_1", metadata: {}, outcomeEvaluations: [], resources: [], stats: {},
    status: "idle", title: null, usage: {}, vaultIds: [],
  } as never;
  await sql.prepare(
    `INSERT INTO managed_sessions
      (id, workspace_id, document, revision, agent_id, agent_version,
       environment_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'agent_1', 1, 'env_1', 'idle', ?, ?)`,
  ).bind(SESSION, WORKSPACE, JSON.stringify(document), T, T).run();
}

/** One process: load Session from SQL, charge one 1M-input-token request at
 * $1/Mtok (100 cents), and commit the produced frames to SQL. */
async function chargeOnce(sql: SqlClient, turn: number): Promise<{ gateStart: string }> {
  const session = await new SqlSessionSource(sql).find({ workspaceId: WORKSPACE, sessionId: SESSION });
  if (session === null) throw new Error("session not found");
  const projection = new SessionRuntimeProjectionApplicationService({
    workspaceId: WORKSPACE,
    persistence: new SqlSessionRuntimeProjectionPersistence(sql),
  });
  let gateStart = "";
  let nextId = 0;
  const runner = new DefaultNodeManagedSessionRunner({
    sessionClocks: createSessionClockRegistry(),
    outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool"); } },
    buildSandbox: async () => ({}) as SandboxExecutor,
    buildModel: async () => ({}),
    buildTools: async () => ({}),
    resolveModelPricing: async () => ({ version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" }),
    buildHarness: () => ({
      run: async (context: { budget?: SessionBudgetGate | null }) => {
        gateStart = context.budget!.list_cost_pico;
        recordModelEgress(context.budget, { input_tokens: 1_000_000, output_tokens: 0 } as never);
      },
    }),
    buildHarnessContext: async (input: unknown) => input,
    clock: { now: () => new Date(T + turn * 60_000) },
    ids: { nextEventId: () => `sevt_budget_${turn}_${++nextId}` },
    runtimeGenerations: { next: () => `runtime_${turn}` },
  } as unknown as ConstructorParameters<typeof DefaultNodeManagedSessionRunner>[0]);
  const scope = { workspaceId: WORKSPACE, sessionId: SESSION };
  await runner.start({ ...scope, session, environment, initialEvents: [] });
  const input = { id: `sevt_input_${turn}`, type: "user.message" as const, content: [{ type: "text" as const, text: "charge" }], processedAt: new Date(T + turn * 60_000).toISOString() };
  await runner.accept({
    ...scope, session, environment, initialEvents: [], events: [input], historyEvents: [input],
    output: async (frame) => {
      const event = decodeRuntimeProducedSessionEvent(frame);
      if (event === null) return;
      const recorded = await projection.recordSessionRuntimeEvents({ sessionId: SESSION, events: [event] });
      if (recorded.type !== "recorded") throw new Error(`projection ${recorded.type}`);
    },
  });
  await runner.stop({ ...scope, reason: "deleted" } as never).catch(() => undefined);
  return { gateStart };
}

export interface BudgetRestartResult {
  gateStarts: string[];
  usage: Session["usage"];
}

/** Two charges in two processes against the same database. */
export async function runBudgetCostAcrossRestart(sql: SqlClient): Promise<BudgetRestartResult> {
  await insertSession(sql);
  const first = await chargeOnce(sql, 1);
  const second = await chargeOnce(sql, 2);
  const session = await new SqlSessionSource(sql).find({ workspaceId: WORKSPACE, sessionId: SESSION });
  return { gateStarts: [first.gateStart, second.gateStart], usage: session!.usage };
}

export const BUDGET_RESTART_EXPECTED: BudgetRestartResult = {
  // The second process resumes from the first charge instead of 0.
  gateStarts: ["0", "1000000000000"],
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    listCost: { amountMinor: "200", currency: "USD" },
    list_cost_pico: "2000000000000",
  } as Session["usage"],
};
