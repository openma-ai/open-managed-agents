// CF scheduler wiring — registers the CF cron handlers via the
// runtime-agnostic Scheduler interface. Each handler is the same one
// registered by Node in apps/main-node/src/lib/node-scheduler-jobs.ts.
//
// CF still owns the schedule itself (wrangler `triggers.crons`). The
// scheduled() entry below calls `dispatch(controller.cron)` to look up
// and invoke registered jobs whose cron expression matches.

import type { Env } from "@open-managed-agents/shared";
import { log, logError, recordEvent, errFields } from "@open-managed-agents/shared";
import { forEachShardServices } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { createCfScheduler, type CfScheduler } from "@open-managed-agents/scheduler/cf";
import { memoryRetentionTick } from "@open-managed-agents/scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@open-managed-agents/scheduler/jobs/webhook-events-retention";
import { tickEvalRuns } from "../eval-runner";
import { dreamRecoveryTick } from "../cron/dream-recovery";
import { SqlManagedSessionsComposition, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { EnvironmentWorkEnqueuerService, admitAllSessionCreates } from "@open-managed-agents/managed-agents-application";
import { EnvironmentAwareSessionEventDispatchRouter, SealedEnvironmentWorkSessionCredentialIssuer, StandardWebhookEnvironmentWorkWakeup } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** Same Work credential namespaces as the HTTP composition. No turn runtime
 * is mounted here: cron may repair scheduling, never execute a model/tool. */
export function cfSessionSchedulingRecovery(env: Env, client: SqlClient): SqlManagedSessionsComposition {
  const secret = env.PLATFORM_ROOT_SECRET;
  const origin = env.PUBLIC_BASE_URL;
  if (!secret || !origin) throw new Error("Work recovery requires PLATFORM_ROOT_SECRET and PUBLIC_BASE_URL");
  const workCrypto = new WebCryptoAesGcm(secret, "managed.environment-work.secret");
  const store = new SqlEnvironmentWorkStore(client, {
    seal: async ({ plaintext }) => ({ ciphertext: await workCrypto.encrypt(plaintext) }),
    open: async ({ ciphertext }) => ({ plaintext: await workCrypto.decrypt(ciphertext) }),
  });
  const credentials = new SealedEnvironmentWorkSessionCredentialIssuer({
    crypto: new WebCryptoAesGcm(secret, "managed.environment-work.session-token"), now: () => new Date(), apiBaseUrl: new URL(origin).origin,
  });
  const webhook = env.OMA_MANAGED_AGENTS_WEBHOOK_URL && env.OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY
    ? new StandardWebhookEnvironmentWorkWakeup({ endpoint: env.OMA_MANAGED_AGENTS_WEBHOOK_URL,
      signingKey: env.OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY, organizationId: ({ workspaceId }) => env.OMA_MANAGED_AGENTS_ORGANIZATION_ID ?? workspaceId,
      nextEventId: () => "whe_" + crypto.randomUUID().replaceAll("-", "") }) : null;
  const runtime = { sessionEventsAccepted: async () => { throw new Error("Recovery must not execute a Session turn"); },
    sessionThreadArchived: async () => {}, async *subscribe() {} };
  const router = EnvironmentAwareSessionEventDispatchRouter.forWorkspace(runtime, workspaceId => new EnvironmentWorkEnqueuerService({
    workspaceId, store, credentials, clock: { now: () => new Date() }, ids: { nextEnvironmentWorkId: () => "work_" + crypto.randomUUID().replaceAll("-", "") },
    wakeup: { notifyRunStarted: async input => { await webhook?.notifyRunStarted(input); } },
  }));
  return new SqlManagedSessionsComposition({ client, environments: new SqlSessionEnvironmentSource(client), runtime, eventDispatch: router,
    lifecycle: { sessionStarted: async () => { throw new Error("Recovery cannot create a Session"); }, sessionStopped: async () => {} },
    admission: admitAllSessionCreates, sealer: { seal: async value => value }, clock: { now: () => new Date() },
    ids: { nextEventId: () => "unused", nextSessionId: () => "unused", nextOutcomeId: () => "unused", nextResourceId: () => "unused" } });
}

// Cron expressions are env-overridable so ops can shift sweeps without a
// code deploy. Defaults match the pre-extract behaviour exactly.
function envCron(env: Env, key: string, fallback: string): string {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  return raw && raw.trim() ? raw : fallback;
}

export function buildCfScheduler(env: Env): CfScheduler {
  const scheduler = createCfScheduler();
  const tickCron = envCron(env, "EVAL_TICK_CRON", "* * * * *");
  const memoryCron = envCron(env, "MEMORY_RETENTION_CRON", "* * * * *");
  const webhookCron = envCron(env, "WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *");
  const dreamsCron = envCron(env, "DREAM_RECOVERY_CRON", "* * * * *");
  scheduler.register({
    name: "session-work-recovery", cron: "* * * * *",
    handler: async () => {
      await forEachShardServices(env, async (services, shardName) => {
        const db = (env as unknown as Record<string, D1Database | undefined>)[shardName];
        if (!db) return;
        const cursorKey = "session-work-recovery-cursor:" + shardName;
        const raw = await services.kv.get(cursorKey);
        const after = raw ? JSON.parse(raw) as { workspaceId: string; sessionId: string } : undefined;
        const composition = cfSessionSchedulingRecovery(env, new CfD1SqlClient(db));
        try {
          const page = await composition.recoverSchedulingPage({ limit: 20, after,
            onError: err => logError({ op: "cron.session_work_recovery", shard: shardName, err }, "Session scheduling recovery deferred") });
          // An advisory pagination cursor only. Losing it repeats discovery;
          // Work CAS and canonical consumption still decide all execution.
          if (page.next) await services.kv.put(cursorKey, JSON.stringify(page.next));
          else await services.kv.delete(cursorKey);
        } finally { await composition.stopAll(); }
      });
    },
  });

  scheduler.register({
    name: "eval-tick",
    cron: tickCron,
    handler: () =>
      tickEvalRuns(env).then(
        (result) =>
          log(
            { op: "cron.tick_eval_runs", advanced: result.advanced, total: result.total },
            "tickEvalRuns ok",
          ),
        (err) => {
          logError({ op: "cron.tick_eval_runs", err }, "tickEvalRuns failed");
          recordEvent(env.ANALYTICS, {
            op: "cron.tick_eval_runs.failed",
            ...errFields(err),
          });
        },
      ),
  });

  scheduler.register({
    name: "memory-retention",
    cron: memoryCron,
    handler: memoryRetentionTick({
      forEachShard: (fn) => forEachShardServices(env, (s, name) => fn(s, name)),
    }),
  });

  scheduler.register({
    name: "webhook-events-retention",
    cron: webhookCron,
    handler: webhookEventsRetentionTick({
      resolveIntegrationsDb: () =>
        env.INTEGRATIONS_DB ? new CfD1SqlClient(env.INTEGRATIONS_DB) : null,
    }),
  });

  scheduler.register({
    name: "dream-recovery",
    cron: dreamsCron,
    handler: () => dreamRecoveryTick(env),
  });

  // Design §0.0 rule 14: the agent worker reaches the Sandbox DOs, so it runs
  // the shared orphan reclaim; nothing to do without its service binding.
  scheduler.register({
    name: "sandbox-orphan-reclaim",
    cron: envCron(env, "SANDBOX_ORPHAN_RECLAIM_CRON", "* * * * *"),
    handler: async () => {
      const agent = (env as unknown as Record<string, Fetcher | undefined>).SANDBOX_sandbox_default;
      if (agent === undefined) return;
      const response = await agent.fetch("https://sandbox/__internal/sandbox-orphans/reclaim", { method: "POST" });
      if (!response.ok) throw new Error(`sandbox orphan reclaim failed: ${response.status}`);
      log({ op: "cron.sandbox_orphan_reclaim", ...(await response.json() as Record<string, unknown>) }, "sandbox orphan reclaim ok");
    },
  });

  return scheduler;
}
