// Session subagents: child threads that share the parent's sandbox and
// execution fence, each with its own conversation.
//
// Domain package (#545 §0.7). One orchestrator for both platforms: thread
// identity, the official thread event sequence, statuses, queued input,
// interrupt/close/resume, restore from facts, concurrency and the
// `call_agent_*` delegate contract. Cloudflare SessionDO and the Node managed
// runner supply Ports: the thread store, the event sink (wire encoding), the
// thread facts for restore, and the child turn runner (harness + tools).

export type SubagentStatus =
  | "idle"
  | "running"
  | "completed"
  | "interrupted"
  | "closed"
  | "failed";

export interface SubagentState {
  threadId: string;
  status: SubagentStatus;
  /** Text of the child's last agent message. */
  output?: string;
}

export interface CreateSubagent {
  agentId?: string;
  name?: string;
  instructions?: string;
  message?: string;
  parentToolUseId?: string;
}

export interface SubagentControl {
  create(input: CreateSubagent): Promise<SubagentState>;
  send(input: { threadId: string; message: string }): Promise<SubagentState>;
  wait(input: { threadIds: string[]; timeoutMs?: number }): Promise<{ subagents: SubagentState[]; timedOut: boolean }>;
  interrupt(input: { threadId: string }): Promise<SubagentState>;
  close(input: { threadId: string }): Promise<SubagentState>;
  resume(input: { threadId: string; message?: string }): Promise<SubagentState>;
}

/** A child thread record: identity, lineage and the pinned agent snapshot. */
export interface SubagentThread<Agent> {
  id: string;
  parentThreadId: string;
  agentId: string;
  agentName: string;
  agent: Agent;
  archived: boolean;
}

/** Native thread storage owns identity and the immutable agent snapshot. */
export interface SubagentThreadStorePort<Agent> {
  insert(thread: SubagentThread<Agent>): Promise<SubagentThread<Agent>>;
  find(threadId: string): Promise<SubagentThread<Agent> | null>;
}

/** Thread-relevant facts read back from the Session event log on restore. */
export type SubagentFact =
  | { type: "message_sent"; id: string; toThreadId: string; text: string }
  | { type: "message_received"; threadId: string; fromMessageId: string | null }
  | { type: "running"; threadId: string }
  | { type: "idle"; threadId: string; interrupted: boolean }
  | { type: "error"; threadId: string }
  | { type: "terminated"; threadId: string }
  | { type: "agent_message"; threadId: string; text: string };

export interface SubagentFactsPort {
  /** Facts committed before this orchestrator started, in log order. */
  facts(): readonly SubagentFact[];
}

/** Official thread events (#545 §0.7); each platform encodes them on the wire. */
export type SubagentEvent<Agent> =
  | {
      type: "thread_created";
      thread: SubagentThread<Agent>;
      parentToolUseId?: string;
      instructions?: string;
    }
  | {
      type: "message_sent";
      id: string;
      fromThreadId: string;
      toThreadId: string;
      toAgentName: string;
      text: string;
    }
  | {
      type: "message_received";
      threadId: string;
      fromThreadId: string;
      fromAgentName: string;
      fromMessageId: string;
      text: string;
    }
  | { type: "thread_running"; threadId: string; agentName: string }
  | {
      type: "thread_idle";
      threadId: string;
      agentName: string;
      stopReason: "end_turn" | "retries_exhausted";
      interrupted: boolean;
    }
  | { type: "thread_error"; threadId: string; message: string }
  | { type: "thread_terminated"; threadId: string; agentName: string };

/** Ordered, durable event sink. Resolves once the event is committed. */
export interface SubagentEventsPort<Agent> {
  emit(event: SubagentEvent<Agent>): Promise<void>;
}

export interface SubagentTurnInput<Agent> {
  thread: SubagentThread<Agent>;
  /** The delivered input message, when the turn starts from one. */
  message?: { id: string; text: string };
  abortSignal: AbortSignal;
  /** The turn's own controller, for platform interrupt routing by thread. */
  abortController: AbortController;
}

export interface SubagentTurnResult {
  /** Text of each agent message the turn produced, in order. */
  agentMessages: string[];
}

/** Runs one child harness turn on the shared sandbox. Throws on failure. */
export interface SubagentTurnRunnerPort<Agent> {
  run(input: SubagentTurnInput<Agent>): Promise<SubagentTurnResult>;
}

export interface SubagentAdmissionPort<Agent> {
  /** Throws to deny a child thread start. */
  admit(input: { agent: Agent }): Promise<void>;
}

