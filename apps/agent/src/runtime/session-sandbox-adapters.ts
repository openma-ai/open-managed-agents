// SANDBOX_ADAPTER picks which SandboxAdapterPort is composed into the shared
// Session runtime (session-sandbox.ts). Nothing else in SessionDO depends on
// the adapter.

import type { Env } from "@open-managed-agents/shared";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { createCloudflareSessionSandbox } from "./cloudflare-session-sandbox";
import { createE2BSessionSandbox, type SessionNetworking } from "./e2b-session-sandbox";
import type { PortsSessionSandbox } from "./session-sandbox";

export interface SessionSandboxDeps {
  env: Env;
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  /** Sandbox Durable Object name for the Cloudflare adapter. */
  sandboxId: string;
  session(): { tenantId: string; environmentId: string; sessionId: string; agentId: string | null };
  networking(): Promise<SessionNetworking | undefined>;
  warn(message: string): void;
}

export function createSessionSandbox(adapter: string | undefined, deps: SessionSandboxDeps): PortsSessionSandbox<unknown> {
  const name = adapter ?? "cloudflare";
  if (name === "cloudflare") {
    return createCloudflareSessionSandbox(deps) as PortsSessionSandbox<unknown>;
  }
  if (name === "e2b") {
    return createE2BSessionSandbox({ env: deps.env, storage: deps.storage, scope: () => scopeOf(deps.session()), networking: deps.networking }) as PortsSessionSandbox<unknown>;
  }
  throw new Error(`Unknown SANDBOX_ADAPTER: ${name}`);
}

function scopeOf(s: { tenantId: string; environmentId: string; sessionId: string }): RuntimeResourceScope {
  return { workspaceId: s.tenantId, environmentId: s.environmentId, sessionId: s.sessionId, workId: s.sessionId };
}
