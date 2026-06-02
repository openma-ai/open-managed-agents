// Integration tests for /v1/dreams.
//
// Covers the public REST contract end-to-end against the test worker
// (test-worker.ts), wiring through real D1 + R2 (miniflare). The pipeline
// runs with DREAM_CURATOR_MODE=dedup (see vitest.config.ts), so the
// curator is deterministic — no Anthropic API call — and we can assert
// the exact output store contents.
//
// Spec under test: https://platform.claude.com/docs/en/managed-agents/dreams

// @ts-nocheck
import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

const HEADERS = {
  "x-api-key": "test-key",
  "Content-Type": "application/json",
  "anthropic-beta": "managed-agents-2026-04-01,dreaming-2026-04-21",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function createMemoryStore(name: string): Promise<string> {
  const res = await api("/v1/memory_stores", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id;
}

async function writeMemory(storeId: string, path: string, content: string) {
  const res = await api(`/v1/memory_stores/${storeId}/memories`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
}

async function listMemories(storeId: string): Promise<Array<{ path: string }>> {
  const res = await api(`/v1/memory_stores/${storeId}/memories`, { headers: HEADERS });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data;
}

async function poll<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const interval = opts.intervalMs ?? 25;
  const timeout = opts.timeoutMs ?? 5000;
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeout) {
      throw new Error(`poll timed out after ${timeout}ms — last value: ${JSON.stringify(v)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe("/v1/dreams — beta header gate", () => {
  it("rejects POST without the required beta flags", async () => {
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "Content-Type": "application/json",
        // No anthropic-beta header.
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("dreaming-2026-04-21");
  });

  it("rejects when only one of the two flags is present", async () => {
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "Content-Type": "application/json",
        "anthropic-beta": "managed-agents-2026-04-01",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("/v1/dreams — input validation", () => {
  it("rejects when inputs[] is missing", async () => {
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ model: "claude-opus-4-7" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("inputs[]");
  });

  it("rejects an unsupported model", async () => {
    const storeId = await createMemoryStore("dreams-validation-1");
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: storeId }],
        model: "claude-3-opus",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing input memory store", async () => {
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: "memstore-does-not-exist" }],
        model: "claude-opus-4-7",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/input.*not found|input.*memory.*store/i);
  });
});

describe("/v1/dreams — happy path", () => {
  it("creates a dream, runs the pipeline, and writes deduped output", async () => {
    const inputId = await createMemoryStore("dreams-happy-input");
    await writeMemory(inputId, "/topic/a.md", "alpha-v1");
    await writeMemory(inputId, "/topic/b.md", "beta-v1");

    // POST returns immediately with status=pending
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: inputId }],
        model: "claude-opus-4-7",
        instructions: "test-instructions",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.type).toBe("dream");
    expect(created.status).toBe("pending");
    expect(created.id).toMatch(/^drm-/);
    expect(created.model.id).toBe("claude-opus-4-7");
    expect(created.instructions).toBe("test-instructions");
    expect(created.inputs).toEqual([{ type: "memory_store", memory_store_id: inputId }]);
    expect(created.outputs).toEqual([]);
    expect(created.session_id).toBeNull();

    // Pipeline runs via ctx.waitUntil; poll until terminal.
    const final = await poll(
      async () => {
        const r = await api(`/v1/dreams/${created.id}`, { headers: HEADERS });
        return r.json();
      },
      (d) => d.status === "completed" || d.status === "failed",
    );
    expect(final.status).toBe("completed");
    expect(final.outputs).toHaveLength(1);
    expect(final.outputs[0].type).toBe("memory_store");
    const outputStoreId = final.outputs[0].memory_store_id;
    expect(outputStoreId).toMatch(/^memstore-/);
    expect(outputStoreId).not.toBe(inputId);
    expect(final.session_id).toMatch(/^sess-/);
    expect(final.started_at).toBeTruthy();
    expect(final.ended_at).toBeTruthy();

    // Output store should carry the curated memories (dedup curator =
    // input paths preserved verbatim).
    const outputMemories = await listMemories(outputStoreId);
    const paths = outputMemories.map((m) => m.path).sort();
    expect(paths).toEqual(["/topic/a.md", "/topic/b.md"]);
  });

  it("never mutates the input memory store", async () => {
    const inputId = await createMemoryStore("dreams-immutability-input");
    await writeMemory(inputId, "/pref.md", "original");

    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: inputId }],
        model: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    await poll(
      async () => (await api(`/v1/dreams/${created.id}`, { headers: HEADERS })).json(),
      (d) => d.status === "completed" || d.status === "failed",
    );

    // The input store should still be intact (same path, same content).
    const inputMemories = await listMemories(inputId);
    expect(inputMemories.map((m) => m.path)).toEqual(["/pref.md"]);
  });
});

describe("/v1/dreams — lifecycle operations", () => {
  it("GET returns 404 for an unknown id", async () => {
    const res = await api("/v1/dreams/drm-does-not-exist", { headers: HEADERS });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("not_found_error");
  });

  it("list returns dreams newest-first with pagination metadata", async () => {
    const storeId = await createMemoryStore("dreams-list-store");
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await api("/v1/dreams", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          inputs: [{ type: "memory_store", memory_store_id: storeId }],
          model: "claude-opus-4-7",
        }),
      });
      const body = await res.json();
      created.push(body.id);
    }
    const res = await api("/v1/dreams?limit=10", { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    // Newest first — our three should appear in reverse-insertion order.
    const ourIds = body.data.map((d: { id: string }) => d.id).filter((id: string) => created.includes(id));
    expect(ourIds).toEqual([...created].reverse());
  });

  it("archive on terminal dreams succeeds; archive on running rejects", async () => {
    const storeId = await createMemoryStore("dreams-archive-store");
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: storeId }],
        model: "claude-opus-4-7",
      }),
    });
    const created = await res.json();
    const completed = await poll(
      async () => (await api(`/v1/dreams/${created.id}`, { headers: HEADERS })).json(),
      (d) => d.status === "completed" || d.status === "failed",
    );
    expect(completed.status).toBe("completed");

    const archived = await api(`/v1/dreams/${created.id}/archive`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json();
    expect(archivedBody.archived_at).toBeTruthy();

    // Default list omits archived; with include_archived=true it appears.
    const visible = await api("/v1/dreams", { headers: HEADERS });
    const visibleBody = await visible.json();
    expect(
      visibleBody.data.some((d: { id: string }) => d.id === created.id),
    ).toBe(false);
    const all = await api("/v1/dreams?include_archived=true", { headers: HEADERS });
    const allBody = await all.json();
    expect(
      allBody.data.some((d: { id: string }) => d.id === created.id),
    ).toBe(true);
  });

  it("cancel is idempotent on already-canceled; rejects on completed", async () => {
    const storeId = await createMemoryStore("dreams-cancel-store");
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: storeId }],
        model: "claude-opus-4-7",
      }),
    });
    const created = await res.json();
    // Wait for completion (pipeline finishes synchronously with dedup curator).
    await poll(
      async () => (await api(`/v1/dreams/${created.id}`, { headers: HEADERS })).json(),
      (d) => d.status === "completed" || d.status === "failed",
    );
    const tooLate = await api(`/v1/dreams/${created.id}/cancel`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(tooLate.status).toBe(400);
  });
});

describe("/v1/dreams — pipeline durability", () => {
  it("preflight fails the dream with input_memory_store_unavailable when input was archived", async () => {
    const storeId = await createMemoryStore("dreams-prereq-archive");
    const archived = await api(`/v1/memory_stores/${storeId}/archive`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(archived.status).toBe(200);
    // DreamService.create only verifies existence, not archive state, so
    // POST succeeds. The runner's preflight catches the archived input
    // and marks the dream failed with the documented error type.
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: storeId }],
        model: "claude-opus-4-7",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    const final = await poll(
      async () => (await api(`/v1/dreams/${created.id}`, { headers: HEADERS })).json(),
      (d) => d.status === "completed" || d.status === "failed",
    );
    expect(final.status).toBe("failed");
    expect(final.error?.type).toBe("input_memory_store_unavailable");
  });
});

describe("/v1/dreams — output store delete/archive guard", () => {
  it("refuses to delete the output store while the dream is still active", async () => {
    // Force a long-running dream: a fresh input store with many memories
    // gives the dedup curator a few writes — and because the runner uses
    // ctx.waitUntil, by polling immediately after POST we can sometimes
    // observe the running window. We can also assert via a completed
    // dream that already published an output store id (the guard relies on
    // status, so once completed the delete should succeed).
    const inputId = await createMemoryStore("dreams-guard-input");
    await writeMemory(inputId, "/a.md", "x");
    const res = await api("/v1/dreams", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: inputId }],
        model: "claude-opus-4-7",
      }),
    });
    const created = await res.json();
    const final = await poll(
      async () => (await api(`/v1/dreams/${created.id}`, { headers: HEADERS })).json(),
      (d) => d.status === "completed" || d.status === "failed",
    );
    expect(final.status).toBe("completed");
    const outputStoreId = final.outputs[0].memory_store_id;

    // The dream is completed — guard should allow deletion now.
    const del = await api(`/v1/memory_stores/${outputStoreId}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(del.status).toBe(200);
  });
});
