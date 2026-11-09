import { beforeEach, describe, expect, it } from "vitest";
import type {
  EnvironmentWorkRecord,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlEnvironmentWorkClaimPort,
  SqlEnvironmentWorkStore,
  type EnvironmentWorkSecretCipher,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_environment_work (
  workspace_id text NOT NULL,
  environment_id text NOT NULL,
  id text NOT NULL,
  session_id text,
  document text NOT NULL,
  sealed_secret text NOT NULL,
  claim_at integer,
  claim_worker_id text,
  claim_generation integer NOT NULL DEFAULT 0,
  heartbeat_ttl_seconds integer NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  created_at integer NOT NULL,
  runtime_publication_json text,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_environment_work_workers (
  workspace_id text NOT NULL,
  environment_id text NOT NULL,
  worker_id text NOT NULL,
  last_polled_at integer NOT NULL,
  PRIMARY KEY (workspace_id, environment_id, worker_id)
);
`;

const cipher: EnvironmentWorkSecretCipher = {
  seal: async ({ plaintext }) => ({ ciphertext: `sealed:${plaintext}` }),
  open: async ({ ciphertext }) => ({ plaintext: ciphertext.slice(7) }),
};

const scope = {
  workspaceId: "workspace_01",
  environmentId: "env_self_01",
  sessionId: "session_01",
  workId: "work_01",
};

const record: EnvironmentWorkRecord = {
  work: {
    id: "work_01",
    acknowledgedAt: null,
    createdAt: "2026-08-26T09:10:00.000Z",
    data: { type: "session", id: "session_01" },
    environmentId: "env_self_01",
    latestHeartbeatAt: null,
    metadata: {},
    startedAt: null,
    state: "queued",
    stopRequestedAt: null,
    stoppedAt: null,
  },
  secret: { sessionsToken: "sk-ant-req-session-token" },
  claim: null,
  heartbeatTtlSeconds: 30,
};

const workspace = (id: string) => ({ id, contentHash: `sha256:${id}` });

describe("SqlEnvironmentWorkClaimPort", () => {
  let client: SqlClient;
  let store: SqlEnvironmentWorkStore;
  let clock: { now: number };
  let claims: SqlEnvironmentWorkClaimPort;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    store = new SqlEnvironmentWorkStore(client, cipher);
    clock = { now: Date.parse("2026-08-26T09:20:00.000Z") };
    claims = new SqlEnvironmentWorkClaimPort(client, { now: () => new Date(clock.now) });
    await store.insert({ workspaceId: scope.workspaceId, record });
  });

  async function claim(): Promise<StoredEnvironmentWork> {
    const result = await store.claimAvailable({
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
      claimedAt: new Date(clock.now).toISOString(),
      reclaimBefore: new Date(clock.now).toISOString(),
      workerId: "worker",
      heartbeatTtlSeconds: 30,
    });
    if (result.type !== "claimed") throw new Error("expected a claim");
    return result.record;
  }

  async function setState(state: StoredEnvironmentWork["work"]["state"]): Promise<void> {
    const current = (await store.find(scope))!;
    const replaced = await store.replace({
      ...scope,
      expectedRevision: current.revision,
      next: { ...current, work: { ...current.work, state } },
    });
    expect(replaced.type).toBe("replaced");
  }

  const ref = (stored: StoredEnvironmentWork) => ({
    ...scope,
    generation: stored.claim!.generation,
    token: stored.secret.sessionsToken,
  });

  it("opens the current claim and publishes an idempotent, revisioned pointer", async () => {
    const current = ref(await claim());
    await setState("starting");
    await expect(claims.open(current)).resolves.toEqual({
      type: "current",
      expiresAt: "2026-08-26T09:20:30.000Z",
      publication: null,
    });
    await expect(claims.publish({
      claim: current, workspaceCandidate: workspace("a"), outputCandidate: null,
    })).resolves.toEqual({ type: "published", revision: 1 });
    await expect(claims.publish({
      claim: current, workspaceCandidate: workspace("a"), outputCandidate: null,
    })).resolves.toEqual({ type: "published", revision: 1 });
    await expect(claims.publish({
      claim: current, workspaceCandidate: workspace("b"), outputCandidate: workspace("out"),
    })).resolves.toEqual({ type: "published", revision: 2 });
    await expect(claims.open(current)).resolves.toMatchObject({
      publication: {
        generation: 1, revision: 2,
        workspaceCandidate: workspace("b"), outputCandidate: workspace("out"),
      },
    });
  });

  it("never advances the control plane's Work revision", async () => {
    const current = ref(await claim());
    await setState("active");
    const before = (await store.find(scope))!;
    await claims.publish({ claim: current, workspaceCandidate: workspace("a"), outputCandidate: null });
    const after = (await store.find(scope))!;
    expect(after.revision).toBe(before.revision);
    // A later control-plane write keeps the pointer.
    await setState("active");
    await expect(claims.open(current)).resolves.toMatchObject({ publication: { revision: 1 } });
  });

  it("fences the previous claim after a reclaim and hands its pointer to the new one", async () => {
    const first = ref(await claim());
    await setState("active");
    await claims.publish({ claim: first, workspaceCandidate: workspace("a"), outputCandidate: null });

    clock.now += 30_001;
    const second = ref(await claim());
    expect(second.generation).toBe(2);
    await expect(claims.isCurrent(first)).resolves.toBe(false);
    await expect(claims.open(first)).resolves.toEqual({ type: "lost" });
    await expect(claims.publish({
      claim: first, workspaceCandidate: workspace("stale"), outputCandidate: null,
    })).resolves.toEqual({ type: "lost" });
    await expect(claims.open(second)).resolves.toMatchObject({
      type: "current",
      publication: { generation: 1, revision: 1, workspaceCandidate: workspace("a") },
    });
    await expect(claims.publish({
      claim: second, workspaceCandidate: workspace("a"), outputCandidate: null,
    })).resolves.toEqual({ type: "published", revision: 2 });
  });

  it("keeps a stopping claim publishable but not openable; stopped or expired is lost", async () => {
    const current = ref(await claim());
    await setState("stopping");
    await expect(claims.open(current)).resolves.toEqual({ type: "lost" });
    await expect(claims.isCurrent(current)).resolves.toBe(true);
    await expect(claims.publish({
      claim: current, workspaceCandidate: workspace("final"), outputCandidate: null,
    })).resolves.toEqual({ type: "published", revision: 1 });

    clock.now += 30_000;
    await expect(claims.isCurrent(current)).resolves.toBe(false);
    clock.now -= 30_000;
    await setState("stopped");
    await expect(claims.isCurrent(current)).resolves.toBe(false);
  });

  it("rejects mismatched scope and malformed generations", async () => {
    const current = ref(await claim());
    await expect(claims.isCurrent({ ...current, sessionId: "session_other" })).resolves.toBe(false);
    await expect(claims.isCurrent({ ...current, generation: 0 })).resolves.toBe(false);
    await expect(claims.isCurrent({ ...current, generation: 2 })).resolves.toBe(false);
  });

  it("serializes racing publications by compare-and-set", async () => {
    const current = ref(await claim());
    await setState("active");
    const results = await Promise.all(["a", "b", "c"].map((id) => claims.publish({
      claim: current, workspaceCandidate: workspace(id), outputCandidate: null,
    })));
    expect(results.map((result) => result.type === "published" ? result.revision : 0).sort())
      .toEqual([1, 2, 3]);
  });

  it("resolves the workspace's database and validates stored pointers", async () => {
    const resolved: string[] = [];
    const routed = new SqlEnvironmentWorkClaimPort((workspaceId) => {
      resolved.push(workspaceId);
      return client;
    }, { now: () => new Date(clock.now) });
    const current = ref(await claim());
    await expect(routed.isCurrent(current)).resolves.toBe(true);
    expect(resolved).toEqual([scope.workspaceId]);

    await client.prepare("UPDATE managed_environment_work SET runtime_publication_json = ?")
      .bind(JSON.stringify({ generation: 1, revision: 0, workspaceCandidate: workspace("a") }))
      .run();
    await expect(routed.open(current)).rejects.toThrow(/invalid runtime publication/u);
    expect(() => new SqlEnvironmentWorkClaimPort(client, { maxPublishAttempts: 0 }))
      .toThrow(/maxPublishAttempts/u);
  });
});
