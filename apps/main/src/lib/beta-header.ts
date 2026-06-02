// Helpers for Anthropic-style `anthropic-beta` header gating.
//
// Anthropic ships preview features behind opt-in beta flags so SDKs can
// negotiate compatibility — see e.g. the Managed Agents Dreams docs:
// "All Managed Agents API requests require the `managed-agents-2026-04-01`
//  beta header. Dreams additionally require the `dreaming-2026-04-21` beta
//  header. The SDK sets these automatically."
//
// Until OMA grows broader beta-flag support this lives in apps/main/src/lib
// instead of @open-managed-agents/services. When other endpoints adopt
// beta headers we can move the helpers + middleware into the services
// package without touching callers.

import type { Context, MiddlewareHandler } from "hono";

export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
export const DREAMING_BETA = "dreaming-2026-04-21";

/**
 * Parse the `anthropic-beta` request header into a Set of flag names.
 * The header is comma-separated per Anthropic convention. Whitespace and
 * empty entries are tolerated. Returns an empty Set if the header is
 * missing.
 */
export function parseBetaHeader(c: Context): Set<string> {
  const raw = c.req.header("anthropic-beta");
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Reject the request if any of the required beta flags is missing.
 * Returns an Anthropic-shaped error envelope (`invalid_request_error`),
 * mirroring the shape Anthropic uses when a beta-gated endpoint is hit
 * without the header set.
 */
export function requireBetas(required: string[]): MiddlewareHandler {
  return async (c, next) => {
    const set = parseBetaHeader(c);
    const missing = required.filter((flag) => !set.has(flag));
    if (missing.length > 0) {
      return c.json(
        {
          type: "error" as const,
          error: {
            type: "invalid_request_error",
            message: `missing required anthropic-beta flag(s): ${missing.join(", ")}`,
          },
        },
        400,
      );
    }
    await next();
  };
}
