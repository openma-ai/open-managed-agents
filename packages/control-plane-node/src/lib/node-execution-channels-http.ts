import { Hono } from "hono";
import { authenticateSandboxToken, type SandboxTokenStore } from "@open-managed-agents/sandbox-gateway";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { ModelCardService } from "@open-managed-agents/model-cards-store";

/** Separate pre-auth endpoint: accepts only the existing all-scope sandbox
 * token, never an admin/Work bearer. No issue/rotation or provider effects. */
export function nodeExecutionChannelsHttp(options: {
  tokens: SandboxTokenStore;
  sql: SqlClient;
  modelCards: Pick<ModelCardService, "findByModelId">;
  gatewayBaseUrl?: string;
}) {
  const route = new Hono();
  route.post("/:sessionId/execution-channels", async c => {
    const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const checked = await authenticateSandboxToken(options.tokens, { sessionId: c.req.param("sessionId"), token, channel: "api" });
    if (checked.type === "unavailable") return c.json({type:"failed",phase:"token_validation",code:"unavailable",message:"Execution channels authority unavailable"},503);
    if (checked.type !== "accepted") return c.json({type:"failed",phase:"token_validation",code:"token_rejected",message:"Current sandbox token required"},401);
    try {
      const gateway = new URL(options.gatewayBaseUrl ?? "");
      if (!["http:","https:"].includes(gateway.protocol) || gateway.origin !== options.gatewayBaseUrl || gateway.username || gateway.password) throw new Error();
    } catch { return c.json({type:"failed",phase:"configuration",code:"missing_configuration",message:"Execution channels origin unavailable"},503); }
    try {
      const session = await new SqlSessionSource(options.sql).find({workspaceId:checked.session.workspaceId,sessionId:checked.session.sessionId});
      if (!session || session.archivedAt !== null) return c.json({type:"failed",phase:"session_lookup",code:"session_not_found",message:"Execution Session unavailable"},404);
      const model = session.agent.model;
      const card = await options.modelCards.findByModelId({tenantId:checked.session.workspaceId,modelId:typeof model === "string" ? model : model.id});
      if (!card || card.archived_at || !card.provider?.trim() || !card.model?.trim()) return c.json({type:"failed",phase:"model_lookup",code:"model_unavailable",message:"Active workspace model required"},409);
      const capability = {gatewayBaseUrl:options.gatewayBaseUrl!,sessionsToken:token};
      return c.json({type:"ready",channels:{mcpProxy:capability,hostedInference:{...capability,model:{providerId:card.provider,baseUrl:card.base_url ?? null,wireModel:card.model,protocolEndpoints:resolveProtocolEndpointsFromModelCard({providerId:card.provider,baseUrl:card.base_url,wireModel:card.model,piConfig:card.pi_config ?? undefined})}}}});
    } catch { return c.json({type:"failed",phase:"session_lookup",code:"unavailable",message:"Execution channels authority unavailable"},503); }
  });
  return route;
}
