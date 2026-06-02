// Unit tests for DreamService. Drives the service against in-memory ports
// and asserts the lifecycle contract: pending → running → terminal, plus
// the route-layer's expectations on cancel/archive idempotency and on
// reverse lookups used to guard memory-store archive/delete.

import { describe, it, expect } from "vitest";
import {
  DreamInputMemoryStoreMissingError,
  DreamInputSessionMissingError,
  DreamInvalidInputError,
  DreamInvalidStateError,
  DreamNotFoundError,
  MAX_DREAM_INSTRUCTIONS_CHARS,
  MAX_SESSIONS_PER_DREAM,
} from "@open-managed-agents/dreams-store";
import { createInMemoryDreamService } from "@open-managed-agents/dreams-store/test-fakes";

const TENANT = "tenant-1";
const STORE = "memstore-1";
const SESSION_A = "sess-a";
const SESSION_B = "sess-b";

function setup() {
  return createInMemoryDreamService({
    knownMemoryStores: new Set([STORE]),
    knownSessions: new Set([SESSION_A, SESSION_B]),
  });
}

describe("DreamService.create", () => {
  it("creates a dream with status=pending and a fresh id", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [SESSION_A, SESSION_B],
      model: "claude-opus-4-7",
      instructions: "focus on coding-style preferences",
    });
    expect(dream.status).toBe("pending");
    expect(dream.id).toMatch(/^drm-/);
    expect(dream.output_memory_store_id).toBeNull();
    expect(dream.session_id).toBeNull();
    expect(dream.input_memory_store_id).toBe(STORE);
    expect(dream.input_session_ids).toEqual([SESSION_A, SESSION_B]);
    expect(dream.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("rejects an unsupported model", async () => {
    const { service } = setup();
    await expect(
      service.create({
        tenantId: TENANT,
        inputMemoryStoreId: STORE,
        inputSessionIds: [],
        // @ts-expect-error — deliberately invalid
        model: "claude-haiku-4-5",
      }),
    ).rejects.toBeInstanceOf(DreamInvalidInputError);
  });

  it("rejects instructions exceeding the max char cap", async () => {
    const { service } = setup();
    await expect(
      service.create({
        tenantId: TENANT,
        inputMemoryStoreId: STORE,
        inputSessionIds: [],
        model: "claude-opus-4-7",
        instructions: "x".repeat(MAX_DREAM_INSTRUCTIONS_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(DreamInvalidInputError);
  });

  it("rejects more than MAX_SESSIONS_PER_DREAM session ids", async () => {
    const { service } = setup();
    await expect(
      service.create({
        tenantId: TENANT,
        inputMemoryStoreId: STORE,
        inputSessionIds: Array.from({ length: MAX_SESSIONS_PER_DREAM + 1 }, (_, i) => `s-${i}`),
        model: "claude-opus-4-7",
      }),
    ).rejects.toBeInstanceOf(DreamInvalidInputError);
  });

  it("rejects a missing input memory store", async () => {
    const { service } = createInMemoryDreamService({
      knownMemoryStores: new Set([]),
      knownSessions: new Set([SESSION_A]),
    });
    await expect(
      service.create({
        tenantId: TENANT,
        inputMemoryStoreId: "memstore-ghost",
        inputSessionIds: [SESSION_A],
        model: "claude-opus-4-7",
      }),
    ).rejects.toBeInstanceOf(DreamInputMemoryStoreMissingError);
  });

  it("rejects a missing input session", async () => {
    const { service } = setup();
    await expect(
      service.create({
        tenantId: TENANT,
        inputMemoryStoreId: STORE,
        inputSessionIds: [SESSION_A, "sess-ghost"],
        model: "claude-opus-4-7",
      }),
    ).rejects.toBeInstanceOf(DreamInputSessionMissingError);
  });

  it("dedupes duplicate session ids while preserving first-seen order", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [SESSION_A, SESSION_B, SESSION_A],
      model: "claude-sonnet-4-6",
    });
    expect(dream.input_session_ids).toEqual([SESSION_A, SESSION_B]);
  });
});

describe("DreamService lifecycle transitions", () => {
  it("pending → running → completed publishes ids + usage", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const running = await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: "sess-pipeline",
    });
    expect(running.status).toBe("running");
    expect(running.output_memory_store_id).toBe("memstore-out");
    expect(running.session_id).toBe("sess-pipeline");
    expect(running.started_at).toBeTruthy();

    const completed = await service.markCompleted({
      tenantId: TENANT,
      dreamId: dream.id,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 80,
      },
    });
    expect(completed.status).toBe("completed");
    expect(completed.ended_at).toBeTruthy();
    expect(completed.usage.input_tokens).toBe(100);
    expect(completed.usage.cache_read_input_tokens).toBe(80);
  });

  it("rejects markRunning from a non-pending state", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    await expect(
      service.markRunning({
        tenantId: TENANT,
        dreamId: dream.id,
        outputMemoryStoreId: "memstore-out2",
        sessionId: null,
      }),
    ).rejects.toBeInstanceOf(DreamInvalidStateError);
  });

  it("rejects markCompleted unless status === running", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await expect(
      service.markCompleted({ tenantId: TENANT, dreamId: dream.id }),
    ).rejects.toBeInstanceOf(DreamInvalidStateError);
  });

  it("markFailed records the error type + ends the dream", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const failed = await service.markFailed({
      tenantId: TENANT,
      dreamId: dream.id,
      error: { type: "timeout", message: "exceeded budget" },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ type: "timeout", message: "exceeded budget" });
    expect(failed.ended_at).toBeTruthy();
  });

  it("markFailed is idempotent for the same error type", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markFailed({
      tenantId: TENANT,
      dreamId: dream.id,
      error: { type: "timeout", message: "first" },
    });
    const second = await service.markFailed({
      tenantId: TENANT,
      dreamId: dream.id,
      error: { type: "timeout", message: "second" },
    });
    expect(second.error?.message).toBe("first");
  });

  it("markFailed rejects from a different terminal state", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    await service.markCompleted({ tenantId: TENANT, dreamId: dream.id });
    await expect(
      service.markFailed({
        tenantId: TENANT,
        dreamId: dream.id,
        error: { type: "internal_error", message: "no" },
      }),
    ).rejects.toBeInstanceOf(DreamInvalidStateError);
  });
});

