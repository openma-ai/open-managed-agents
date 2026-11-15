import { describe, expect, it } from "vitest";

import {
  MemoryRuntimeOrphanPort,
  MemoryEnvironmentWorkClaimPort,
} from "../src/testing";

const scope = {
  workspaceId: "workspace_testing",
  environmentId: "environment_testing",
  sessionId: "session_testing",
  workId: "work_testing",
};

describe("managed runtime deterministic test Ports", () => {
  it("tracks Work claims by generation and token and exposes unknown scopes", async () => {
    const claims = new MemoryEnvironmentWorkClaimPort({ now: () => new Date("2026-09-07T15:00:00.000Z") });
    const claim = claims.claim(scope);
    expect(claim).toMatchObject({ generation: 1, token: "work-token-1" });
    await expect(claims.open(claim)).resolves.toEqual({
      type: "current", expiresAt: "2026-09-07T15:01:30.000Z", publication: null,
    });
    await expect(claims.isCurrent(claim)).resolves.toBe(true);
    await expect(claims.isCurrent({ ...claim, token: "stale" })).resolves.toBe(false);
    expect(claims.inspect(scope)).toMatchObject({ generation: 1 });
    expect(claims.inspect({ ...scope, workId: "missing" })).toBeNull();
    await expect(claims.open({ ...scope, workId: "missing", generation: 1, token: "work-token-1" }))
      .resolves.toEqual({ type: "lost" });
    await expect(claims.publish({
      claim,
      workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
      outputCandidate: null,
    })).resolves.toEqual({ type: "published", revision: 1 });
    await expect(claims.publish({
      claim,
      workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
      outputCandidate: null,
      runtimeCheckpoint: {
        provider: "fake",
        checkpointId: "checkpoint",
        kind: "filesystem",
        sourceRuntimeId: "runtime",
        sessionId: scope.sessionId,
        workGeneration: 1,
        workspaceRevision: 1,
        harnessVersion: "1",
        runtimeIdentity: "runtime-identity",
      },
    })).resolves.toEqual({ type: "published", revision: 2 });

    claims.requestStop(scope);
    await expect(claims.open(claim)).resolves.toEqual({ type: "lost" });
    await expect(claims.isCurrent(claim)).resolves.toBe(true);
    const reclaimed = claims.claim(scope);
    await expect(claims.isCurrent(claim)).resolves.toBe(false);
    await expect(claims.open(reclaimed)).resolves.toMatchObject({
      type: "current", publication: { generation: 1, revision: 2 },
    });
    claims.lose(scope);
    await expect(claims.isCurrent(reclaimed)).resolves.toBe(false);
  });

  it("keeps the original expiry across reads and expires exactly at its TTL", async () => {
    let now = 1_000;
    const claims = new MemoryEnvironmentWorkClaimPort({ now: () => new Date(now), ttlMs: 1_000 });
    const claim = claims.claim(scope);
    now += 999;
    await expect(claims.open(claim)).resolves.toMatchObject({ expiresAt: new Date(2_000).toISOString() });
    now += 1;
    await expect(claims.isCurrent(claim)).resolves.toBe(false);
    await expect(claims.open(claim)).resolves.toEqual({ type: "lost" });
    await expect(claims.publish({ claim, workspaceCandidate: { id: "stale", contentHash: "stale" }, outputCandidate: null }))
      .resolves.toEqual({ type: "lost" });
  });

  it.each([999, 1_000, 1_001])("allows final drain only when stopped within the lease (elapsed=%s)", async (elapsed) => {
    let now = 1_000;
    const claims = new MemoryEnvironmentWorkClaimPort({ now: () => new Date(now), ttlMs: 1_000 });
    const claim = claims.claim(scope);
    now += elapsed;
    claims.stop(scope);
    now += 10_000;
    const publication = { claim, final: true, workspaceCandidate: { id: "final", contentHash: "final" }, outputCandidate: null };
    await expect(claims.publish(publication)).resolves.toEqual(
      elapsed <= 1_000 ? { type: "published", revision: 1 } : { type: "lost" },
    );
    await expect(claims.open(claim)).resolves.toEqual({ type: "lost" });
    await expect(claims.isCurrent(claim)).resolves.toBe(false);
    claims.claim(scope);
    await expect(claims.publish(publication)).resolves.toEqual({ type: "lost" });
  });

  it("handles metadata-free orphans, string failures, stable sorting, and missing updates", async () => {
    const orphans = new MemoryRuntimeOrphanPort();
    await orphans.enqueue({
      scope: { ...scope, workId: "z" },
      generation: 1,
      ownerId: "owner",
      sandbox: { provider: "fake", runtimeId: "runtime-z" },
      reason: "failed",
      error: "string failure",
    });
    await orphans.enqueue({
      scope: { ...scope, workId: "a" },
      generation: 1,
      ownerId: "owner",
      sandbox: {
        provider: "fake",
        runtimeId: "runtime-a",
        metadata: { region: "test" },
      },
      reason: "failed",
      error: new Error("error failure"),
    });

    const listed = await orphans.list({ limit: 2 });
    expect(listed).toHaveLength(2);
    expect(listed.map((record) => record.id)).toEqual(
      [...listed.map((record) => record.id)].sort(),
    );
    expect(listed.map((record) => record.lastError)).toEqual(
      expect.arrayContaining(["string failure", "error failure"]),
    );
    await expect(orphans.failed({ id: "missing", error: "ignored" }))
      .resolves.toBeUndefined();
  });
});
