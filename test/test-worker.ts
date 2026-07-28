/**
 * Combined test worker: merges main worker routes + agent worker DO classes.
 * Only used in vitest — production has separate workers.
 */

// --- Main worker routes ---
import mainApp from "../apps/main/src/index";

// --- Agent worker DO + harness registration ---
import { registerHarness } from "../apps/agent/src/harness/registry";
import { DefaultHarness } from "../apps/agent/src/harness/default-loop";
registerHarness("default", () => new DefaultHarness());
registerHarness("multi-msg", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg1" }] });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg2" }] });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg3" }] });
  },
}));
registerHarness("thinking-harness", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.thinking" });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "after thinking" }] });
  },
}));
registerHarness("tool-harness", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.tool_use", id: "tc_1", name: "bash", input: { command: "ls" } });
    ctx.runtime.broadcast({ type: "agent.tool_result", tool_use_id: "tc_1", content: "exit=0\nfile1.txt" });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "found files" }] });
  },
}));
registerHarness("delayed-harness", () => ({
  async run(ctx) {
    await new Promise((r) => setTimeout(r, 200));
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "delayed response" }] });
  },
}));
registerHarness("partial-crash", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "before crash" }] });
    throw new Error("partial crash");
  },
}));
registerHarness("history-reader", () => ({
  async run(ctx) {
    const count = ctx.runtime.history.getMessages().length;
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `msgs=${count}` }],
    });
  },
}));
registerHarness("config-reader", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `system=${ctx.agent.system || "none"}` }],
    });
  },
}));
registerHarness("system-prompt-reader", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: ctx.systemPrompt }],
    });
  },
}));
registerHarness("usage-reporter", () => ({
  async run(ctx) {
    if (ctx.runtime.reportUsage) {
      await ctx.runtime.reportUsage(100, 50);
    }
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "usage reported" }],
    });
  },
}));
registerHarness("sh-noop", () => ({ async run() {} }));
registerHarness("crash-sh", () => ({
  async run() {
    throw new Error("sh crash");
  },
}));
registerHarness("echo-user-input", () => ({
  async run(ctx) {
    const text = ctx.userMessage.content[0].text;
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `echo: ${text}` }],
    });
  },
}));
registerHarness("exact-echo-sh", () => ({
  async run(ctx) {
    const text = ctx.userMessage.content[0]?.text || "";
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `echo: ${text}` }],
    });
  },
}));
registerHarness("content-reader-sh", () => ({
  async run(ctx) {
    const blocks = ctx.userMessage.content.length;
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `blocks=${blocks}` }],
    });
  },
}));
registerHarness("noop", () => ({ async run() {} }));
registerHarness("noop-test", () => ({ async run() {} }));
registerHarness("files-test", () => ({ async run() {} }));
registerHarness("cross-noop", () => ({ async run() {} }));
registerHarness("edge-noop", () => ({ async run() {} }));
registerHarness("parity-noop", () => ({ async run() {} }));
registerHarness("eval-test", () => ({
  async run(ctx) {
    const text = ctx.userMessage?.content?.[0]?.text || "";
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `eval-ack: ${text}` }],
    });
  },
}));
registerHarness("test", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "test response" }],
    });
  },
}));
registerHarness("echo-test", () => ({
  async run(ctx) {
    const text = ctx.userMessage?.content?.[0]?.text || "";
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `echo: ${text}` }],
    });
  },
}));
registerHarness("parity-echo", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "parity echo" }],
    });
  },
}));
registerHarness("cross-echo", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "cross-echo reply" }],
    });
  },
}));
registerHarness("outcome-test", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Here is the fibonacci script:\n\nfunction fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }" }],
    });
  },
}));
registerHarness("outcome-multi", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Step 1: Setting up REST API" }],
    });
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Step 2: Added GET /health endpoint returning JSON" }],
    });
  },
}));
registerHarness("trajectory-test", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({
      type: "agent.tool_use",
      id: "tu-test-1",
      name: "bash",
      input: { command: "echo hi" },
    });
    ctx.runtime.broadcast({
      type: "agent.tool_result",
      tool_use_id: "tu-test-1",
      content: "hi\nexit=0",
    });
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "hello from trajectory test" }],
    });
  },
}));
registerHarness("crash-v2", () => ({
  async run() {
    throw new Error("boom v2");
  },
}));

