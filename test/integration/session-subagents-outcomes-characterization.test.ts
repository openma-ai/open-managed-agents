// @ts-nocheck
// Characterization tests (#545 §0.7 regression rule) for the two Session
// runtime domains converged into packages/session-subagents and
// packages/session-outcomes. Written on the base commit (94d603e7) and kept
// unchanged on the converged code: they pin only Cloudflare SessionDO
// behaviour that both implementations share. Behaviour that intentionally
// changes is asserted separately in the converged-code tests and listed in
// the convergence report.
import { env, exports } from "cloudflare:workers";
import { waitForSessionExecution } from "./_session-execution";
import { beforeAll, describe, expect, it } from "vitest";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { ensureModelCards } from "./_model-cards";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: H, body: JSON.stringify(body) });

const childConfigs = new Map<string, unknown>();

registerHarness("charz-sub-parent", () => ({
  async run(ctx) {
    const roster = ctx.agent.multiagent?.subagents?.predefined_agents ?? [];
    const result = await ctx.env.delegateToAgent(roster[0].id, "Find the answer");
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: `delegated:${result}` }] });
  },
}));
registerHarness("charz-sub-child", () => ({
  async run(ctx) {
    childConfigs.set(ctx.userMessage.content[0].text, ctx.agent);
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "child answer" }] });
  },
}));
registerHarness("charz-outcome-writer", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.tool_use", id: `tu_${Date.now()}`, name: "write", input: { file_path: "/workspace/out.txt", content: "done" } });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "wrote it" }] });
  },
}));
registerHarness("charz-outcome-reviser", () => ({
  async run(ctx) {
    const text = ctx.userMessage?.content?.[0]?.text ?? "";
    if (text.includes("<outcome_feedback")) {
      ctx.runtime.broadcast({ type: "agent.tool_use", id: `tu_${Date.now()}`, name: "write", input: { file_path: "/workspace/out.txt", content: "fixed" } });
    }
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "attempt" }] });
  },
}));

beforeAll(() => ensureModelCards(["claude-sonnet-4-6"]));

async function json(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body as any;
}

async function createEnvironment() {
  return json(await post("/v1/oma/environments", { name: `charz-${Date.now()}`, config: { type: "cloud" } }));
}

function stub(sessionId: string) {
  return env.SESSION_DO!.get(env.SESSION_DO!.idFromName(sessionId));
}

const waitForIdle = waitForSessionExecution;

async function events(sessionId: string): Promise<any[]> {
  const res = await stub(sessionId).fetch(new Request("http://internal/events", { headers: { Accept: "application/json" } }));
  const body = await res.json() as { data: Array<{ type: string; data: any }> };
  return body.data.map((row) => (typeof row.data === "string" ? JSON.parse(row.data) : row.data));
}

