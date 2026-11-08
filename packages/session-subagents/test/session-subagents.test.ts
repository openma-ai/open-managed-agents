import { describe, expect, it } from "vitest";
import {
  NO_SUBAGENT_OUTPUT,
  SessionSubagents,
  selectSubagent,
  type SessionSubagentsDependencies,
  type SubagentEvent,
  type SubagentFact,
  type SubagentThread,
  type SubagentTurnInput,
} from "../src/index.js";

type Agent = { name: string; system: string };
type Turn = (input: SubagentTurnInput<Agent>) => Promise<string[]>;

function fixture(options: {
  turn?: Turn;
  facts?: SubagentFact[];
  threads?: Map<string, SubagentThread<Agent>>;
  max?: number;
  admit?: (agent: Agent) => Promise<void>;
  abortSignal?: AbortSignal;
} = {}) {
  const events: SubagentEvent<Agent>[] = [];
  const threads = options.threads ?? new Map<string, SubagentThread<Agent>>();
  const turns: SubagentTurnInput<Agent>[] = [];
  let threadSeq = 0;
  let messageSeq = 0;
  const deps: SessionSubagentsDependencies<Agent> = {
    parentThreadId: "sthr_primary",
    parentAgentName: "Parent",
    abortSignal: options.abortSignal ?? new AbortController().signal,
    maxConcurrentSubagents: options.max,
    async resolveAgent(request) {
      if (request.agentId === "missing") throw new Error("Subagent is not in the roster");
      const name = request.name ?? request.agentId ?? "Inline";
      return { agentId: request.agentId ?? "general", agentName: name, agent: { name, system: request.instructions ?? "base" } };
    },
    threads: {
      async insert(thread) { threads.set(thread.id, thread); return thread; },
      async find(id) { return threads.get(id) ?? null; },
    },
    events: { async emit(event) { events.push(event); } },
    facts: { facts: () => options.facts ?? [] },
    turns: {
      async run(input) {
        turns.push(input);
        return { agentMessages: await (options.turn ?? (async () => ["done"]))(input) };
      },
    },
    ...(options.admit && { admission: { admit: ({ agent }) => options.admit!(agent) } }),
    ids: { threadId: () => `sthr_${++threadSeq}`, messageId: () => `msg_${++messageSeq}` },
  };
  return { subagents: new SessionSubagents(deps), events, threads, turns };
}

const types = (events: SubagentEvent<Agent>[]) => events.map((event) => event.type);