export { SessionDO } from "../apps/agent/src/runtime/session-do";
export { Sandbox } from "@cloudflare/sandbox";
export { RuntimeRoom } from "../apps/main/src/runtime-room";
export { outbound, outboundByHost } from "../apps/agent/src/outbound";

// --- Migration bootstrap ---
// Apply D1 schema migrations on first request. Necessary because miniflare's
// D1 starts empty and our routes (e.g. /v1/memory_stores) hit memory tables.
// Idempotent: every CREATE uses IF NOT EXISTS, drop is a no-op rerun.
//
// Mirrors what `wrangler d1 migrations apply` does in prod — applies the
// consolidated baseline SQL file. The original 20 historical files live in
// _archive/ for git-blame reference; this test path uses the same single
// 0000_consolidated.sql self-host deploys ship with, plus any post-
// consolidation files added on top (0018_runtime_multi_tenant.sql is the
// first such — see multi-tenant CLI bridge daemon PR).

// @ts-expect-error vitest resolves SQL via ?raw
import authSchema from "../apps/main/migrations/0000_consolidated.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0017 from "../apps/main/migrations/0017_dreams.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0018 from "../apps/main/migrations/0018_runtime_multi_tenant.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import integrationsSchema from "../apps/main/migrations-integrations/0001_consolidated.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import routerSchema from "../apps/main/migrations-router/0001_consolidated.sql?raw";

const MIGRATIONS_RAW: string[] = [
  authSchema as string,
  schema0017 as string,
  schema0018 as string,
];

const INTEGRATIONS_MIGRATIONS_RAW: string[] = [integrationsSchema as string];

const ROUTER_MIGRATIONS_RAW: string[] = [routerSchema as string];

let migrationsApplied = false;
async function ensureMigrations(env: {
  MAIN_DB?: D1Database;
  AUTH_DB?: D1Database;
  INTEGRATIONS_DB?: D1Database;
  ROUTER_DB?: D1Database;
}): Promise<void> {
  env.MAIN_DB ??= env.AUTH_DB;
  if (migrationsApplied || !env.AUTH_DB) return;
  await applyMigrations(env.AUTH_DB, MIGRATIONS_RAW, "auth");
  if (env.MAIN_DB) {
    await applyMigrations(env.MAIN_DB, MIGRATIONS_RAW, "main");
  }
  if (env.INTEGRATIONS_DB) {
    await applyMigrations(env.INTEGRATIONS_DB, INTEGRATIONS_MIGRATIONS_RAW, "integrations");
  }
  const routerDb = env.ROUTER_DB ?? env.MAIN_DB ?? env.AUTH_DB;
  await applyMigrations(routerDb, ROUTER_MIGRATIONS_RAW, "router");
  await routerDb
    .prepare(
      `INSERT OR IGNORE INTO shard_pool (binding_name, status, notes)
       VALUES ('MAIN_DB', 'open', 'vitest default shard')`,
    )
    .run();
  migrationsApplied = true;
}

async function applyMigrations(
  db: D1Database,
  files: string[],
  label: string,
): Promise<void> {
  for (const sql of files) {
    // Strip line-comments so they don't break statement boundaries, then split
    // on `;`. Run each statement individually via prepare().run() — D1.exec()
    // splits on newlines and breaks multi-line CREATE TABLE.
    const stripped = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        await db.prepare(stmt).run();
      } catch (e) {
        // Some migration files contain ALTER TABLE DROP COLUMN that may fail
        // on re-run after IF NOT EXISTS makes them no-ops elsewhere — tolerate
        // benign errors but log to surface real schema issues during dev.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such column|duplicate column|already exists/i.test(msg)) {
          console.error(`[test-migrations:${label}] failed: ${msg}\n  SQL: ${stmt.slice(0, 80)}...`);
        }
      }
    }
  }
}

export default {
  async fetch(req: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    await ensureMigrations(env);
    return mainApp.fetch(req, env, ctx);
  },
};
