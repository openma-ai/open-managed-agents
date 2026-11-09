// SANDBOX_ADAPTER picks which SandboxAdapterPort is composed into the shared
// Session runtime (session-sandbox.ts). Nothing else in SessionDO depends on
// the adapter.

import type { Env } from "@open-managed-agents/shared";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { CloudflareSandboxImage } from "./sandbox";
import { createCloudflareSessionSandbox, type SandboxExecutionFence } from "./cloudflare-session-sandbox";
import { createE2BSessionSandbox } from "./e2b-session-sandbox";
import type { SessionNetworking } from "@open-managed-agents/sandbox-port-kit";
import { relaySandboxToken } from "./session-sandbox-token";
import type { PortsSessionSandbox, SessionSandboxIdleTimer } from "@open-managed-agents/session-runtime";

export interface SessionSandboxDeps {
  env: Env;
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  /** Sandbox Durable Object name for the Cloudflare adapter. */
  sandboxId: string;
  /** Operator catalog image for the Cloudflare adapter; null = SANDBOX. */
  sandboxImage: CloudflareSandboxImage | null;
  session(): { tenantId: string; environmentId: string; sessionId: string; agentId: string | null };
  /** The Session agent's harness name (sandbox token scope, #561; both adapters' egress). */
  harness(): string | null;
  networking(): Promise<SessionNetworking | undefined>;
  /** The Session's current execution attempt (design §0.0 rule 10). */
  fence(): SandboxExecutionFence | undefined;
  warn(message: string): void;
  /** Idle pause timer for adapters the host pauses (E2B); the Cloudflare
   * container stops itself through sleepAfter. */
  idleTimer: Omit<SessionSandboxIdleTimer, "pauseMs">;
}

export function createSessionSandbox(adapter: string | undefined, deps: SessionSandboxDeps): PortsSessionSandbox<unknown> {
  const name = adapter ?? "cloudflare";
  if (name === "cloudflare") {
    return createCloudflareSessionSandbox({ ...deps, relayToken: (attempt, sandbox) => relaySandboxToken(deps.env, attempt, deps.harness(), sandbox) }) as PortsSessionSandbox<unknown>;
  }
  if (name === "e2b") {
    return createE2BSessionSandbox({ env: deps.env, storage: deps.storage, scope: () => scopeOf(deps.session()), networking: deps.networking, fence: deps.fence, relayToken: (attempt, sandbox) => relaySandboxToken(deps.env, attempt, deps.harness(), sandbox), idleTimer: deps.idleTimer }) as PortsSessionSandbox<unknown>;
  }
  throw new Error(`Unknown SANDBOX_ADAPTER: ${name}`);
}

function scopeOf(s: { tenantId: string; environmentId: string; sessionId: string }): RuntimeResourceScope {
  return { workspaceId: s.tenantId, environmentId: s.environmentId, sessionId: s.sessionId, workId: s.sessionId };
}
