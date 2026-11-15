import { Hono } from "hono";

type WorkClaim = { workspaceId: string; environmentId: string; sessionId: string; workId: string; generation: number };

/** Pre-auth private protocol. Authentication opens only the sealed Work
 * envelope; persistence decides current ownership or exact committed replay.
 * It must never be reused as the ordinary Session bearer authentication. */
export function buildWorkStartupFailureRoutes(dependencies: {
  authenticate(token: string, path: string): Promise<WorkClaim | null>;
  persistenceFor(claim: WorkClaim): Promise<{
    captureStartupBoundary(claim: WorkClaim): Promise<number | null>;
    settleStartupFailure(input: { claim: WorkClaim; revision: number; processedAt: string; reason?: "model_unavailable" | "anthropic_protocol_required" | "preparation_failed" }): Promise<"committed" | "rejected">;
  }>;
}) {
  const routes = new Hono();
  for (const action of ["startup-boundary", "startup-failed"] as const) {
    routes.post("/:sessionId/" + action, async c => {
      const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
      try {
        const claim = await dependencies.authenticate(token, "/v1/oma/sessions/" + encodeURIComponent(c.req.param("sessionId") ?? "") + "/" + action);
        if (claim === null || claim.sessionId !== c.req.param("sessionId")) return c.json({error:"Work credential required"},401);
        const persistence = await dependencies.persistenceFor(claim);
        if (action === "startup-boundary") {
          const revision = await persistence.captureStartupBoundary(claim);
          return revision === null ? c.json({error:"Startup boundary unavailable"},409) : c.json({revision});
        }
        let body: unknown;
        try { body = await c.req.json(); } catch { return c.json({error:"Invalid JSON"},400); }
        if (body === null || typeof body !== "object" || Array.isArray(body)) return c.json({error:"Invalid outcome"},400);
        const value = body as Record<string, unknown>;
        if (Object.keys(value).some(key => key !== "revision" && key !== "processedAt" && key !== "reason") ||
          (value.reason !== undefined && (typeof value.reason !== "string" || !["model_unavailable","anthropic_protocol_required","preparation_failed"].includes(value.reason))) ||
          !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
          typeof value.processedAt !== "string" || !Number.isFinite(Date.parse(value.processedAt))) return c.json({error:"Invalid outcome"},400);
        const result = await persistence.settleStartupFailure({claim,revision:Number(value.revision),processedAt:value.processedAt,...(value.reason === undefined ? {} : {reason:value.reason as "model_unavailable" | "anthropic_protocol_required" | "preparation_failed"})});
        return result === "committed" ? c.json({type:"committed"}) : c.json({type:"rejected"},409);
      } catch { return c.json({error:"Startup settlement unavailable"},503); }
    });
  }
  return routes;
}
