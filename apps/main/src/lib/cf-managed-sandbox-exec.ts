// POST /v1/oma/sessions/:sessionId/sandbox/exec on Cloudflare.
//
// Same contract as the Node control plane (packages/control-plane-node
// node-http.ts): body { command, timeout_ms? }, response { exit_code, output },
// 400 on a bad body, 404 for a missing/archived Session, 409 while it is
// running/rescheduling or when it has no Cloudflare sandbox, 502 when the
// sandbox call fails. The command runs in the Session's own SessionDO
// sandbox (POST /exec), reached through the managed runtime fetcher with the
// workspace scope header, so it hits the same container as the agent.

import { Hono } from "hono";

export interface RuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CfManagedSandboxExecSession {
  status: string;
  archivedAt: string | null;
  environmentId: string;
}

export interface CfManagedSandboxExecDependencies {
  workspaceId(c: import("hono").Context): string;
  retrieveSession(c: import("hono").Context, sessionId: string): Promise<CfManagedSandboxExecSession | null>;
  /** "cloud" sessions have a Cloudflare sandbox; "self_hosted" do not. */
  environmentType(c: import("hono").Context, environmentId: string): Promise<"cloud" | "self_hosted" | null>;
  fetcher(c: import("hono").Context): RuntimeFetcher;
}

export const MAX_SANDBOX_EXEC_TIMEOUT_MS = 3_600_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run a command in a managed Session's SessionDO sandbox (created on first
 * use). stderr is merged into stdout like Node; the exit status comes from
 * the SDK's exitCode via SessionDO (`sh -c` exits with the command's
 * status). Throws on transport or sandbox failure. Shared with evals.
 */
export async function execCfManagedSandbox(
  fetcher: RuntimeFetcher,
  workspaceId: string,
  sessionId: string,
  command: string,
  timeoutMs: number,
): Promise<{ exit_code: number; output: string }> {
  const response = await fetcher.fetch(
    `https://managed-runtime/sessions/${encodeURIComponent(sessionId)}/exec`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-oma-workspace-id": workspaceId },
      body: JSON.stringify({ command: `sh -c ${shellQuote(command)} 2>&1`, timeout_ms: timeoutMs }),
    },
  );
  const result = await response.json<{ exit_code?: unknown; output?: unknown; error?: unknown; message?: unknown }>()
    .catch(() => null);
  if (!response.ok || result === null || result.error !== undefined) {
    const detail = typeof result?.output === "string" ? result.output
      : typeof result?.message === "string" ? result.message
      : `Sandbox exec failed (${response.status})`;
    throw new Error(detail);
  }
  if (typeof result.exit_code !== "number" || result.exit_code < 0 || typeof result.output !== "string") {
    throw new Error(`Sandbox exec did not report an exit status: ${String(result.output ?? "").slice(-2000)}`);
  }
  // CF SessionDO appends "\nstderr: <text>" for stderr of the outer shell
  // (normally empty because of 2>&1) and keeps the first 100 KB of output.
  return { exit_code: result.exit_code, output: result.output.replace(/\n$/u, "") };
}

export function buildCfManagedSandboxExecRoutes(deps: CfManagedSandboxExecDependencies): Hono {
  const app = new Hono();
  app.post("/:sessionId/sandbox/exec", async (c) => {
    const workspaceId = deps.workspaceId(c);
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ command?: unknown; timeout_ms?: unknown }>().catch(() => null);
    if (body === null || typeof body.command !== "string" || body.command.length === 0) {
      return c.json({ error: "command is required" }, 400);
    }
    const timeoutMs = body.timeout_ms === undefined ? 60_000 : body.timeout_ms;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SANDBOX_EXEC_TIMEOUT_MS) {
      return c.json({ error: "timeout_ms must be an integer between 1 and 3600000" }, 400);
    }
    const session = await deps.retrieveSession(c, sessionId);
    if (session === null || session.archivedAt !== null) return c.json({ error: "Session not found" }, 404);
    if (session.status === "running" || session.status === "rescheduling") {
      return c.json({ error: `Session is ${session.status}; exec requires a session that is not running` }, 409);
    }
    if ((await deps.environmentType(c, session.environmentId)) !== "cloud") {
      return c.json({ error: "Session has no connected sandbox" }, 409);
    }
    try {
      return c.json(await execCfManagedSandbox(deps.fetcher(c), workspaceId, sessionId, body.command, timeoutMs));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });
  return app;
}