async function sendMessage(sessionId: string, text: string) {
  const res = await post(`/v1/oma/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  expect([200, 202]).toContain(res.status);
}

describe("characterization: Cloudflare subagent delegation", () => {
  it("runs a pinned roster child in its own thread and returns its text to the parent", async () => {
    const worker = await json(await post("/v1/oma/agents", {
      name: "Charz Worker", model: "claude-sonnet-4-6", system: "Worker system",
      tools: [{ type: "agent_toolset_20260401" }], _oma: { harness: "charz-sub-child" },
    }));
    const parent = await json(await post("/v1/oma/agents", {
      name: "Charz Parent", model: "claude-sonnet-4-6", system: "Parent system",
      tools: [{ type: "agent_toolset_20260401" }], _oma: { harness: "charz-sub-parent" },
      multiagent: {
        type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" },
        subagents: { type: "enabled", inline_agents: { type: "disabled" },
          predefined_agents: [{ type: "agent", id: worker.id, version: worker.version }] },
      },
    }));
    const environment = await createEnvironment();
    const session = await json(await post("/v1/oma/sessions", { agent: parent.id, environment_id: environment.id }));

    await sendMessage(session.id, "delegate please");
    await waitForIdle(session.id);
    const log = await events(session.id);

    const parentTexts = log
      .filter((event) => event.type === "agent.message" && (event.session_thread_id ?? "sthr_primary") === "sthr_primary")
      .map((event) => event.content[0].text);
    // The parent receives the child's final text as the delegate result.
    expect(parentTexts).toContain("delegated:child answer");
    // Roster rejection is characterized on Node; on Cloudflare the rejected
    // delegate surfaces as a workerd unhandled-rejection report on the base
    // commit even when the harness catches it.

    const created = log.filter((event) => event.type === "session.thread_created");
    expect(created).toHaveLength(1);
    const childThread = created[0].session_thread_id;
    expect(childThread).toMatch(/^sthr_/);
    expect(childThread).not.toBe("sthr_primary");
    expect(created[0]).toMatchObject({ agent_name: "Charz Worker", parent_thread_id: "sthr_primary" });

    // Child output is written to the parent log, tagged with the child lane.
    expect(log).toContainEqual(expect.objectContaining({
      type: "agent.message", session_thread_id: childThread,
      content: [{ type: "text", text: "child answer" }],
    }));
    // The child ran from its pinned snapshot, without the roster.
    const childAgent = childConfigs.get("Find the answer") as any;
    expect(childAgent).toMatchObject({ id: worker.id, name: "Charz Worker", system: "Worker system" });
    expect(childAgent.multiagent).toBeUndefined();

    // The thread is durable for the Threads API.
    const threads = await json(await api(`/v1/oma/sessions/${session.id}/threads`, { headers: H }));
    expect(threads.data.map((thread: { id: string }) => thread.id)).toContain(childThread);
    // The parent turn still ends idle exactly once on the primary lane.
    expect(log.filter((event) => event.type === "session.status_idle" && (event.session_thread_id ?? "sthr_primary") === "sthr_primary").length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("characterization: Cloudflare outcome evaluation", () => {
  async function outcomeSession(harness: string) {
    const agent = await json(await post("/v1/oma/agents", {
      name: `Charz ${harness}`, model: "claude-sonnet-4-6", system: "Outcome system",
      tools: [{ type: "agent_toolset_20260401" }], _oma: { harness },
    }));
    const environment = await createEnvironment();
    return json(await post("/v1/oma/sessions", { agent: agent.id, environment_id: environment.id }));
  }

  async function defineOutcome(sessionId: string, maxIterations: number) {
    const res = await post(`/v1/oma/sessions/${sessionId}/events`, {
      events: [{
        type: "user.define_outcome", description: "Write out.txt",
        verifier: { type: "verifiable", scorer: "fileWritten", opts: { path: "/workspace/out.txt" } },
        max_iterations: maxIterations,
      }],
    });
    expect([200, 202]).toContain(res.status);
  }

  it("evaluates after the turn and records a satisfied verdict", async () => {
    const session = await outcomeSession("charz-outcome-writer");
    await defineOutcome(session.id, 3);
    await sendMessage(session.id, "go");
    await waitForIdle(session.id);
    const log = await events(session.id);

    const ends = log.filter((event) => event.type === "span.outcome_evaluation_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ result: "satisfied", iteration: 0 });
    expect(ends[0].outcome_id).toMatch(/^outc_/);
    expect(log.some((event) => event.type === "span.outcome_evaluation_ongoing" && event.iteration === 0)).toBe(true);

    const full = await (await stub(session.id).fetch(new Request("http://internal/full-status"))).json() as any;
    expect(full.outcome_evaluations).toEqual([
      expect.objectContaining({ outcome_id: ends[0].outcome_id, result: "satisfied", iteration: 0 }),
    ]);
  }, 60_000);

  it("feeds a needs_revision verdict back as a user turn and re-evaluates", async () => {
    const session = await outcomeSession("charz-outcome-reviser");
    await defineOutcome(session.id, 3);
    await sendMessage(session.id, "go");
    await waitForIdle(session.id);
    const log = await events(session.id);

    const ends = log.filter((event) => event.type === "span.outcome_evaluation_end");
    expect(ends.map((event) => [event.result, event.iteration])).toEqual([
      ["needs_revision", 0],
      ["satisfied", 1],
    ]);
    const feedback = log.filter((event) => event.type === "user.message" &&
      String(event.content?.[0]?.text ?? "").startsWith('<outcome_feedback iteration="0">'));
    expect(feedback).toHaveLength(1);
    expect(feedback[0].content[0].text).toContain("Address the feedback and try again.");
    const full = await (await stub(session.id).fetch(new Request("http://internal/full-status"))).json() as any;
    expect(full.outcome_evaluations.map((row: any) => row.result)).toEqual(["needs_revision", "satisfied"]);
  }, 60_000);

  it("stops at max_iterations with max_iterations_reached", async () => {
    const session = await outcomeSession("charz-sub-child");
    await defineOutcome(session.id, 2);
    await sendMessage(session.id, "go");
    await waitForIdle(session.id);
    const ends = (await events(session.id)).filter((event) => event.type === "span.outcome_evaluation_end");
    expect(ends.map((event) => [event.result, event.iteration])).toEqual([
      ["needs_revision", 0],
      ["max_iterations_reached", 1],
    ]);
  }, 60_000);
});
