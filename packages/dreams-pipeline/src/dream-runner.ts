// In-process driver for the dream pipeline.
//
// Design choices:
//   - Linear sequence of steps from steps.ts. No checkpoint, no built-in
//     retry — recovery comes from the cron sweep (cron/dream-recovery.ts)
//     which re-invokes this function on dreams stuck in `running` past
//     the staleness threshold. Steps are written to be idempotent so
//     re-runs are safe.
//   - Works without Cloudflare-specific dependencies. apps/main kicks it
//     via ctx.waitUntil from POST /v1/dreams and recovers stale runs via
//     the scheduled cron handler.
//   - Cancellation: we re-read the dream's status between every step
//     and abort if it landed on `canceled`. This is cheap (a single
//     SELECT) and gives sub-second cancel responsiveness for typical
//     dream durations.

import {
  DreamFatalError,
  type DreamPipelineServices,
  type DreamStepCommon,
} from "./steps";
import {
  curateMemories,
  markCompleted,
  markFailedSafely,
  markRunning,
  preflight,
  provisionOutputStore,
  publishUsage,
  readInputMemories,
  readInputSessions,
  spawnInternalSession,
  writeCuratedMemory,
} from "./steps";
import type { DreamCurator } from "./curator";
import type { DreamRow } from "@open-managed-agents/dreams-store";

export interface DreamRunnerDeps {
  services: DreamPipelineServices;
  curator: DreamCurator;
  tenantId: string;
  dreamId: string;
  logger?: {
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

/**
 * Drive a single dream to a terminal state. Never throws — every failure
 * is caught and translated to markFailed.
 *
 * Returns the final DreamRow, or null if the dream was missing entirely
 * (treated as "nothing to do").
 */
export async function runDream(deps: DreamRunnerDeps): Promise<DreamRow | null> {
  const { services, tenantId, dreamId } = deps;
  const log = deps.logger ?? consoleLogger;
  const common: DreamStepCommon = { services, tenantId, dreamId };

  try {
    // ── Preflight ───────────────────────────────────────────────────────
    const initial = await preflight(common);
    if (initial.skip) return initial.dream;
    let dream = initial.dream;

    // ── Provision output + spawn observability session ─────────────────
    //
    // Recovery can re-enter here with status=running. In that case the
    // output store has already been published by markRunning, so reuse it
    // and continue with the durable work instead of allocating a new store.
    let outputMemoryStoreId = dream.output_memory_store_id;
    if (dream.status === "pending") {
      outputMemoryStoreId = await provisionOutputStore(common, dream);
      if (await isCanceled(common)) return refresh(common);

      const sessionId = await spawnInternalSession(common, dream, outputMemoryStoreId);
      if (await isCanceled(common)) return refresh(common);

      await markRunning(common, outputMemoryStoreId, sessionId);
      if (await isCanceled(common)) return refresh(common);
    } else if (dream.status === "running" && !outputMemoryStoreId) {
      return await markFailedSafely(services, tenantId, dreamId, {
        type: "internal_error",
        message: "running dream is missing output memory store",
      });
    }
    if (!outputMemoryStoreId) {
      return await markFailedSafely(services, tenantId, dreamId, {
        type: "internal_error",
        message: "dream is missing output memory store",
      });
    }

    // ── Read inputs ─────────────────────────────────────────────────────
    const inputMemories = await readInputMemories(common, dream.input_memory_store_id);
    if (await isCanceled(common)) return refresh(common);

    const inputSessions = await readInputSessions(common, dream.input_session_ids);
    if (await isCanceled(common)) return refresh(common);

    // ── Curate ──────────────────────────────────────────────────────────
    const curated = await curateMemories(deps.curator, dream, inputMemories, inputSessions);
    await publishUsage(common, curated.usage);
    if (await isCanceled(common)) return refresh(common);

    // ── Write outputs ───────────────────────────────────────────────────
    let writeFailures = 0;
    for (const mem of curated.memories) {
      if (await isCanceled(common)) return refresh(common);
      const ok = await writeCuratedMemory(common, outputMemoryStoreId, mem);
      if (!ok) writeFailures++;
    }
    if (writeFailures > 0 && writeFailures === curated.memories.length) {
      return await markFailedSafely(services, tenantId, dreamId, {
        type: "internal_error",
        message: `all ${writeFailures} curated memory writes failed`,
      }, curated.usage);
    }

    // ── Commit ──────────────────────────────────────────────────────────
    return await markCompleted(common, curated.usage);
  } catch (err) {
    if (err instanceof DreamFatalError) {
      // markFailed was already called inside the step; just read the row back.
      return services.dreams.get({ tenantId, dreamId }).catch(() => null);
    }
    log.error("runDream uncaught", { dreamId, err: errStr(err) });
    return await markFailedSafely(services, tenantId, dreamId, {
      type: "internal_error",
      message: `pipeline error: ${errStr(err)}`,
    });
  }
}

async function isCanceled(common: DreamStepCommon): Promise<boolean> {
  const d = await common.services.dreams.get({
    tenantId: common.tenantId,
    dreamId: common.dreamId,
  });
  return d?.status === "canceled";
}

async function refresh(common: DreamStepCommon): Promise<DreamRow | null> {
  return common.services.dreams.get({
    tenantId: common.tenantId,
    dreamId: common.dreamId,
  });
}

function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const consoleLogger = {
  warn: (m: string, ctx?: unknown) => console.warn(m, ctx),
  error: (m: string, ctx?: unknown) => console.error(m, ctx),
};

// ============================================================
// Curator factory — shared by route + cron sweep so both paths pick the
// same backing implementation.
// ============================================================

import { AnthropicDreamCurator, DedupOnlyDreamCurator } from "./curator";

/**
 * Minimal env shape the curator factory reads. The full `Env` (CF) and
 * a plain `process.env`-shaped object (Node) both satisfy this — keeping
 * the factory framework-agnostic so dreams-pipeline doesn't pull in
 * @open-managed-agents/shared's Cloudflare binding type tree.
 */
export interface DreamCuratorEnv {
  DREAM_CURATOR_MODE?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}

export function pickCurator(env: DreamCuratorEnv): DreamCurator {
  if (env.DREAM_CURATOR_MODE === "dedup") return new DedupOnlyDreamCurator();
  return new AnthropicDreamCurator(env.ANTHROPIC_API_KEY ?? "", env.ANTHROPIC_BASE_URL);
}
