import { Hono, type Context } from "hono";
import type { CredentialEgressRelay } from "@open-managed-agents/managed-credential-resolver";

/** Mount identically at /v1/oma/egress on every platform, before ambient auth. */
export function buildCredentialEgressRoutes(relay: (context: Context) => CredentialEgressRelay | Promise<CredentialEgressRelay>) {
  const app = new Hono();
  for (const action of ["resolve", "forward"] as const) app.post(`/${action}`, async context => {
    try {
      const response = await (await relay(context)).handle(action, context.req.raw);
      if (action !== "forward" || context.req.header("x-oma-egress-method") !== "HEAD") return response;
      // The transport request is POST, not HEAD: a representation length here
      // would promise bytes that do not exist. Keep it as relay-only metadata
      // and let the sandbox restore it on the actual HEAD response.
      const headers = new Headers(response.headers);
      const length = headers.get("content-length");
      if (length !== null) headers.set("x-oma-egress-head-content-length", length);
      headers.delete("content-length");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    catch { return new Response("Credential relay unavailable", { status: 502 }); }
  });
  return app;
}