describe("DreamService.cancel", () => {
  it("cancels a pending dream", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const canceled = await service.cancel({ tenantId: TENANT, dreamId: dream.id });
    expect(canceled.status).toBe("canceled");
    expect(canceled.ended_at).toBeTruthy();
  });

  it("cancels a running dream", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    const canceled = await service.cancel({ tenantId: TENANT, dreamId: dream.id });
    expect(canceled.status).toBe("canceled");
  });

  it("is idempotent on already-canceled", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.cancel({ tenantId: TENANT, dreamId: dream.id });
    const second = await service.cancel({ tenantId: TENANT, dreamId: dream.id });
    expect(second.status).toBe("canceled");
  });

  it("rejects cancel on completed", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    await service.markCompleted({ tenantId: TENANT, dreamId: dream.id });
    await expect(
      service.cancel({ tenantId: TENANT, dreamId: dream.id }),
    ).rejects.toBeInstanceOf(DreamInvalidStateError);
  });
});

describe("DreamService.archive", () => {
  it("archives a completed dream", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    await service.markCompleted({ tenantId: TENANT, dreamId: dream.id });
    const archived = await service.archive({ tenantId: TENANT, dreamId: dream.id });
    expect(archived.archived_at).toBeTruthy();
    expect(archived.status).toBe("completed");
  });

  it("rejects archiving a running dream", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    await expect(
      service.archive({ tenantId: TENANT, dreamId: dream.id }),
    ).rejects.toBeInstanceOf(DreamInvalidStateError);
  });

  it("is idempotent on already-archived", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.cancel({ tenantId: TENANT, dreamId: dream.id });
    await service.archive({ tenantId: TENANT, dreamId: dream.id });
    const second = await service.archive({ tenantId: TENANT, dreamId: dream.id });
    expect(second.archived_at).toBeTruthy();
  });
});

