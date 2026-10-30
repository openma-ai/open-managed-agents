import { Hono, type Context } from "hono";
import type { CredentialEgressRelay } from "@open-managed-agents/managed-credential-resolver";

/** Mount identically at /v1/oma/egress on every platform, before ambient auth. */
export function buildCredentialEgressRoutes(relay: (context: Context) => CredentialEgressRelay | Promise<CredentialEgressRelay>) {
  const app = new Hono();
  for (const action of ["resolve", "forward"] as const) app.post(`/${action}`, async context => {
    try { return await (await relay(context)).handle(action, context.req.raw); }
    catch { return new Response("Credential relay unavailable", { status: 502 }); }
  });
  return app;
}
