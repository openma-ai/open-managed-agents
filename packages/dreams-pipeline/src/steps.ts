// Pure pipeline steps for the dream curation pipeline.
//
// Each step is a free-standing async function with no dependency on
// cloudflare:workers or any Worker-only API. The in-process driver calls
// them sequentially, and recovery re-invokes the same idempotent steps.
//
// Each step returns the data the next step needs as plain serializable
// values. That's a requirement for Cloudflare Workflows (step.do return
// values must be JSON-serializable for checkpoint replay), and a sensible
// constraint for any pipeline you'd want to inspect or resume.
//
// Errors that should NEVER be retried (validation, missing inputs)
// throw `DreamFatalError` — drivers translate this to the right
// non-retryable signal for their runtime. Errors not wrapped this way
// are considered transient and may be retried by the workflow driver.

import {
  type DreamCurator,
  type DreamCuratorOutput,
} from "./curator";
import {
  isTerminal,
  type DreamError,
  type DreamRow,
  type DreamUsage,
  type DreamService,
} from "@open-managed-agents/dreams-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type { SessionService } from "@open-managed-agents/sessions-store";

/**
 * Minimum service surface the dream pipeline needs. CF's `Services` container
 * satisfies this structurally.
 *
 *   - `dreams`, `memory`: required everywhere.
 *   - `sessions`: optional. When null, the pipeline runs with
 *     dream.session_id = null (still spec-compliant — the spec allows it).
 *   - `memoryStoreTenantIndex`: optional. CF uses it to register
 *     store_id → tenant_id for the R2 events queue consumer; Node has no
 *     such consumer.
 *
 * Defined here (not imported from @open-managed-agents/services) so this
 * package stays out of the CF service-container dependency tree — Node
 * self-host pulls in only what the pipeline needs.
 */
export interface DreamPipelineServices {
  dreams: DreamService;
  memory: MemoryStoreService;
  sessions: SessionService | null;
  memoryStoreTenantIndex: {
    register(storeId: string, tenantId: string): Promise<unknown>;
  } | null;
}

/** Sentinel ids for the synthetic internal session the pipeline spawns.
 *  Not registered as real agent / environment rows — SessionService.create
 *  doesn't validate referenced ids, and the session is observability-only. */
export const DREAM_CURATOR_AGENT_ID = "agent-dream-curator";
export const DREAM_CURATOR_ENV_ID = "env-dream-curator";

/**
 * Wrapper around an error that should NOT be retried. Drivers detect this
 * and bypass their retry policy (Workflow: throws cloudflare:workflows
 * NonRetryableError; in-process: just propagates).
 */
export class DreamFatalError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DreamFatalError";
  }
}

export interface DreamStepCommon {
  services: DreamPipelineServices;
  tenantId: string;
  dreamId: string;
}

// ============================================================
// Step 1: preflight — verify dream + inputs exist, return frozen DreamRow
// ============================================================

export interface PreflightOutput {
  /** True if the dream is already terminal. Driver should short-circuit. */
  skip: boolean;
  dream: DreamRow;
}

export async function preflight(common: DreamStepCommon): Promise<PreflightOutput> {
  const { services, tenantId, dreamId } = common;
  const dream = await services.dreams.get({ tenantId, dreamId });
  if (!dream) {
    throw new DreamFatalError(`dream ${dreamId} not found`);
  }
  if (isTerminal(dream.status)) {
    return { skip: true, dream };
  }
  const inputStore = await services.memory.getStore({
    tenantId,
    storeId: dream.input_memory_store_id,
  });
  if (!inputStore || inputStore.archived_at) {
    await markFailedSafely(services, tenantId, dreamId, {
      type: "input_memory_store_unavailable",
      message: "input memory store unavailable",
    });
    throw new DreamFatalError("input_memory_store_unavailable");
  }
  // Sessions service is optional (self-host doesn't always wire one).
  // When missing we trust the dream-create input was valid + skip the
  // mid-run existence check; the dream still works, just with no
  // session-archive-mid-run detection.
  if (services.sessions) {
    for (const sid of dream.input_session_ids) {
      const s = await services.sessions.get({ tenantId, sessionId: sid });
      if (!s || s.archived_at) {
        await markFailedSafely(services, tenantId, dreamId, {
          type: "input_session_unavailable",
          message: `input session ${sid} unavailable`,
        });
        throw new DreamFatalError("input_session_unavailable");
      }
    }
  }
  return { skip: false, dream };
}

// ============================================================
// Step 2: provision output memory store
// ============================================================

export async function provisionOutputStore(
  common: DreamStepCommon,
  dream: DreamRow,
): Promise<string> {
  const out = await common.services.memory.createStore({
    tenantId: common.tenantId,
    name: `dream-${dream.id}`,
    description: `Curated by ${dream.id} from input ${dream.input_memory_store_id}`,
  });
  // memoryStoreTenantIndex.register is CF-only (R2 events queue consumer).
  // It's fire-and-forget at the spec level — failure doesn't invalidate
  // the dream — so we just no-op when the service isn't wired.
  if (common.services.memoryStoreTenantIndex) {
    common.services.memoryStoreTenantIndex
      .register(out.id, common.tenantId)
      .catch(() => {});
  }
  return out.id;
}

// ============================================================
// Step 3: spawn internal observability session
// ============================================================