describe("DreamService reverse lookups", () => {
  it("findActiveDreamsByOutputStore returns only non-terminal dreams", async () => {
    const { service } = setup();
    const a = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const b = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: a.id,
      outputMemoryStoreId: "memstore-shared-output",
      sessionId: null,
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: b.id,
      outputMemoryStoreId: "memstore-shared-output",
      sessionId: null,
    });
    await service.markCompleted({ tenantId: TENANT, dreamId: b.id });

    const active = await service.findActiveDreamsByOutputStore({
      tenantId: TENANT,
      storeId: "memstore-shared-output",
    });
    expect(active.map((d) => d.id)).toEqual([a.id]);
  });

  it("storeIsLockedByActiveDream covers both input and output side", async () => {
    const { service } = setup();
    const dream = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const inputLock = await service.storeIsLockedByActiveDream({
      tenantId: TENANT,
      storeId: STORE,
    });
    expect(inputLock.locked).toBe(true);
    expect(inputLock.dreamIds).toContain(dream.id);

    await service.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: "memstore-out",
      sessionId: null,
    });
    const outputLock = await service.storeIsLockedByActiveDream({
      tenantId: TENANT,
      storeId: "memstore-out",
    });
    expect(outputLock.locked).toBe(true);

    await service.markCompleted({ tenantId: TENANT, dreamId: dream.id });
    const cleared = await service.storeIsLockedByActiveDream({
      tenantId: TENANT,
      storeId: "memstore-out",
    });
    expect(cleared.locked).toBe(false);
  });
});

describe("DreamService.findStuckRunning (cron sweep)", () => {
  it("returns running dreams older than staleAfterMs, skipping fresh + terminal", async () => {
    const { service, clock } = setup();
    // Three dreams: one stale-running, one fresh-running, one completed.
    const a = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const b = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    const c = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: a.id,
      outputMemoryStoreId: "memstore-a",
      sessionId: null,
    });
    // a is now 10 minutes old.
    clock.advance(10 * 60 * 1000);
    await service.markRunning({
      tenantId: TENANT,
      dreamId: b.id,
      outputMemoryStoreId: "memstore-b",
      sessionId: null,
    });
    await service.markRunning({
      tenantId: TENANT,
      dreamId: c.id,
      outputMemoryStoreId: "memstore-c",
      sessionId: null,
    });
    await service.markCompleted({ tenantId: TENANT, dreamId: c.id });

    const stuck = await service.findStuckRunning({ staleAfterMs: 5 * 60 * 1000 });
    expect(stuck.map((d) => d.id)).toEqual([a.id]);
  });

  it("respects the limit", async () => {
    const { service, clock } = setup();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await service.create({
        tenantId: TENANT,
        inputMemoryStoreId: STORE,
        inputSessionIds: [],
        model: "claude-opus-4-7",
      });
      await service.markRunning({
        tenantId: TENANT,
        dreamId: d.id,
        outputMemoryStoreId: `memstore-${i}`,
        sessionId: null,
      });
      created.push(d.id);
      clock.advance(1000);
    }
    clock.advance(10 * 60 * 1000);
    const stuck = await service.findStuckRunning({
      staleAfterMs: 60 * 1000,
      limit: 2,
    });
    expect(stuck).toHaveLength(2);
  });
});

describe("DreamService.get / list", () => {
  it("get returns null for an unknown id (does not throw)", async () => {
    const { service } = setup();
    const dream = await service.get({ tenantId: TENANT, dreamId: "drm-ghost" });
    expect(dream).toBeNull();
  });

  it("list orders newest-first and respects includeArchived", async () => {
    const { service, clock } = setup();
    const first = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    clock.advance(1000);
    const second = await service.create({
      tenantId: TENANT,
      inputMemoryStoreId: STORE,
      inputSessionIds: [],
      model: "claude-opus-4-7",
    });
    await service.cancel({ tenantId: TENANT, dreamId: first.id });
    await service.archive({ tenantId: TENANT, dreamId: first.id });

    const visible = await service.list({ tenantId: TENANT });
    expect(visible.items.map((d) => d.id)).toEqual([second.id]);

    const all = await service.list({ tenantId: TENANT, includeArchived: true });
    expect(all.items.map((d) => d.id)).toEqual([second.id, first.id]);
  });

  it("transitions to a terminal state throw DreamNotFoundError on missing dream", async () => {
    const { service } = setup();
    await expect(
      service.cancel({ tenantId: TENANT, dreamId: "drm-missing" }),
    ).rejects.toBeInstanceOf(DreamNotFoundError);
  });
});
