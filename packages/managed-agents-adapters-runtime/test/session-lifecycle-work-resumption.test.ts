import { describe, expect, it } from "vitest";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import { EnvironmentWorkEnqueuerService } from "../../managed-agents-application/src/environment-work/enqueuer-application";
import { SessionSchedulingRecoveryService } from "../../managed-agents-application/src/session-events/scheduling-recovery";
import { SessionEventsApplicationService } from "../../managed-agents-application/src/session-events/application";
import { MemoryEnvironmentWorkStore } from "../../environment-work-store-memory/src";
import { MemorySessionStore } from "../../session-store-memory/src";
import { MemorySessionEventStore } from "../../session-event-store-memory/src";
import { EnvironmentAwareSessionEventDispatchRouter } from "../src/session-lifecycle-router";

const workspaceId = "workspace_resume";
const time = "2026-11-10T00:00:00.000Z";
const environment: Environment = {
  id: "env_cloud", archivedAt: null, config: { type: "cloud", networking: { type: "unrestricted" }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
  createdAt: time, updatedAt: time, description: null, metadata: {}, name: "Cloud ACP",
};
const session: Session = {
  id: "session_resume", environmentId: environment.id, archivedAt: null,
  agent: { id: "agent", description: null, mcpServers: [], model: { id: "test-model" }, multiagent: null,
    name: "ACP", skills: [], system: null, tools: [], version: 1, openma: { harness: "acp-sandbox" } },
  budget: null, createdAt: time, updatedAt: time, metadata: {}, outcomeEvaluations: [], resources: [],
  stats: {}, status: "idle", title: null, usage: {}, vaultIds: [],
};
const message = { type: "user.message" as const, content: [{ type: "text" as const, text: "next turn" }] };

async function fixture(denied = false) {
  let sessionRevision = 1;
  const works = new MemoryEnvironmentWorkStore({ sessionRevision: () => sessionRevision });
  const sessions = new MemorySessionStore();
  await sessions.insert({ workspaceId, session, initialEvents: [], resourceSecrets: [] });
  const log = new MemorySessionEventStore(sessions);
  const positions = new Map<string, { revision: number; index: number }>();
  const append = log.append.bind(log);
  log.append = async input => {
    const result = await append(input);
    if (result.type === "appended") {
      sessionRevision = input.expectedRevision + 1;
      input.events.forEach((event, index) => positions.set(event.id, { revision: sessionRevision, index }));
    }
    return result;
  };
  const execution = { find: async (input: { workspaceId: string; sessionId: string }) => {
    const found = await sessions.findCurrent(input); return found ? { ...found, environment } : null;
  } };
  const history = { loadSessionRuntimeHistory: async ({ sessionId }: { sessionId: string }) => {
    const found = (await sessions.findCurrent({ workspaceId, sessionId }))!;
    const events = await log.list({ workspaceId, sessionId, limit: 100, order: "asc" });
    return { type: "found" as const, revision: found.revision, initialEvents: [], events,
      orderedEvents: events.map(event => ({ event, position: positions.get(event.id)! })) };
  } };
  let sequence = 0;
  const enqueuer = () => new EnvironmentWorkEnqueuerService({
    workspaceId, store: works,
    credentials: { issue: async ({ workId }) => ({ type: "issued", secret: { sessionsToken: "test-" + workId, apiBaseUrl: "https://example.test" } }), bindToClaim: async ({ secret }) => ({ secret }) },
    wakeup: { notifyRunStarted: async () => {} }, clock: { now: () => new Date(time) },
    ids: { nextEnvironmentWorkId: () => "work_" + ++sequence },
  });
  const dispatch = () => EnvironmentAwareSessionEventDispatchRouter.forWorkspace(
    { sessionEventsAccepted: async () => { throw new Error("Work must not dispatch a second host brain"); } },
    () => enqueuer(),
  );
  const events = (failDispatch = false) => new SessionEventsApplicationService({
    workspaceId, store: log,
    schedulingRecovery: new SessionSchedulingRecoveryService({ workspaceId, execution, history, dispatch: dispatch() }),
    sessions: { find: async input => (await sessions.findCurrent(input))?.session ?? null },
    execution: { find: async input => { const found = await sessions.findCurrent(input); return found ? { ...found, environment } : null; } },
    stream: { async *subscribe() {} }, dispatch: failDispatch
      ? { sessionEventsAccepted: async () => { throw new Error("process lost after append before scheduling"); } }
      : dispatch(),
    workAdmission: { admit: async () => denied ? { type: "denied", status: 429, body: { error: "denied" } } : { type: "allowed" } },
    clock: { now: () => new Date(time) }, ids: { nextEventId: () => "event_" + ++sequence, nextOutcomeId: () => "outcome_" + ++sequence },
  });
  const list = () => works.list({ workspaceId, environmentId: environment.id, limit: 100 });
  return { works, sessions, log, enqueuer, dispatch, events, list };
}

// These regression tests intentionally exercise the actual stores and applications,
// not a fake ensure implementation. They are local component tests, not cloud certification.
describe("cloud ACP Session Work resumption", () => {
  it.each(["stopping", "stopped"] as const)("gives new input a fresh claimable Work after interrupt leaves the old Work %s", async state => {
    const f = await fixture();
    const first = await f.enqueuer().enqueue({ workspaceId, environment, session });
    expect(first.type).toBe("queued");
    if (first.type !== "queued") throw new Error("expected initial Work");
    const location = { workspaceId, environmentId: environment.id, workId: first.work.id };
    const old = (await f.works.find(location))!;
    await f.works.replace({ ...location, expectedRevision: old.revision, next: {
      ...old, work: { ...old.work, state: "active", startedAt: time, acknowledgedAt: time },
      claim: { claimedAt: time, workerId: "old-worker", generation: 1 },
    } });
    await f.events().sendSessionEvents({ sessionId: session.id, events: [{ type: "user.interrupt" }] });
    const stopping = (await f.works.find(location))!;
    expect(stopping.work.state).toBe("stopping");
    if (state === "stopped") await f.works.replace({ ...location, expectedRevision: stopping.revision,
      next: { ...stopping, work: { ...stopping.work, state, stoppedAt: time }, claim: null } });
    const before = await f.works.find(location);

    const accepted = await f.events().sendSessionEvents({ sessionId: session.id, events: [message] });
    expect(accepted).toMatchObject({ type: "accepted", events: [{ processedAt: null }] });
    const claim = await f.works.claimAvailable({ workspaceId, environmentId: environment.id,
      workerId: "new-worker", claimedAt: time, reclaimBefore: "2026-11-09T00:00:00.000Z", heartbeatTtlSeconds: 90 });
    expect(claim.type).toBe("claimed");
    if (claim.type !== "claimed") throw new Error("new input has no consumer");
    expect(claim.record.work.id).not.toBe(first.work.id);
    expect(await f.works.find(location)).toEqual(before);
  });

  it("preserves the idle RA receipt without stopping its parked Work", async () => {
    const f = await fixture();
    await f.enqueuer().enqueue({ workspaceId, environment, session });
    await f.log.append({ workspaceId, sessionId: session.id, expectedRevision: 1, nextSession: session,
      events: [{ id: "ra", type: "session.status_idle", processedAt: time, stopReason: { type: "requires_action", eventIds: ["tool"] } }] as never });
    const before = await f.list();
    expect(await f.events().sendSessionEvents({ sessionId: session.id, events: [{ type: "user.interrupt" }] }))
      .toMatchObject({ type: "accepted", events: [{ type: "user.interrupt", environmentWorkId: null }] });
    expect(await f.list()).toEqual(before);
  });

  it("recovers only scheduling after append succeeds and dispatch is lost", async () => {
    const f = await fixture();
    const command = { sessionId: session.id, idempotencyKey: "append-crash", events: [message] };
    await expect(f.events(true).sendSessionEvents(command)).rejects.toThrow("process lost");
    const before = await f.log.list({ workspaceId, sessionId: session.id, limit: 100, order: "asc" });
    expect(before).toMatchObject([{ processedAt: null }]);
    expect(await f.list()).toEqual([]);
    expect(await f.events().sendSessionEvents(command)).toMatchObject({ type: "accepted" });
    expect(await f.log.list({ workspaceId, sessionId: session.id, limit: 100, order: "asc" })).toEqual(before);
    expect(await f.list()).toHaveLength(1);
  });

  it("does not wake Work for a standalone system message (main execution semantics)", async () => {
    const f = await fixture();
    await f.events().sendSessionEvents({ sessionId: session.id, events: [{ type: "system.message", content: [] }] });
    expect(await f.list()).toEqual([]);
  });

  it("two independent input applications retain one consumer for the whole Session", async () => {
    const f = await fixture();
    const responses = await Promise.all([
      f.events().sendSessionEvents({ sessionId: session.id, events: [message] }),
      f.events().sendSessionEvents({ sessionId: session.id, events: [message] }),
    ]);
    expect(responses.map(result => result.type)).toEqual(["accepted", "accepted"]);
    expect(await f.list()).toHaveLength(1);
    const initial = await f.list();
    await f.events().sendSessionEvents({ sessionId: session.id, events: [message] });
    expect(await f.list()).toEqual(initial);
    expect(await f.log.list({ workspaceId, sessionId: session.id, limit: 100, order: "asc" }))
      .toMatchObject([{ processedAt: null }, { processedAt: null }, { processedAt: null }]);
  });

  it("two independent enqueuers ensure one Session consumer rather than one Work per input", async () => {
    const f = await fixture();
    const [left, right] = await Promise.all([
      f.enqueuer().enqueue({ workspaceId, environment, session }),
      f.enqueuer().enqueue({ workspaceId, environment, session }),
    ]);
    expect(left.type).toBe("queued");
    expect(right.type).toBe("queued");
    expect(await f.list()).toHaveLength(1);
    expect(left).toEqual(right);
  });

  it("null-target interrupt neither creates Work nor stops a later Work on retry", async () => {
    const f = await fixture();
    const command = { sessionId: session.id, idempotencyKey: "idle-interrupt", events: [{ type: "user.interrupt" as const }] };
    expect(await f.events().sendSessionEvents(command)).toMatchObject({ type: "accepted", events: [{ environmentWorkId: null }] });
    expect(await f.list()).toEqual([]);
    await f.enqueuer().enqueue({ workspaceId, environment, session });
    const before = await f.list();
    await f.events().sendSessionEvents(command);
    expect(await f.list()).toEqual(before);
  });

  it("denied input never appends input or creates Work", async () => {
    const f = await fixture(true);
    expect(await f.events().sendSessionEvents({ sessionId: session.id, events: [message] })).toMatchObject({ type: "admission_denied" });
    expect(await f.list()).toEqual([]);
    expect(await f.log.list({ workspaceId, sessionId: session.id, limit: 100, order: "asc" })).toEqual([]);
  });

  it("enqueue rejects a foreign workspace or archived Session without creating Work", async () => {
    const f = await fixture();
    expect(await f.enqueuer().enqueue({ workspaceId: "other", environment, session })).toMatchObject({ type: "rejected" });
    expect(await f.enqueuer().enqueue({ workspaceId, environment, session: { ...session, archivedAt: time } })).toMatchObject({ type: "rejected" });
    expect(await f.list()).toEqual([]);
  });
});
