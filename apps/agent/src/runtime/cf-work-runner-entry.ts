import type { Env } from "@open-managed-agents/shared";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { attemptSandboxTokens } from "@open-managed-agents/sandbox-gateway";
import { createCfSqlWorkRunnerDispatch } from "../../../main/src/lib/cf-work-runner-authority";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { CloudflareSandbox } from "./sandbox";
import type { EnvironmentWorkRuntimeDelivery } from "@open-managed-agents/runtime-resource-contract";

export const CF_WORK_DISPATCH_PATH = "/__internal/work/dispatch";
// Existing owner-scoped token holder only. No dispatch/claim ledger here.
const holders = new WeakMap<object, ReturnType<typeof attemptSandboxTokens>>();
export async function dispatchCfWorkRunnerRequest(request: Request, env: Env): Promise<Response> {
  let input: EnvironmentWorkRuntimeDelivery;
  try { input = await request.json(); } catch { return Response.json({ error: "Invalid Work delivery" }, { status: 400 }); }
  if (!input || [input.workspaceId, input.environmentId, input.sessionId, input.workId, input.workSecret].some(value => typeof value !== "string" || !value.trim())) return Response.json({ error: "Incomplete Work scope" }, { status: 400 });
  const command = (env as Env & { OPENMA_WORK_RUNNER_COMMAND?: string }).OPENMA_WORK_RUNNER_COMMAND;
  if (!command || !env.PUBLIC_BASE_URL || !env.PLATFORM_ROOT_SECRET) return Response.json({ error: "Work bootstrap is not configured" }, { status: 503 });
  const origin = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (input.apiBaseUrl !== origin) return Response.json({ error: "Work origin rejected" }, { status: 403 });
  try {
    const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(input.workspaceId));
    const cipher = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
    const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }) });
    let tokens = holders.get(env); if (!tokens) { tokens = attemptSandboxTokens(); holders.set(env, tokens); }
    const inventoryRaw = (env as Env & { OPENMA_ACP_HARNESSES?: string }).OPENMA_ACP_HARNESSES;
    const dispatcher = await createCfSqlWorkRunnerDispatch({ sql, work, controlPlaneOrigin: origin, command, tokens, installedHarnesses: inventoryRaw,
      installedHarnessResolver: { async resolve({ pinnedSession, signal }) {
        signal.throwIfAborted();
        if (!inventoryRaw) return null;
        // Same operator-owned OPENMA_ACP_HARNESSES inventory consumed by the
        // in-sandbox supervisor, never Work metadata or caller selection.
        const inventory: unknown = JSON.parse(inventoryRaw);
        if (!Array.isArray(inventory)) throw new TypeError("Installed harness inventory is invalid");
        const pin = pinnedSession.agent.openma?.acp?.agent;
        if (!pin?.command) return null;
        const matches = inventory.filter(entry => entry && typeof entry.id === "string" && entry.id && typeof entry.version === "string" && entry.version && entry.command === pin.command && JSON.stringify(entry.args ?? []) === JSON.stringify(pin.args ?? []));
        if (matches.length !== 1) return null;
        return { id: matches[0].id, version: matches[0].version };
      } },
      sandbox: async delivery => new CloudflareSandbox(env, delivery.sessionId),
    });
    // The factory compares the presented per-claim secret against the encrypted
    // Work row and reads the pinned Session before any token/provider mutation.
    return Response.json(await dispatcher.dispatch({ ...input, signal: request.signal }));
  } catch {
    // Dispatch may already have happened. No retry/stop or safe-to-retry claim.
    return Response.json({ error: "Work dispatch unconfirmed" }, { status: 409 });
  }
}
