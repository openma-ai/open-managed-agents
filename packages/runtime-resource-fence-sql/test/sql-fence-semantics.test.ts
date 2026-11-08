import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { RuntimeResourceFence } from "@open-managed-agents/runtime-resource-contract";

import { ensureRuntimeResourceFenceSchema, SqlRuntimeResourceFencePort } from "../src/index";

// Characterization of the Environment Work publication fence (ADR 0005):
// expiry boundary, takeover, failed renewal and the publication pointer CAS.
// Any later move of this fence must keep these results.

const scope = { workspaceId: "w", environmentId: "e", sessionId: "s", workId: "x" };
const TTL = 90_000;
const candidate = (id: string) => ({ workspaceCandidate: { id, contentHash: `sha256:${id}` }, outputCandidate: null });

async function setup() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureRuntimeResourceFenceSchema(sql);
  const clock = { now: Date.parse("2026-11-09T00:00:00.000Z") };
  let token = 0;
  const fences = new SqlRuntimeResourceFencePort(sql, { now: () => new Date(clock.now), nextToken: () => `token_${++token}` });
  const acquire = async (ownerId: string) => {
    const result = await fences.acquire({ scope, ownerId, ttlMs: TTL });
    if (result.type !== "acquired") throw new Error("expected acquired");
    return result;
  };
  return { fences, clock, acquire };
}

describe("fence expiry", () => {
  it("is live one millisecond before expiry and gone exactly at it", async () => {
    const { fences, clock, acquire } = await setup();
    const { fence } = await acquire("a");
    clock.now += TTL - 1;
    expect(await fences.isCurrent(fence)).toBe(true);
    await expect(fences.acquire({ scope, ownerId: "b", ttlMs: TTL })).resolves.toEqual({ type: "conflict", expiresAt: fence.expiresAt });
    clock.now += 1;
    expect(await fences.isCurrent(fence)).toBe(false);
    await expect(fences.renew({ fence, ttlMs: TTL })).resolves.toEqual({ type: "lost" });
    await expect(fences.publish({ fence, ...candidate("late") })).resolves.toEqual({ type: "lost" });
    await expect(acquire("b")).resolves.toMatchObject({ fence: { ownerId: "b", generation: 2 } });
  });

  it("checks the stored expiry, not the expiry the caller's fence carries", async () => {
    const { fences, clock, acquire } = await setup();
    const { fence } = await acquire("a");
    const claim: RuntimeResourceFence = { ...fence, expiresAt: new Date(0).toISOString() };
    expect(await fences.isCurrent(claim)).toBe(true);
    clock.now += TTL;
    expect(await fences.isCurrent({ ...fence, expiresAt: "2999-01-01T00:00:00.000Z" })).toBe(false);
  });
});

describe("fence takeover", () => {
  it("lets the live owner re-acquire without a new generation, token or expiry", async () => {
    const { clock, acquire } = await setup();
    const first = await acquire("a");
    clock.now += 10_000;
    const again = await acquire("a");
    expect(again.fence).toEqual(first.fence);
  });

  it("gives the same owner a new generation and token after expiry", async () => {
    const { clock, acquire } = await setup();
    const first = await acquire("a");
    clock.now += TTL;
    const second = await acquire("a");
    expect(second.fence.generation).toBe(2);
    expect(second.fence.token).not.toBe(first.fence.token);
  });

  it("fences every operation of the previous generation after a takeover", async () => {
    const { fences, clock, acquire } = await setup();
    const old = await acquire("a");
    clock.now += TTL;
    const current = await acquire("b");
    expect(await fences.isCurrent(old.fence)).toBe(false);
    await expect(fences.renew({ fence: old.fence, ttlMs: TTL })).resolves.toEqual({ type: "lost" });
    await expect(fences.publish({ fence: old.fence, ...candidate("stale") })).resolves.toEqual({ type: "lost" });
    await fences.release({ fence: old.fence, reason: "lease_lost" });
    expect(await fences.isCurrent(current.fence)).toBe(true);
  });
});

describe("fence renewal", () => {
  it("extends from now and returns the fence with the same identity", async () => {
    const { fences, clock, acquire } = await setup();
    const { fence } = await acquire("a");
    clock.now += 30_000;
    const renewed = await fences.renew({ fence, ttlMs: TTL });
    expect(renewed).toEqual({ type: "renewed", fence: { ...fence, expiresAt: new Date(clock.now + TTL).toISOString() } });
  });

  it("does not revive an expired fence or accept a wrong token", async () => {
    const { fences, clock, acquire } = await setup();
    const { fence } = await acquire("a");
    await expect(fences.renew({ fence: { ...fence, token: "wrong" }, ttlMs: TTL })).resolves.toEqual({ type: "lost" });
    clock.now += TTL;
    await expect(fences.renew({ fence, ttlMs: TTL })).resolves.toEqual({ type: "lost" });
    expect(await fences.isCurrent(fence)).toBe(false);
  });
});

describe("publication pointer CAS", () => {
  it("keeps the revision for an identical retry and advances it for a change", async () => {
    const { fences, acquire } = await setup();
    const { fence } = await acquire("a");
    await expect(fences.publish({ fence, ...candidate("one") })).resolves.toEqual({ type: "published", revision: 1 });
    await expect(fences.publish({ fence, ...candidate("one") })).resolves.toEqual({ type: "published", revision: 1 });
    await expect(fences.publish({ fence, ...candidate("two") })).resolves.toEqual({ type: "published", revision: 2 });
  });

  it("hands the last publication to the next generation, which advances it even for equal content", async () => {
    const { fences, clock, acquire } = await setup();
    const old = await acquire("a");
    await fences.publish({ fence: old.fence, ...candidate("one") });
    clock.now += TTL;
    const next = await acquire("b");
    expect(next.publication).toEqual({ generation: 1, revision: 1, ...candidate("one") });
    await expect(fences.publish({ fence: next.fence, ...candidate("one") })).resolves.toEqual({ type: "published", revision: 2 });
  });

  it("leaves the stored publication untouched when a stale generation publishes", async () => {
    const { fences, clock, acquire } = await setup();
    const old = await acquire("a");
    await fences.publish({ fence: old.fence, ...candidate("kept") });
    clock.now += TTL;
    await fences.publish({ fence: old.fence, ...candidate("stale") });
    expect((await acquire("b")).publication).toMatchObject({ workspaceCandidate: { id: "kept" }, revision: 1 });
  });

  it("survives release: the next owner takes a new generation and reads the publication", async () => {
    const { fences, acquire } = await setup();
    const first = await acquire("a");
    await fences.publish({ fence: first.fence, ...candidate("one") });
    await fences.release({ fence: first.fence, reason: "completed" });
    expect(await fences.isCurrent(first.fence)).toBe(false);
    const next = await acquire("a");
    expect(next.fence.generation).toBe(2);
    expect(next.publication).toMatchObject({ workspaceCandidate: { id: "one" } });
  });
});
