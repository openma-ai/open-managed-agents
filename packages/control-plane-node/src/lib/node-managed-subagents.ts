import { turnSessionBudgetGate, type SessionBudgetGate } from "@open-managed-agents/domain/sessions";
import { randomUUID } from "node:crypto";
import { withSandboxExecutionGuard, type SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  Environment,
  Session,
  SessionEventView,
  SessionThread,
  SessionWorkAdmissionPort,
} from "@open-managed-agents/managed-agents-application";
import { SessionAdmissionDeniedError } from "@open-managed-agents/shared";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import {
  SessionSubagents,
  selectSubagent,
  subagentWireFrame,
  type CreateSubagent,
  type SubagentControl,
  type SubagentEvent,
  type SubagentFact,
  type SubagentState,
  type SubagentThread,
  type SubagentTurnResult,
} from "@open-managed-agents/session-subagents";
import { ManagedNodeHarnessRuntime } from "./node-managed-harness-runtime.js";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

// Node adapter for @open-managed-agents/session-subagents (#545 §0.7): the
// orchestration (thread lifecycle, statuses, queued input, restore, delegate)
// is the shared domain implementation; this module supplies the SQL thread
// store mapping, the runtime frame encoding, the event-log facts and a child
// turn on ManagedNodeHarnessRuntime.

export type ManagedNodeCreateSubagent = CreateSubagent;
export type ManagedNodeSubagentState = SubagentState;

export interface ManagedNodeSubagentControl extends SubagentControl {
  /** Bind the parent's session egress meter so child usage snapshots report the shared total. */
  setBudgetGate?(gate: SessionBudgetGate | null): void;
}

type ChildAgent = Session["agent"];
type RosterMember = Extract<NonNullable<ChildAgent["multiagent"]>["subagents"], { type: "enabled" }>["predefinedAgents"][number];

function rosterOf(agent: ChildAgent) {
  const policy = agent.multiagent?.subagents;
  if (policy?.type !== "enabled") return null;
  return {
    enabled: true,
    inlineEnabled: policy.inlineAgents.type === "enabled",
    members: policy.predefinedAgents.flatMap((member: RosterMember) =>
      member.type === "agent" ? [{ id: member.id, agent: member }] : []),
  };
}

function memberAgent(member: RosterMember & { type: "agent" }): ChildAgent {
  const { type: _type, ...agent } = structuredClone(member);
  return { ...agent, multiagent: null } as ChildAgent;
}

export function resolveManagedSubagentSession(session: Session, request: ManagedNodeCreateSubagent): Session {
  const selection = selectSubagent(rosterOf(session.agent), request.agentId);
  switch (selection.type) {
    case "disabled": throw new Error("Subagents are disabled");
    case "not_in_roster": throw new Error("Subagent is not in the configured multiagent roster");
    case "inline_disabled": throw new Error("Inline subagents are disabled");
    case "member": return { ...session, agent: memberAgent(selection.agent as RosterMember & { type: "agent" }) };
    case "inline":
      return { ...session, agent: { ...structuredClone(session.agent), multiagent: null,
        name: request.name ?? session.agent.name,
        system: request.instructions ? `${session.agent.system}\n\n${request.instructions}` : session.agent.system } };
  }
}

/** Existing native Thread storage owns identity and the immutable agent snapshot.
 * Native events remain the source for the conversation and execution status. */
export interface ManagedNodeSubagentThreads {
  insert(input: { workspaceId: string; thread: SessionThread; executionFence?: SessionExecutionFence }): Promise<SessionThread>;
  find(input: { workspaceId: string; sessionId: string; threadId: string }): Promise<SessionThread | null>;
}

export interface ManagedNodeSubagentPolicy {
  enabled: boolean;
  maxConcurrentSubagents?: number;
}

interface SubagentsInput {
  workspaceId: string;
  session: Session;
  environment: Environment;
  parentThreadId: string;
  sandbox: SandboxExecutor;
  abortSignal: AbortSignal;
  executionFence?: SessionExecutionFence;
  historyEvents: SessionEventView[];
  threads: ManagedNodeSubagentThreads;
  policy: ManagedNodeSubagentPolicy;
  /**
   * Optional generic host admission hook for session-thread starts.
   * Omitted → admit-all. A denial fails the spawn with the hook's status/body.
   */
  threadStartAdmission?: SessionWorkAdmissionPort;
  resolveSession?(request: ManagedNodeCreateSubagent): Promise<Session>;
  run(input: { session: Session; runtime: ManagedNodeHarnessRuntime; sandbox: SandboxExecutor }): Promise<void>;
  output(frame: unknown): Promise<void>;
  clock: { now(): Date };
  ids: { nextEventId(): string };
}

export function managedEventThread(event: SessionEventView): string {
  return (event as SessionEventView & { sessionThreadId?: string | null }).sessionThreadId ?? "sthr_primary";
}

