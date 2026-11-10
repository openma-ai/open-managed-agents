/**
 * Agent Worker — per-environment session runtime.
 *
 * Each environment gets its own agent worker with a custom container image.
 * This worker exports SessionDO + Sandbox and routes incoming requests
 * from the main worker to the appropriate SessionDO instance.
 */

import { Hono } from "hono";
import { configuredCfEnvironmentWorker } from "./runtime/cf-environment-worker";
import { CF_WORK_DISPATCH_PATH, dispatchCfWorkRunnerRequest } from "./runtime/cf-work-runner-entry";
import type { Env } from "@open-managed-agents/shared";

// --- Register harnesses ---
import {
  registerHarness, registerCoreHarnesses, AcpProxyHarness,
} from "@open-managed-agents/agent-harness";
import { reclaimCloudflareOrphanSandboxes, SANDBOX_ORPHAN_RECLAIM_PATH } from "./runtime/sandbox-orphan-reclaim";
registerCoreHarnesses();
registerHarness("acp-proxy", () => new AcpProxyHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "./runtime/session-do";
export { OmaSandbox as Sandbox, OmaOutbound } from "./oma-sandbox";
// Operator catalog images (SANDBOX_IMAGES): one container class per image.
export * from "./operator-sandboxes";

// Sandbox SDK 1.0 helpers — DirectoryBackup / S3Mount reach these via ctx.exports.
export { DirectoryBackupGateway, S3Gateway } from "@cloudflare/sandbox";

// Legacy no-op stubs kept for older imports / tests.
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", version: "2" }));
app.post(CF_WORK_DISPATCH_PATH, (c) => dispatchCfWorkRunnerRequest(c.req.raw, c.env));
app.post("/__internal/work/webhook", async (c) => {
  try {
    const worker = configuredCfEnvironmentWorker(c.env);
    const result = worker.handleWebhook({ body: await c.req.text(), headers: Object.fromEntries(c.req.raw.headers), waitUntil: promise => c.executionCtx.waitUntil(promise) });
    return c.json(result);
  } catch { return c.json({ error: "Work webhook rejected or unconfigured" }, 403); }
});

// The apps/main cron (service binding): drain the sandbox orphan queue.
app.post(SANDBOX_ORPHAN_RECLAIM_PATH, async (c) =>
  c.json(await reclaimCloudflareOrphanSandboxes(c.env, (message) => console.warn(`[sandbox-orphan-reclaim] ${message}`))));

// /__internal/prepare-env, /__internal/prep-tick, /__internal/prep-debug,
// and the buildInstallScript helper were removed when the per-env CI build
// (image_strategy=dockerfile) became the only build path. The lazy-prepare
// branch they fed (base_snapshot) was reverted; see apps/main/src/routes/
// environments.ts pickStrategy for the rationale.

app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");
  const workspaceId = c.req.header("x-oma-workspace-id")?.trim();
  const doId = c.env.SESSION_DO!.idFromName(
    workspaceId ? JSON.stringify([workspaceId, sessionId]) : sessionId,
  );
  const doStub = c.env.SESSION_DO!.get(doId);

  const url = new URL(c.req.url);
  const subPath = url.pathname.replace(`/sessions/${sessionId}`, "") || "/";
  const internalUrl = `http://internal${subPath}${url.search}`;

  return doStub.fetch(
    new Request(internalUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    })
  );
});

export default {
  fetch: app.fetch,
  // One bounded drain per platform tick; no custom heartbeat/timer lifecycle.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(configuredCfEnvironmentWorker(env).drain());
  },
};
