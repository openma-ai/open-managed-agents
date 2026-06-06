/**
 * Agent Worker — per-environment session runtime.
 *
 * Each environment gets its own agent worker with a custom container image.
 * This worker exports SessionDO + Sandbox and routes incoming requests
 * from the main worker to the appropriate SessionDO instance.
 *
 * If SESSION_DO is not bound (Cloudflare Free Tier), it falls back to
 * stateless mode.
 */

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

// --- Register harnesses ---
import { registerHarness } from "./harness/registry";
import { DefaultHarness } from "./harness/default-loop";
import { AcpProxyHarness } from "./harness/acp-proxy-loop";
registerHarness("default", () => new DefaultHarness());
registerHarness("acp-proxy", () => new AcpProxyHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "./runtime/session-do";
export { OmaSandbox as Sandbox } from "./oma-sandbox";

// --- Required by @cloudflare/sandbox 0.8.x outbound interception ---
export { ContainerProxy } from "@cloudflare/containers";

// --- Export outbound worker functions (legacy — see oma-sandbox.ts for the
// real handler wiring via @cloudflare/sandbox 0.8.x setOutboundHandler API). ---
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", version: "3", mode: c.env.SESSION_DO ? "stateful" : "stateless" }));

app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");

  if (c.env.SESSION_DO) {
    const doId = c.env.SESSION_DO.idFromName(sessionId);
    const doStub = c.env.SESSION_DO.get(doId);

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
  } else {
    // Stateless mode (Free Tier)
    const { statelessApp } = await import("./runtime/stateless");
    return statelessApp.fetch(c.req.raw, c.env, c.executionCtx);
  }
});

export default app;
