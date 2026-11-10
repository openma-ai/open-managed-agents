import { checkCfWorkLeaseRecovery } from "./cf-work-lease-recovery";
import { type CfE2BWorkLease, createCfE2BWorkLeaseAuthority } from "./cf-work-provider-lease";
import { sandboxIdlePauseMs } from "@open-managed-agents/session-runtime";
import { SANDBOX_LEASE_MARGIN_MS } from "@open-managed-agents/sandbox";
import { sandboxTokenSha256 } from "@open-managed-agents/sandbox-gateway";
import type { Env } from "@open-managed-agents/shared";
import { parseInstalledHarnesses } from "@open-managed-agents/acp-runtime/installed-harnesses";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { attemptSandboxTokens } from "@open-managed-agents/sandbox-gateway";
import { createCfSqlWorkRunnerDispatch } from "../../../main/src/lib/cf-work-runner-authority";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { CloudflareSandbox } from "./sandbox";
import { createE2BSessionSandbox } from "./e2b-session-sandbox";
import { E2B_WORKER_INVENTORY, startE2BWorkProcess } from "./e2b-work-handoff";
import type { SessionSandboxStateStorage } from "./session-sandbox-do-state";
import { environmentWorkSandboxTokenRef, createSqlEnvironmentWorkSandboxTokenStore } from "@open-managed-agents/sandbox-gateway-sql";
import { issueSandboxToken } from "@open-managed-agents/sandbox-gateway";
import type { SessionNetworking } from "@open-managed-agents/sandbox-port-kit";
import type { EnvironmentWorkRuntimeDelivery } from "@open-managed-agents/runtime-resource-contract";

