// Cloudflare SessionDO usage admission for existing-session work.
//
// Sub-agent threads are started inside a running turn, after the main
// worker's SessionEvents gate has already admitted that turn. A mid-turn
// $0 balance must still stop the child before any thread row / event /
// harness start. This adapter reuses the shared
// `SessionCreateAdmissionService.admitSandboxStart` policy (local-runtime
// skip, fail-open on meter errors, payment_required shape) and only supplies
// the USAGE_METER service-binding adapter.

import type { Env } from "@open-managed-agents/shared";
import {
  classifyExternalError,
  logError,
  logWarn,
} from "@open-managed-agents/shared";
import {
  SessionCreateAdmissionService,
  type SessionSandboxStartAdmissionDecision,
  type SessionUsageMeterPort,
} from "@open-managed-agents/managed-agents-application";

export interface CloudSandboxStartAdmissionInput {
  workspaceId: string;
  agentId: string;
  environmentId: string;
  isLocalRuntime: boolean;
}

export async function admitCloudSandboxStart(
  env: Env,
  input: CloudSandboxStartAdmissionInput,
): Promise<SessionSandboxStartAdmissionDecision> {
  const meter = env.USAGE_METER;
  const usageMeter: SessionUsageMeterPort | undefined = meter === undefined
    ? undefined
    : {
        canStartSandbox: async ({ workspaceId, agentId }) => {
          try {
            const gate = await meter.canStartSandbox({
              tenantId: workspaceId,
              agentId,
            });
            return {
              ok: gate.ok,
              ...(gate.reason !== undefined && { reason: gate.reason }),
              ...(gate.balance_cents !== undefined && {
                balanceCents: gate.balance_cents,
              }),
            };
          } catch (err) {
            throw classifyExternalError(err);
          }
        },
      };
  return new SessionCreateAdmissionService({
    ...(usageMeter !== undefined && { usageMeter }),
    clock: { now: () => new Date() },
    logger: {
      warn: (message, fields) => logWarn(fields as never, message),
      error: (message, fields) => logError(fields as never, message),
    },
  }).admitSandboxStart(input);
}