export async function spawnInternalSession(
  common: DreamStepCommon,
  dream: DreamRow,
  outputMemoryStoreId: string,
): Promise<string | null> {
  // Sessions service is optional. When absent, the dream proceeds with
  // session_id=null — the spec explicitly permits this.
  if (!common.services.sessions) return null;
  try {
    const result = await common.services.sessions.create({
      tenantId: common.tenantId,
      agentId: DREAM_CURATOR_AGENT_ID,
      environmentId: DREAM_CURATOR_ENV_ID,
      title: `Dream ${dream.id}`,
      metadata: {
        kind: "dream_pipeline",
        dream_id: dream.id,
        input_memory_store_id: dream.input_memory_store_id,
        output_memory_store_id: outputMemoryStoreId,
      },
      resources: [
        {
          type: "memory_store",
          memory_store_id: dream.input_memory_store_id,
          access: "read_only",
        },
        {
          type: "memory_store",
          memory_store_id: outputMemoryStoreId,
          access: "read_write",
        },
      ],
    });
    return result.session.id;
  } catch {
    // Soft-fail: dream can complete with session_id=null per spec.
    return null;
  }
}

// ============================================================
// Step 4: mark running (idempotent — handles checkpoint replay)
// ============================================================

export async function markRunning(
  common: DreamStepCommon,
  outputMemoryStoreId: string,
  sessionId: string | null,
): Promise<void> {
  const cur = await common.services.dreams.get({
    tenantId: common.tenantId,
    dreamId: common.dreamId,
  });
  if (!cur) {
    throw new DreamFatalError("dream vanished pre-running");
  }
  if (cur.status === "canceled") {
    throw new DreamFatalError("dream canceled before running");
  }
  if (cur.status !== "pending") {
    // already running on replay — no-op.
    return;
  }
  await common.services.dreams.markRunning({
    tenantId: common.tenantId,
    dreamId: common.dreamId,
    outputMemoryStoreId,
    sessionId,
  });
}

// ============================================================
// Step 5: read input memories (with content)
// ============================================================

export async function readInputMemories(
  common: DreamStepCommon,
  inputStoreId: string,
): Promise<Array<{ path: string; content: string }>> {
  const list = await common.services.memory.listMemories({
    tenantId: common.tenantId,
    storeId: inputStoreId,
  });
  return Promise.all(
    list.map(async (m) => {
      const full = await common.services.memory.readByPath({
        tenantId: common.tenantId,
        storeId: inputStoreId,
        path: m.path,
      });
      return { path: m.path, content: full?.content ?? "" };
    }),
  );
}

// ============================================================
// Step 6: read input session metadata
// ============================================================

export async function readInputSessions(
  common: DreamStepCommon,
  sessionIds: ReadonlyArray<string>,
): Promise<Array<{ id: string; title: string | null }>> {
  if (!common.services.sessions) {
    // No sessions service — emit a thin descriptor list so the curator
    // can still reference the session ids by name without title hints.
    return sessionIds.map((id) => ({ id, title: null }));
  }
  const out: Array<{ id: string; title: string | null }> = [];
  for (const sid of sessionIds) {
    const s = await common.services.sessions.get({
      tenantId: common.tenantId,
      sessionId: sid,
    });
    if (!s) {
      await markFailedSafely(common.services, common.tenantId, common.dreamId, {
        type: "input_session_unavailable",
        message: `input session ${sid} vanished mid-run`,
      });
      throw new DreamFatalError("input_session_unavailable");
    }
    out.push({ id: s.id, title: s.title ?? null });
  }
  return out;
}

// ============================================================
// Step 7: LLM curation (the one network step)
// ============================================================

export async function curateMemories(
  curator: DreamCurator,
  dream: DreamRow,
  inputMemories: ReadonlyArray<{ path: string; content: string }>,
  inputSessions: ReadonlyArray<{ id: string; title: string | null }>,
): Promise<DreamCuratorOutput> {
  return curator.curate({
    inputMemories,
    inputSessions,
    instructions: dream.instructions,
    model: dream.model,
  });
}

// ============================================================
// Step 8: publish usage (best-effort)
// ============================================================

export async function publishUsage(
  common: DreamStepCommon,
  usage: DreamUsage,
): Promise<void> {
  try {
    await common.services.dreams.publishUsage({
      tenantId: common.tenantId,
      dreamId: common.dreamId,
      usage,
    });
  } catch {
    // publishUsage is advisory — a stale row failing here shouldn't fail
    // the whole pipeline.
  }
}

// ============================================================
// Step 9: write a single curated memory (driver loops over these)
// ============================================================

export async function writeCuratedMemory(
  common: DreamStepCommon,
  outputMemoryStoreId: string,
  mem: { path: string; content: string },
): Promise<boolean> {
  try {
    await common.services.memory.writeByPath({
      tenantId: common.tenantId,
      storeId: outputMemoryStoreId,
      path: mem.path,
      content: mem.content,
      actor: { type: "system", id: `dream:${common.dreamId}` },
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Step 10: mark completed (idempotent — handles late cancel)
// ============================================================

export async function markCompleted(
  common: DreamStepCommon,
  usage: DreamUsage,
): Promise<DreamRow | null> {
  try {
    return await common.services.dreams.markCompleted({
      tenantId: common.tenantId,
      dreamId: common.dreamId,
      usage,
    });
  } catch {
    // Service rejects from non-running status — likely raced with cancel.
    // Refresh + return whatever terminal state we landed in.
    return common.services.dreams.get({
      tenantId: common.tenantId,
      dreamId: common.dreamId,
    });
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Mark the dream failed without throwing — used by steps that detect
 * a fatal condition mid-flight and need to record the error type before
 * unwinding via DreamFatalError. We swallow service errors because the
 * dream may already be in a terminal state.
 */
export async function markFailedSafely(
  services: DreamPipelineServices,
  tenantId: string,
  dreamId: string,
  error: DreamError,
  usage?: DreamUsage,
): Promise<DreamRow | null> {
  try {
    return await services.dreams.markFailed({
      tenantId,
      dreamId,
      error,
      usage,
    });
  } catch {
    return services.dreams.get({ tenantId, dreamId });
  }
}