function childHistory(events: SessionEventView[]): SessionEventView[] {
  return events.map((event) => event.type === "agent.thread_message_received"
    ? { id: event.id, type: "user.message", content: event.content, processedAt: event.processedAt }
    : event);
}

function agentMessageText(event: SessionEventView): string | null {
  return event.type === "agent.message"
    ? event.content.filter((block) => block.type === "text").map((block) => block.text).join("")
    : null;
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

/** Domain facts from the Session's application events (restore after restart). */
function subagentFacts(events: SessionEventView[]): SubagentFact[] {
  return events.flatMap((event): SubagentFact[] => {
    const threadId = managedEventThread(event);
    switch (event.type) {
      case "agent.thread_message_sent":
        return [{ type: "message_sent", id: event.id, toThreadId: event.toSessionThreadId, text: textOf(event.content) }];
      case "agent.thread_message_received":
        return [{ type: "message_received", threadId, fromMessageId: event.fromMessageId ?? null }];
      case "session.thread_status_running": return [{ type: "running", threadId }];
      case "session.thread_status_idle":
        return [{ type: "idle", threadId, interrupted: Boolean((event as typeof event & { interrupted?: boolean }).interrupted) }];
      case "session.thread_status_terminated": return [{ type: "terminated", threadId }];
      case "session.error": return threadId === "sthr_primary" ? [] : [{ type: "error", threadId }];
      case "agent.message": return [{ type: "agent_message", threadId, text: agentMessageText(event)! }];
      default: return [];
    }
  });
}

/** A turn-local execution owner, backed by the Session's native threads/events.
 * Child work never escapes the parent's execution fence. */
export class ManagedNodeSubagents implements ManagedNodeSubagentControl {
  private readonly domain: SessionSubagents<Session>;
  private outputChain: Promise<void> = Promise.resolve();
  /** Per-thread application events: the child's conversation on restore. */
  private readonly threadEvents = new Map<string, SessionEventView[]>();
  private budgetGate: SessionBudgetGate | null = null;

  constructor(private readonly input: SubagentsInput) {
    for (const event of input.historyEvents) this.threadLog(managedEventThread(event)).push(event);
    this.domain = new SessionSubagents<Session>({
      parentThreadId: input.parentThreadId,
      parentAgentName: input.session.agent.name,
      abortSignal: input.abortSignal,
      maxConcurrentSubagents: input.policy.maxConcurrentSubagents,
      resolveAgent: async (request) => {
        const session = input.resolveSession !== undefined
          ? await input.resolveSession(request)
          : this.defaultSession(request);
        return { agentId: session.agent.id, agentName: session.agent.name, agent: session };
      },
      admission: { admit: ({ agent }) => this.admitThreadStart(agent) },
      threads: {
        insert: async (thread) => {
          const now = input.clock.now().toISOString();
          const { multiagent: _multiagent, ...agent } = thread.agent.agent;
          const stored = await input.threads.insert({ workspaceId: input.workspaceId,
            ...(input.executionFence !== undefined && { executionFence: input.executionFence }), thread: {
            id: thread.id, sessionId: input.session.id,
            parentThreadId: thread.parentThreadId, agent: { ...agent, type: "agent" },
            archivedAt: null, createdAt: now, updatedAt: now, stats: null, usage: null, status: "idle",
          } });
          return { ...thread, id: stored.id };
        },
        find: async (threadId) => {
          const thread = await input.threads.find({ workspaceId: input.workspaceId, sessionId: input.session.id, threadId });
          if (thread === null || thread.agent.type !== "agent") return null;
          const { type: _type, ...agent } = thread.agent;
          const session: Session = { ...input.session, agent: { ...agent, multiagent: null } };
          return {
            id: thread.id, parentThreadId: thread.parentThreadId ?? "", agentId: agent.id,
            agentName: agent.name, agent: session, archived: thread.archivedAt !== null,
          };
        },
      },
      events: { emit: (event) => this.emitEvent(event) },
      facts: { facts: () => subagentFacts(input.historyEvents) },
      turns: { run: ({ thread, abortSignal }) => this.runTurn(thread, abortSignal) },
      ids: { threadId: () => `sthr_${randomUUID()}`, messageId: () => input.ids.nextEventId() },
    });
  }

  setBudgetGate(gate: SessionBudgetGate | null): void {
    this.budgetGate = gate;
  }

  create(request: ManagedNodeCreateSubagent): Promise<ManagedNodeSubagentState> { return this.domain.create(request); }
  send(input: { threadId: string; message: string }): Promise<ManagedNodeSubagentState> { return this.domain.send(input); }
  wait(input: { threadIds: string[]; timeoutMs?: number }): Promise<{ subagents: ManagedNodeSubagentState[]; timedOut: boolean }> { return this.domain.wait(input); }
  interrupt(input: { threadId: string }): Promise<ManagedNodeSubagentState> { return this.domain.interrupt(input); }
  close(input: { threadId: string }): Promise<ManagedNodeSubagentState> { return this.domain.close(input); }
  resume(input: { threadId: string; message?: string }): Promise<ManagedNodeSubagentState> { return this.domain.resume(input); }
  delegate(input: { agentId: string; message: string }): Promise<string> { return this.domain.delegate(input); }

  async drain(): Promise<void> {
    await this.domain.drain();
    await this.outputChain;
  }

  /** The application has already archived the native Thread record. Only a
   * live execution needs cancellation; an inactive archived row is not loaded. */
  archiveThread(threadId: string): Promise<void> {
    return this.domain.archiveThread(threadId);
  }

  private threadLog(threadId: string): SessionEventView[] {
    let log = this.threadEvents.get(threadId);
    if (log === undefined) this.threadEvents.set(threadId, log = []);
    return log;
  }

  /** Generic thread-start hook; no-op when admission is omitted. */
  private async admitThreadStart(session: Session): Promise<void> {
    if (this.input.threadStartAdmission === undefined) return;
    const decision = await this.input.threadStartAdmission.admit({
      kind: "thread_start",
      workspaceId: this.input.workspaceId,
      sessionId: this.input.session.id,
      agentId: session.agent.id,
      environmentId: this.input.environment.id,
      isLocalRuntime:
        this.input.environment.config.type === "self_hosted" ||
        session.agent.openma?.runtimeBinding != null,
    });
    if (decision.type === "denied") {
      throw new SessionAdmissionDeniedError(decision.status, decision.body);
    }
  }

  private defaultSession(request: ManagedNodeCreateSubagent): Session {
    if (this.input.session.agent.multiagent !== null) return resolveManagedSubagentSession(this.input.session, request);
    // Legacy OpenAI-compat sessions carry no multiagent snapshot: inline
    // children inherit the parent agent; a named roster member cannot exist.
    if (request.agentId !== undefined && request.agentId !== "general") {
      throw new Error(`Subagent ${request.agentId} is not in the Session roster`);
    }
    const agent = structuredClone(this.input.session.agent);
    return { ...this.input.session, agent: { ...agent, multiagent: null,
      name: request.name ?? agent.name, system: request.instructions ?? agent.system } };
  }

  /** Ordered frame output; decoded frames feed the per-thread conversation. */
  private write(raw: Record<string, unknown>, threadId: string): Promise<void> {
    const frame = { ...raw, session_thread_id: threadId };
    const event = decodeRuntimeProducedSessionEvent(frame);
    const operation = this.outputChain.then(async () => {
      await this.input.output(frame);
      if (event !== null) this.threadLog(threadId).push(event);
    });
    this.outputChain = operation;
    return operation;
  }

  private emitEvent(event: SubagentEvent<Session>): Promise<void> {
    const { threadId, frame } = subagentWireFrame(event);
    return this.write({
      id: this.input.ids.nextEventId(),
      processed_at: this.input.clock.now().toISOString(),
      ...frame,
    }, threadId);
  }

  private async runTurn(thread: SubagentThread<Session>, abortSignal: AbortSignal): Promise<SubagentTurnResult> {
    const session = thread.agent;
    const log = this.threadLog(thread.id);
    const before = log.length;
    const sandbox = withSandboxExecutionGuard(this.input.sandbox, { signal: abortSignal });
    const runtime = new ManagedNodeHarnessRuntime({ sessionThreadId: thread.id, initialEvents: [], events: childHistory(log),
      sandbox, abortSignal, clock: this.input.clock, ids: this.input.ids,
      output: (raw) => {
        const frame = raw as Record<string, unknown>;
        const type = typeof frame.type === "string" && frame.type.startsWith("session.status_")
          ? frame.type.replace("session.status_", "session.thread_status_") : frame.type;
        return this.write({ ...frame, type,
          ...(typeof type === "string" && type.startsWith("session.thread_status_") && { agent_name: session.agent.name }) }, thread.id);
      },
    });
    if (this.budgetGate !== null) runtime.setBudgetGate(turnSessionBudgetGate(this.budgetGate));
    let stopReason: "end_turn" | "budget_reached" = "end_turn";
    try {
      await this.input.run({ session, runtime, sandbox });
      // Capture this turn before output draining lets siblings advance. An
      // explicit terminal frame is authoritative, not a later session flag.
      const terminal = runtime.history.getEvents().findLast(event => event.type === "session.status_idle");
      stopReason = terminal?.type === "session.status_idle"
        ? (terminal.stop_reason?.type === "budget_reached" ? "budget_reached" : "end_turn")
        : runtime.turnBudgetReached ? "budget_reached" : "end_turn";
    } finally { await runtime.drain(); }
    // Frames are committed in order; wait for this turn's before reading them.
    await this.outputChain;
    return { stopReason, agentMessages: log.slice(before).flatMap((event) => {
      const text = agentMessageText(event);
      return text === null ? [] : [text];
    }) };
  }
}