describe("SessionSubagents", () => {
  it("delegates to a child and returns its last agent message", async () => {
    const f = fixture({ turn: async () => ["thinking", "final answer"] });
    await expect(f.subagents.delegate({ agentId: "worker", message: "Find it" })).resolves.toBe("final answer");

    expect(types(f.events)).toEqual(["thread_created", "message_sent", "message_received", "thread_running", "thread_idle"]);
    expect(f.events[0]).toMatchObject({ thread: { id: "sthr_1", parentThreadId: "sthr_primary", agentId: "worker", agentName: "worker" } });
    expect(f.events[1]).toMatchObject({ id: "msg_1", fromThreadId: "sthr_primary", toThreadId: "sthr_1", text: "Find it" });
    expect(f.events[2]).toMatchObject({ fromMessageId: "msg_1", fromAgentName: "Parent" });
    expect(f.events[4]).toMatchObject({ stopReason: "end_turn", interrupted: false });
    expect(f.turns[0]).toMatchObject({ message: { id: "msg_1", text: "Find it" } });
  });

  it("returns the placeholder when the child produced no text", async () => {
    const f = fixture({ turn: async () => [] });
    await expect(f.subagents.delegate({ agentId: "worker", message: "Quiet" })).resolves.toBe(NO_SUBAGENT_OUTPUT);
  });

  it("rejects a roster miss before any thread or event exists", async () => {
    const f = fixture();
    await expect(f.subagents.delegate({ agentId: "missing", message: "x" })).rejects.toThrow(/roster/);
    expect(f.events).toEqual([]);
    expect(f.threads.size).toBe(0);
  });

  it("denies a thread start through admission before the thread is stored", async () => {
    const f = fixture({ admit: async () => { throw new Error("denied"); } });
    await expect(f.subagents.create({ agentId: "worker", message: "x" })).rejects.toThrow("denied");
    expect(f.threads.size).toBe(0);
  });

  it("scopes a child failure to its thread and fails the delegate call", async () => {
    const f = fixture({ turn: async () => { throw new Error("child provider failed"); } });
    await expect(f.subagents.delegate({ agentId: "worker", message: "x" })).rejects.toThrow("Subagent sthr_1 failed: child provider failed");
    expect(f.events.find((event) => event.type === "thread_error")).toEqual({ type: "thread_error", threadId: "sthr_1", message: "child provider failed" });
    expect(f.events.at(-1)).toMatchObject({ type: "thread_idle", stopReason: "retries_exhausted" });
  });

  it("queues input to a running child and delivers it after the current turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ turn: async ({ message }) => {
      if (message?.text === "first") await gate;
      return [`answer to ${message?.text}`];
    } });
    const child = await f.subagents.create({ agentId: "worker", message: "first" });
    await f.subagents.send({ threadId: child.threadId, message: "second" });
    release();
    const result = await f.subagents.wait({ threadIds: [child.threadId] });
    expect(result.subagents[0]).toMatchObject({ status: "completed", output: "answer to second" });
    expect(f.turns.map((turn) => turn.message?.text)).toEqual(["first", "second"]);
  });

  it("enforces the concurrency limit", async () => {
    const f = fixture({ max: 1, turn: () => new Promise(() => undefined) });
    await f.subagents.create({ agentId: "a", message: "x" });
    await expect(f.subagents.create({ agentId: "b", message: "y" })).rejects.toThrow("Subagent concurrency limit reached");
  });

  it("interrupts, closes and resumes a child", async () => {
    const f = fixture({ turn: ({ abortSignal, message }) => message?.text === "long"
      ? new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      : Promise.resolve(["resumed"]) });
    const child = await f.subagents.create({ agentId: "worker", message: "long" });
    await expect(f.subagents.interrupt({ threadId: child.threadId })).resolves.toMatchObject({ status: "interrupted" });
    expect(f.events.at(-1)).toMatchObject({ type: "thread_idle", interrupted: true });
    await expect(f.subagents.close({ threadId: child.threadId })).resolves.toMatchObject({ status: "closed" });
    await expect(f.subagents.send({ threadId: child.threadId, message: "x" })).rejects.toThrow(/closed/);
    await f.subagents.resume({ threadId: child.threadId, message: "again" });
    await expect(f.subagents.wait({ threadIds: [child.threadId] })).resolves.toMatchObject({ subagents: [{ status: "completed", output: "resumed" }] });
  });

  it("reopens a closed child without running a turn when nothing is pending", async () => {
    const f = fixture();
    const child = await f.subagents.create({ agentId: "worker" });
    await f.subagents.close({ threadId: child.threadId });
    await expect(f.subagents.resume({ threadId: child.threadId })).resolves.toMatchObject({ status: "idle" });
    expect(f.turns).toEqual([]);
  });

  it("restores a child's status, output and undelivered input from facts", async () => {
    const thread: SubagentThread<Agent> = { id: "sthr_old", parentThreadId: "sthr_primary", agentId: "worker", agentName: "Worker", agent: { name: "Worker", system: "s" }, archived: false };
    const f = fixture({
      threads: new Map([[thread.id, thread]]),
      facts: [
        { type: "message_sent", id: "m1", toThreadId: "sthr_old", text: "first" },
        { type: "message_received", threadId: "sthr_old", fromMessageId: "m1" },
        { type: "running", threadId: "sthr_old" },
        { type: "agent_message", threadId: "sthr_old", text: "old answer" },
        { type: "idle", threadId: "sthr_old", interrupted: false },
        { type: "terminated", threadId: "sthr_old" },
        { type: "message_sent", id: "m2", toThreadId: "sthr_old", text: "queued" },
      ],
      turn: async ({ message }) => [`got ${message?.text}`],
    });
    await expect(f.subagents.wait({ threadIds: ["sthr_old"] })).resolves.toMatchObject({ subagents: [{ status: "closed", output: "old answer" }] });
    await f.subagents.resume({ threadId: "sthr_old" });
    await expect(f.subagents.wait({ threadIds: ["sthr_old"] })).resolves.toMatchObject({ subagents: [{ status: "completed", output: "got queued" }] });
    expect(f.turns.map((turn) => turn.message?.id)).toEqual(["m2"]);
  });

  it("treats a restored running thread as interrupted and rejects foreign or archived threads", async () => {
    const own: SubagentThread<Agent> = { id: "sthr_a", parentThreadId: "sthr_primary", agentId: "w", agentName: "W", agent: { name: "W", system: "" }, archived: false };
    const foreign = { ...own, id: "sthr_b", parentThreadId: "sthr_other" };
    const archived = { ...own, id: "sthr_c", archived: true };
    const f = fixture({ threads: new Map([[own.id, own], [foreign.id, foreign], [archived.id, archived]]), facts: [{ type: "running", threadId: "sthr_a" }] });
    await expect(f.subagents.wait({ threadIds: ["sthr_a"] })).resolves.toMatchObject({ subagents: [{ status: "interrupted" }] });
    await expect(f.subagents.wait({ threadIds: ["sthr_b"] })).rejects.toThrow(/not found under the current parent/);
    await expect(f.subagents.wait({ threadIds: ["sthr_c"] })).rejects.toThrow(/archived/);
  });

  it("cancels running children when the parent execution aborts and drains them", async () => {
    const parent = new AbortController();
    const f = fixture({ abortSignal: parent.signal, turn: ({ abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    const child = await f.subagents.create({ agentId: "worker", message: "x" });
    expect(f.subagents.activeAbortController(child.threadId)).toBeInstanceOf(AbortController);
    parent.abort();
    await f.subagents.drain();
    expect(f.events.at(-1)).toMatchObject({ type: "thread_idle", interrupted: true });
    expect(f.events.some((event) => event.type === "thread_error")).toBe(false);
  });

  it("archives only live children", async () => {
    const f = fixture({ turn: () => new Promise(() => undefined) });
    await f.subagents.archiveThread("sthr_unknown");
    expect(f.events).toEqual([]);
  });
});

describe("selectSubagent", () => {
  const roster = { enabled: true, inlineEnabled: true, members: [{ id: "worker", agent: { name: "Worker" } }] };
  it("selects members, inline and reports each rejection kind", () => {
    expect(selectSubagent(roster, "worker")).toEqual({ type: "member", agent: { name: "Worker" } });
    expect(selectSubagent(roster, "general")).toEqual({ type: "inline" });
    expect(selectSubagent(roster, undefined)).toEqual({ type: "inline" });
    expect(selectSubagent(roster, "missing")).toEqual({ type: "not_in_roster" });
    expect(selectSubagent({ ...roster, inlineEnabled: false }, "general")).toEqual({ type: "inline_disabled" });
    expect(selectSubagent({ ...roster, enabled: false }, "worker")).toEqual({ type: "disabled" });
    expect(selectSubagent(null, "worker")).toEqual({ type: "disabled" });
  });
});