export interface SessionSubagentsDependencies<Agent> {
  parentThreadId: string;
  parentAgentName: string;
  /** The parent execution's signal; children never outlive it. */
  abortSignal: AbortSignal;
  /** Running children allowed at once (default 8). */
  maxConcurrentSubagents?: number;
  /** Resolve the child agent snapshot; throws on roster/policy rejection. */
  resolveAgent(request: CreateSubagent): Promise<{ agentId: string; agent: Agent; agentName: string }>;
  threads: SubagentThreadStorePort<Agent>;
  events: SubagentEventsPort<Agent>;
  facts?: SubagentFactsPort;
  turns: SubagentTurnRunnerPort<Agent>;
  admission?: SubagentAdmissionPort<Agent>;
  ids: { threadId(): string; messageId(): string };
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

interface Child<Agent> {
  thread: SubagentThread<Agent>;
  state: SubagentState;
  output?: string;
  /** Message of the last failed turn. */
  error?: string;
  controller?: AbortController;
  running?: Promise<void>;
  pending: Array<{ id: string; text: string }>;
  paused?: boolean;
}

export const NO_SUBAGENT_OUTPUT = "(sub-agent produced no text output)";

/**
 * A turn-local execution owner backed by the Session's native threads and
 * events. Child work never escapes the parent's execution.
 */
export class SessionSubagents<Agent> implements SubagentControl {
  private readonly children = new Map<string, Child<Agent>>();
  private readonly loads = new Map<string, Promise<Child<Agent>>>();
  private readonly facts: SubagentFact[];
  private pendingCreates = 0;
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionSubagentsDependencies<Agent>) {
    this.facts = [...(deps.facts?.facts() ?? [])];
  }

  /** Run one child to completion and return its final text (`call_agent_*`). */
  async delegate(input: { agentId: string; message: string }): Promise<string> {
    const child = await this.create({ agentId: input.agentId, message: input.message });
    const result = (await this.wait({ threadIds: [child.threadId] })).subagents[0]!;
    if (result.status === "failed") {
      const cause = this.children.get(child.threadId)?.error;
      throw new Error(`Subagent ${child.threadId} failed${cause ? `: ${cause}` : ""}`);
    }
    return result.output || NO_SUBAGENT_OUTPUT;
  }

  create(request: CreateSubagent): Promise<SubagentState> {
    return this.mutate(() => this.createChild(request));
  }

  send(input: { threadId: string; message: string }): Promise<SubagentState> {
    return this.mutate(() => this.sendMessage(input));
  }

