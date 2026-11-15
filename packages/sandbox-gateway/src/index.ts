// Sandbox-originated request authority (design §0.0 rule 10, §0.7, #561):
// the model gateway, the MCP gateway, the sandbox API and the Vault egress
// gateway authenticate here, and the one sandbox credential is issued here,
// bound to the Session execution attempt. One implementation for Cloudflare
// and Node: platforms inject their stores (@open-managed-agents/sandbox-gateway-sql).

export type { SessionExecutionAttemptRef, SessionExecutionLease, SessionExecutionLeases } from "@open-managed-agents/session-runtime/execution-lease";
export * from "./vault-substitution";
export * from "./sandbox-token";
export * from "./sandbox-token-store";
export * from "./sandbox-token-authority";
export * from "./attempt-sandbox-token";
export * from "./sandbox-token-scope";
export * from "./sandbox-token-routes";
export * from "./sandbox-token-request";
export * from "./sandbox-egress-credential";
export * from "./sandbox-bearer";
