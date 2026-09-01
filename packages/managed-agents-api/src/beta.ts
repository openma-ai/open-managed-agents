import type { MiddlewareHandler } from "hono";
import { invalidRequest } from "./errors";

export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
export const FILES_API_BETA = "files-api-2025-04-14";
export const SKILLS_API_BETA = "skills-2025-10-02";
export const AGENT_MEMORY_BETA = "agent-memory-2026-07-22";
export const USER_PROFILES_BETA = "user-profiles-2026-08-18";
export const MCP_TUNNELS_BETA = "mcp-tunnels-2026-06-22";
export const DREAMING_BETA = "dreaming-2026-04-21";

export function requireBeta(requiredBeta: string): MiddlewareHandler {
  return async (c, next) => {
    const betas = new Set(
      (c.req.header("anthropic-beta") ?? "")
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean),
    );

    if (!betas.has(requiredBeta)) {
      return c.json(
        invalidRequest(`Missing required anthropic-beta flag: ${requiredBeta}`),
        400,
      );
    }

    await next();
  };
}