  async wait(input: { threadIds: string[]; timeoutMs?: number }): Promise<{ subagents: SubagentState[]; timedOut: boolean }> {
    this.assertActive();
    if (input.threadIds.length === 0) throw new Error("At least one subagent is required");
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)) {
      throw new Error("Subagent wait timeout must be non-negative");
    }
    const children = await Promise.all(input.threadIds.map((id) => this.child(id)));
    let timedOut = false;
    if (children.every((child) => child.running !== undefined)) {
      const timers = this.deps.timers ?? globalThis;
      let timer: unknown;
      try {
        const waits = children.map((child) => child.running!);
        const timeoutMs = input.timeoutMs;
        if (timeoutMs !== undefined) {
          waits.push(new Promise<void>((resolve) => {
            timer = timers.setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
          }));
        }
        await Promise.race(waits);
      } finally {
        if (timer !== undefined) timers.clearTimeout(timer as never);
      }
    }
    return { subagents: children.map((child) => this.snapshot(child)), timedOut };
  }

  interrupt(input: { threadId: string }): Promise<SubagentState> {
    return this.mutate(() => {
      this.assertActive();
      return this.interruptChild(input);
    });
  }

  close(input: { threadId: string }): Promise<SubagentState> {
    return this.mutate(() => {
      this.assertActive();
      return this.closeChild(input);
    });
  }

  resume(input: { threadId: string; message?: string }): Promise<SubagentState> {
    return this.mutate(() => this.resumeChild(input));
  }

  /** Settle every queued operation and running child. */
  async drain(): Promise<void> {
    await this.mutations;
    await Promise.all([...this.children.values()].map((child) => child.running));
  }

  /** The application already archived the thread; only a live child stops. */
  async archiveThread(threadId: string): Promise<void> {
    if (!this.children.has(threadId)) return;
    await this.mutate(() => this.closeChild({ threadId }));
  }

  /** The abort controller of a running child (platform interrupt routing). */
  activeAbortController(threadId: string): AbortController | undefined {
    return this.children.get(threadId)?.controller;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    // `await` subscribes to the operation's promise at once: an operation that
    // rejects before its first await (assertActive / assertCapacity) is never
    // an unhandled rejection, which workerd reports even when handled later.
    const result = this.mutations.then(async () => await operation());
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertActive(): void {
    this.deps.abortSignal.throwIfAborted();
  }

  private assertCapacity(): void {
    const running = [...this.children.values()].filter((child) => child.running !== undefined).length;
    if (running + this.pendingCreates >= (this.deps.maxConcurrentSubagents ?? 8)) {
      throw new Error("Subagent concurrency limit reached");
    }
  }

  private snapshot(child: Child<Agent>): SubagentState {
    return { ...child.state };
  }

  private async emit(event: SubagentEvent<Agent>): Promise<void> {
    await this.deps.events.emit(event);
    const fact = factOf(event);
    if (fact !== null) this.facts.push(fact);
  }

  private async createChild(request: CreateSubagent): Promise<SubagentState> {
    this.assertActive();
    this.assertCapacity();
    this.pendingCreates += 1;
    try {
      const resolved = await this.deps.resolveAgent(request);
      await this.deps.admission?.admit({ agent: resolved.agent });
      this.assertActive();
      const thread = await this.deps.threads.insert({
        id: this.deps.ids.threadId(),
        parentThreadId: this.deps.parentThreadId,
        agentId: resolved.agentId,
        agentName: resolved.agentName,
        agent: resolved.agent,
        archived: false,
      });
      this.assertActive();
      const child: Child<Agent> = { thread, pending: [], state: { threadId: thread.id, status: "idle" } };
      this.children.set(thread.id, child);
      await this.emit({
        type: "thread_created",
        thread,
        ...(request.parentToolUseId !== undefined && { parentToolUseId: request.parentToolUseId }),
        ...(request.instructions !== undefined && { instructions: request.instructions }),
      });
      if (request.message !== undefined) {
        await this.enqueueMessage(child, request.message);
        this.startChild(child);
      }
      return this.snapshot(child);
    } finally {
      this.pendingCreates -= 1;
    }
  }

  private child(threadId: string): Promise<Child<Agent>> {
    const existing = this.children.get(threadId);
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = this.loads.get(threadId);
    if (pending !== undefined) return pending;
    const load = this.loadChild(threadId);
    this.loads.set(threadId, load);
    void load.finally(() => this.loads.delete(threadId)).catch(() => undefined);
    return load;
  }

  private async loadChild(threadId: string): Promise<Child<Agent>> {
    const thread = await this.deps.threads.find(threadId);
    if (thread === null || thread.parentThreadId !== this.deps.parentThreadId) {
      throw new Error(`Subagent ${threadId} was not found under the current parent`);
    }
    if (thread.archived) throw new Error(`Subagent ${threadId} is archived`);
    let status: SubagentStatus = "idle";
    let output: string | undefined;
    const delivered = new Set<string>();
    for (const fact of this.facts) {
      if (fact.type === "message_sent" || ("threadId" in fact && fact.threadId !== threadId)) continue;
      if (fact.type === "terminated") status = "closed";
      // A previous process cannot still own a turn it reported as running.
      if (fact.type === "running") status = "interrupted";
      if (fact.type === "idle") status = fact.interrupted ? "interrupted" : status === "failed" ? "failed" : "completed";
      if (fact.type === "error") status = "failed";
      if (fact.type === "agent_message") output = fact.text;
      if (fact.type === "message_received" && fact.fromMessageId) delivered.add(fact.fromMessageId);
    }
    const pending = this.facts.flatMap((fact) => fact.type === "message_sent" && fact.toThreadId === threadId && !delivered.has(fact.id)
      ? [{ id: fact.id, text: fact.text }] : []);
    const child: Child<Agent> = { thread, pending, output, state: { threadId, status, ...(output !== undefined && { output }) } };
    this.children.set(threadId, child);
    return child;
  }

  private async sendMessage(input: { threadId: string; message: string }): Promise<SubagentState> {
    this.assertActive();
    const child = await this.child(input.threadId);
    if (child.state.status === "closed") throw new Error(`Subagent ${input.threadId} is closed; resume it before sending input`);
    if (child.running === undefined) this.assertCapacity();
    await this.enqueueMessage(child, input.message);
    if (child.running === undefined) this.startChild(child);
    return this.snapshot(child);
  }

  private async enqueueMessage(child: Child<Agent>, text: string): Promise<void> {
    const id = this.deps.ids.messageId();
    await this.emit({
      type: "message_sent",
      id,
      fromThreadId: this.deps.parentThreadId,
      toThreadId: child.thread.id,
      toAgentName: child.thread.agentName,
      text,
    });
    child.pending.push({ id, text });
  }

  private startChild(child: Child<Agent>): void {
    this.assertActive();
    child.paused = false;
    const parent = this.deps.abortSignal;
    const runTurn = async (): Promise<void> => {
      const controller = new AbortController();
      child.controller = controller;
      child.state = { threadId: child.thread.id, status: "running" };
      const abortFromParent = () => controller.abort(parent.reason);
      parent.addEventListener("abort", abortFromParent, { once: true });
      try {
        const message = child.pending[0];
        if (message !== undefined) {
          await this.emit({
            type: "message_received",
            threadId: child.thread.id,
            fromThreadId: this.deps.parentThreadId,
            fromAgentName: this.deps.parentAgentName,
            fromMessageId: message.id,
            text: message.text,
          });
          child.pending.shift();
        }
        await this.emit({ type: "thread_running", threadId: child.thread.id, agentName: child.thread.agentName });
        controller.signal.throwIfAborted();
        const result = await this.deps.turns.run({
          thread: child.thread,
          ...(message !== undefined && { message }),
          abortSignal: controller.signal,
          abortController: controller,
        });
        const last = result.agentMessages.at(-1);
        if (last !== undefined) child.output = last;
        for (const text of result.agentMessages) {
          this.facts.push({ type: "agent_message", threadId: child.thread.id, text });
        }
        child.state = {
          threadId: child.thread.id,
          status: controller.signal.aborted ? "interrupted" : "completed",
          ...(child.output !== undefined && { output: child.output }),
        };
      } catch (error) {
        child.state = { threadId: child.thread.id, status: controller.signal.aborted ? "interrupted" : "failed" };
        if (!controller.signal.aborted) {
          child.error = error instanceof Error ? error.message : String(error);
          await this.emit({ type: "thread_error", threadId: child.thread.id, message: child.error });
        }
      } finally {
        parent.removeEventListener("abort", abortFromParent);
        await this.emit({
          type: "thread_idle",
          threadId: child.thread.id,
          agentName: child.thread.agentName,
          stopReason: child.state.status === "failed" ? "retries_exhausted" : "end_turn",
          interrupted: controller.signal.aborted,
        });
        child.controller = undefined;
      }
    };
    child.running = (async () => {
      do { await runTurn(); }
      while (child.pending.length > 0 && !child.paused && !parent.aborted && child.state.status !== "failed");
    })().finally(() => { child.running = undefined; });
    // A child failure is returned through its status. Persistence failures
    // still reach the parent's drain barrier, without an unhandled rejection.
    void child.running.catch(() => undefined);
  }

  private async interruptChild(input: { threadId: string }): Promise<SubagentState> {
    const child = await this.child(input.threadId);
    child.paused = true;
    child.controller?.abort();
    await child.running;
    return this.snapshot(child);
  }

  private async closeChild(input: { threadId: string }): Promise<SubagentState> {
    const child = await this.child(input.threadId);
    await this.interruptChild(input);
    if (child.state.status !== "closed") {
      await this.emit({ type: "thread_terminated", threadId: child.thread.id, agentName: child.thread.agentName });
      child.state = { ...child.state, status: "closed" };
    }
    return this.snapshot(child);
  }

  private async resumeChild(input: { threadId: string; message?: string }): Promise<SubagentState> {
    this.assertActive();
    const child = await this.child(input.threadId);
    if (child.running !== undefined) {
      if (input.message !== undefined) await this.enqueueMessage(child, input.message);
      return this.snapshot(child);
    }
    if (input.message !== undefined || child.pending.length > 0) {
      this.assertCapacity();
      if (input.message !== undefined) await this.enqueueMessage(child, input.message);
      this.startChild(child);
    } else {
      await this.emit({
        type: "thread_idle",
        threadId: child.thread.id,
        agentName: child.thread.agentName,
        stopReason: "end_turn",
        interrupted: false,
      });
      child.state = { ...child.state, status: "idle" };
    }
    return this.snapshot(child);
  }
}

function factOf<Agent>(event: SubagentEvent<Agent>): SubagentFact | null {
  switch (event.type) {
    case "message_sent":
      return { type: "message_sent", id: event.id, toThreadId: event.toThreadId, text: event.text };
    case "message_received":
      return { type: "message_received", threadId: event.threadId, fromMessageId: event.fromMessageId };
    case "thread_running":
      return { type: "running", threadId: event.threadId };
    case "thread_idle":
      return { type: "idle", threadId: event.threadId, interrupted: event.interrupted };
    case "thread_error":
      return { type: "error", threadId: event.threadId };
    case "thread_terminated":
      return { type: "terminated", threadId: event.threadId };
    case "thread_created":
      return null;
  }
}
