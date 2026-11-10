import { describe, expect, it } from "vitest";
import type {
  RuntimeProducedSessionEvent,
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import {
  ingestEnvironmentWorkRuntimeEvents,
  type EnvironmentWorkRuntimeIngressClaim,
} from "../src/environment-work-runtime-ingress";

const claim: EnvironmentWorkRuntimeIngressClaim = {
  workspaceId: "workspace_01",
  environmentId: "env_01",
  sessionId: "session_01",
  workId: "work_01",
  generation: 3,
};

const event = {
  id: "event_01",
  type: "session.status_running",
  processed_at: "2026-09-08T02:00:00.000Z",
};

function projection(
  handler: SessionRuntimeProjectionApplicationPort["recordSessionRuntimeEvents"],
): SessionRuntimeProjectionApplicationPort {
  return { recordSessionRuntimeEvents: handler };
}

describe("Environment Work runtime event ingress", () => {
  it("forwards raw host payload under the trusted fence and ACKs only committed canonical output", async () => {
    const payload = { type: "session.event", sessionId: claim.sessionId, turnId: "turn", event: { future: { data: [1, "two"] } } };
    let submitted: object | undefined; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const published: string[] = []; let acknowledged = false;
    const service: SessionRuntimeProjectionApplicationPort = {
      recordSessionRuntimeEvents: async () => { throw new Error("canonical path must not run"); },
      recordRawSessionRuntimeEvents: async command => { submitted = command; await gate; return { type: "recorded", events: [] }; },
    };
    const pending = ingestEnvironmentWorkRuntimeEvents({ claim, sessionId: claim.sessionId, body: { event_format: "raw", events: [{ seq: 1, event: payload }] }, projection: service, publish: async event => { published.push(event.id); } }).then(result => { acknowledged = true; return result; });
    await Promise.resolve();
    expect(acknowledged).toBe(false); expect(published).toEqual([]);
    expect(submitted).toEqual({ sessionId: claim.sessionId, events: [{ seq: 1, event: payload }], environmentWorkFence: claim });
    release(); expect(await pending).toEqual({ type: "recorded", eventIds: [] });
  });

  it("rejects malformed raw envelopes and never enters canonical fallback", async () => {
    const unused = projection(async () => { throw new Error("must not project"); });
    const event = { type: "session.complete", sessionId: claim.sessionId, turnId: "turn" };
    expect((await ingestEnvironmentWorkRuntimeEvents({claim,sessionId:claim.sessionId,body:{event_format:"raw",events:[{seq:1,event:{type:"session.event",sessionId:claim.sessionId,turnId:"turn",event:"x".repeat(1_048_577)}}]},projection:unused,publish:async()=>{throw new Error("must not publish");}})).type).toBe("invalid_request");
    for (const envelope of [{ seq: 0, event }, { seq: 1, event: { ...event, sessionId: "other" } }, { seq: 1, event: { ...event, type: "user.message" } }, { seq: 1, event, workId: "untrusted" }]) {
      expect((await ingestEnvironmentWorkRuntimeEvents({ claim, sessionId: claim.sessionId, body: { event_format: "raw", events: [envelope] }, projection: unused, publish: async () => { throw new Error("must not publish"); } })).type).toBe("invalid_request");
    }
  });
  it("rejects malformed batches and a route/session scope mismatch", async () => {
    const unused = projection(async () => {
      throw new Error("projection must not run");
    });
    const publish = async () => {
      throw new Error("publish must not run");
    };

    await expect(ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: "session_other",
      body: { events: [event] },
      projection: unused,
      publish,
    })).resolves.toEqual({ type: "forbidden" });
    await expect(ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: claim.sessionId,
      body: { events: [] },
      projection: unused,
      publish,
    })).resolves.toMatchObject({ type: "invalid_request" });
    await expect(ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: claim.sessionId,
      body: { events: [{ type: "user.message" }] },
      projection: unused,
      publish,
    })).resolves.toMatchObject({ type: "invalid_request" });
  });

  it("projects canonical events under the server-derived Work fence before publishing", async () => {
    const calls: object[] = [];
    const published: RuntimeProducedSessionEvent[] = [];
    const result = await ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: claim.sessionId,
      body: { events: [event] },
      projection: projection(async (input) => {
        calls.push(input);
        return { type: "recorded", session: {} as never };
      }),
      publish: async (value) => { published.push(value); },
    });

    expect(result).toEqual({ type: "recorded", eventIds: ["event_01"] });
    expect(calls).toEqual([{
      sessionId: "session_01",
      events: [{
        id: "event_01",
        type: "session.status_running",
        processedAt: "2026-09-08T02:00:00.000Z",
      }],
      environmentWorkFence: claim,
    }]);
    expect(published).toEqual([{
      id: "event_01",
      type: "session.status_running",
      processedAt: "2026-09-08T02:00:00.000Z",
    }]);
  });

  it("retries revision races without changing event identity or double publishing", async () => {
    const calls: object[] = [];
    const published: string[] = [];
    const result = await ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: claim.sessionId,
      body: { events: [event] },
      projection: projection(async (input) => {
        calls.push(structuredClone(input));
        return calls.length === 1
          ? { type: "version_conflict", message: "race" }
          : { type: "recorded", session: {} as never };
      }),
      publish: async (value) => { published.push(value.id); },
    });

    expect(result.type).toBe("recorded");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(published).toEqual(["event_01"]);
  });

  it("fails closed when the atomic Work fence is lost", async () => {
    let published = false;
    await expect(ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: claim.sessionId,
      body: { events: [event] },
      projection: projection(async () => ({ type: "execution_fence_lost" })),
      publish: async () => { published = true; },
    })).resolves.toEqual({ type: "stale_claim" });
    expect(published).toBe(false);
  });

  it("returns the shared keep-first collision without publishing the replay", async () => {
    let published = false;
    const collision = {
      _tag: "ProjectionEventIdCollision",
      ok: false,
      reason: "collision",
      type: "event_id_collision",
      kept: "first",
      eventIds: ["event_01"],
    } as const;
    await expect(ingestEnvironmentWorkRuntimeEvents({
      claim,
      sessionId: claim.sessionId,
      body: { events: [event] },
      projection: projection(async () => ({ ...collision, eventIds: [...collision.eventIds] })),
      publish: async () => { published = true; },
    })).resolves.toEqual(collision);
    expect(published).toBe(false);
  });
});