export const CF_WORK_DISPATCH_PATH = "/__internal/work/dispatch";
// Existing owner-scoped token holder only. No dispatch/claim ledger here.
const holders = new WeakMap<object, ReturnType<typeof attemptSandboxTokens>>();
export async function dispatchCfWorkRunnerRequest(request: Request, env: Env, owner?: { storage: SessionSandboxStateStorage; id: string; hasSessionExecution: boolean; workLease?: CfE2BWorkLease; beforeWorkStart?(scope: { workspaceId: string; environmentId: string; sessionId: string }): Promise<void> }): Promise<Response> {
  let input: EnvironmentWorkRuntimeDelivery;
  try { input = await request.json(); } catch { return Response.json({ error: "Invalid Work delivery" }, { status: 400 }); }
  if (!input || [input.workspaceId, input.environmentId, input.sessionId, input.workId, input.workSecret].some(value => typeof value !== "string" || !value.trim())) return Response.json({ error: "Incomplete Work scope" }, { status: 400 });
  const provider = env.SANDBOX_ADAPTER ?? "cloudflare";
  if (provider !== "cloudflare" && provider !== "e2b") return Response.json({ error: "Unknown Work sandbox provider" }, { status: 503 });
  const command = provider === "e2b" ? "/usr/local/bin/node" : (env as Env & { OPENMA_WORK_RUNNER_COMMAND?: string }).OPENMA_WORK_RUNNER_COMMAND;
  if (!command || !env.PUBLIC_BASE_URL || !env.PLATFORM_ROOT_SECRET) return Response.json({ error: "Work bootstrap is not configured" }, { status: 503 });
  const origin = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (input.apiBaseUrl !== origin) return Response.json({ error: "Work origin rejected" }, { status: 403 });
  try {
    if (provider === "e2b" && !owner) {
      if (!env.SESSION_DO) return Response.json({ error: "Work resource owner is not configured" }, { status: 503 });
      const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify([input.workspaceId, input.sessionId])));
      return await stub.fetch(new Request("https://internal" + CF_WORK_DISPATCH_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: request.signal }));
    }
    if (owner && (provider !== "e2b" || env.SESSION_DO?.idFromName(JSON.stringify([input.workspaceId, input.sessionId])).toString() !== owner.id || owner.hasSessionExecution)) throw new Error("Work resource owner mismatch");
    // Validate the complete deployment inventory before DB/token/provider work,
    // using the same pure parser as the in-sandbox supervisor.
    const inventoryRaw = (env as Env & { OPENMA_ACP_HARNESSES?: string }).OPENMA_ACP_HARNESSES;
    const inventory = parseInstalledHarnesses(inventoryRaw);
    if (provider === "e2b" && inventoryRaw !== E2B_WORKER_INVENTORY) throw new Error("E2B worker requires the certified installed inventory");
    const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(input.workspaceId));
    const cipher = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
    const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }) });
    let tokens = holders.get(env); if (!tokens) { tokens = attemptSandboxTokens(); holders.set(env, tokens); }
    const dispatcher = await createCfSqlWorkRunnerDispatch({ sql, work, controlPlaneOrigin: origin, command, tokens, installedHarnesses: inventoryRaw,
      installedHarnessResolver: { async resolve({ pinnedSession, signal }) {
        signal.throwIfAborted();
        if (!inventory) return null;
        const pin = pinnedSession.agent.openma?.acp?.agent;
        if (!pin?.command) return null;
        const matches = inventory.filter(entry => entry.command === pin.command && JSON.stringify(entry.args ?? []) === JSON.stringify(pin.args ?? []));
        if (matches.length !== 1) return null;
        return { id: matches[0].id, version: matches[0].version };
      } },
      sandbox: async (delivery, authority) => {
        if (provider === "cloudflare") return new CloudflareSandbox(env, delivery.sessionId);
        if (!owner) throw new Error("E2B requires its existing Session resource owner");
        // Persist the maintenance wake before a native launch can outlive this request.
        await owner.beforeWorkStart?.(delivery);
        // Cold duplicate dispatch must fail before egress rotates the holder.
        // The current native locator cannot bind its process to that new token.
        if (owner.workLease && !owner.workLease.active) {
          await checkCfWorkLeaseRecovery({ sql, storage: owner.storage, scope: delivery });
        }
        const attempt = environmentWorkSandboxTokenRef({ ...delivery, generation: authority.generation });
        const token = (sandbox: object | string) => tokens!.relayDelivery(attempt, () => issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql), attempt, { scope: "all" }), sandbox);
        const sandbox = createE2BSessionSandbox({ env, storage: owner.storage, scope: () => delivery,
          networking: async () => (authority.environment.config as { networking?: SessionNetworking }).networking, fence: () => undefined, relayToken: async () => { throw new Error("Work cannot use a SessionExecution token"); },
          workAuthority: { attempt, async isCurrent() { await authority.assertCurrent(); return true; }, token },
        });
        const runtime = await sandbox.runtime();
        return { provider: "e2b" as const, runtimeHandle: () => runtime.runtimeHandle(), startManagedProcess: async (spec, identity) => {
          const handle = await startE2BWorkProcess({ runtime, work, sql, delivery, assertCurrent: authority.assertCurrent, spec, identity });
          if (owner.workLease) {
            const holderHash = await sandboxTokenSha256(spec.env.OPENMA_SANDBOX_TOKEN);
            if (!holderHash) throw new Error("Work provider renewal requires its issued holder");
            owner.workLease.register({ runtime, handle, identity,
              ttlMs: sandboxIdlePauseMs((env as Env & { SANDBOX_IDLE_PAUSE_MS?: string }).SANDBOX_IDLE_PAUSE_MS) + SANDBOX_LEASE_MARGIN_MS,
              isCurrent: createCfE2BWorkLeaseAuthority({ sql, work, delivery, generation: authority.generation, holderHash }),
            }, { restored: !handle.created });
            // A durable owner drives maintenance separately: dispatch must not
            // re-run cleanup of an old handle already retired by handoff.
            // Legacy standalone owners retain their synchronous first tick.
            if (owner.beforeWorkStart) await owner.beforeWorkStart(delivery);
            else await owner.workLease.maintain();
          }
          return handle;
        } };
      },
    });
    // The factory compares the presented per-claim secret against the encrypted
    // Work row and reads the pinned Session before any token/provider mutation.
    return Response.json(await dispatcher.dispatch({ ...input, signal: request.signal }));
  } catch {
    // Dispatch may already have happened. No retry/stop or safe-to-retry claim.
    return Response.json({ error: "Work dispatch unconfirmed" }, { status: 409 });
  }
}
