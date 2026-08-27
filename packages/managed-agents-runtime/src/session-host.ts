import type {
  AcpRuntime,
  AcpSession,
  SessionOptions,
} from "@open-managed-agents/acp-runtime";
import type { SessionHostEvent } from "@openma/common/session-kernel";

export interface ManagedAgentsSessionHostDependencies {
  runtime: AcpRuntime;
  emit(event: SessionHostEvent): void;
  scheduler?: ManagedAgentsRuntimeScheduler;
}

export interface ManagedAgentsRuntimeScheduler {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ManagedAgentsDrainOptions {
  deadlineMs: number;
  pollIntervalMs?: number;
  abortGraceMs?: number;
  onProgress?(activeTurns: number, msLeft: number): void;
}

export interface ManagedAgentsDrainReport {
  initialTurns: number;
  abortedTurns: number;
  sessions: number;
}

export const systemRuntimeScheduler: ManagedAgentsRuntimeScheduler = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ManagedAgentsSessionStartInput {
  sessionId: string;
  options: SessionOptions;
}

export interface ManagedAgentsSessionPromptInput {
  sessionId: string;
  turnId: string;
  text: string;
}

interface ActiveSession {
  acp: AcpSession;
  turns: Map<string, AbortController>;
}

export class ManagedAgentsSessionHost {
  readonly #runtime: AcpRuntime;
  readonly #emit: (event: SessionHostEvent) => void;
  readonly #scheduler: ManagedAgentsRuntimeScheduler;
  readonly #sessions = new Map<string, ActiveSession>();
  #draining = false;

  constructor(dependencies: ManagedAgentsSessionHostDependencies) {
    this.#runtime = dependencies.runtime;
    this.#emit = dependencies.emit;
    this.#scheduler = dependencies.scheduler ?? systemRuntimeScheduler;
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  sessionCount(): number {
    return this.#sessions.size;
  }

  announce(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    this.#emit({
      type: "session.ready",
      sessionId,
      acpSessionId: session.acp.acpSessionId,
    });
    return true;
  }

  announceAll(): void {
    for (const [sessionId, session] of this.#sessions) {
      this.#emit({
        type: "session.ready",
        sessionId,
        acpSessionId: session.acp.acpSessionId,
      });
    }
  }

  activeTurnCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) count += session.turns.size;
    return count;
  }

  async start(input: ManagedAgentsSessionStartInput): Promise<void> {
    if (this.#draining) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        message: "runtime is draining; retry on another runtime",
      });
      return;
    }
    if (this.announce(input.sessionId)) return;

    let session: AcpSession;
    try {
      session = await this.#runtime.start(input.options);
    } catch (error) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#sessions.set(input.sessionId, {
      acp: session,
      turns: new Map(),
    });
    this.#emit({
      type: "session.ready",
      sessionId: input.sessionId,
      acpSessionId: session.acpSessionId,
    });
  }

  async prompt(input: ManagedAgentsSessionPromptInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: "no such session",
      });
      return;
    }
    const controller = new AbortController();
    session.turns.set(input.turnId, controller);
    let promptError: string | undefined;
    try {
      for await (const event of session.acp.prompt(input.text, {
        abortSignal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        const sentinel = event as {
          type?: unknown;
          error?: unknown;
        } | null;
        if (sentinel?.type === "promptComplete") {
          continue;
        }
        if (sentinel?.type === "promptError") {
          promptError = typeof sentinel.error === "string"
            ? sentinel.error
            : "ACP prompt error (no message)";
          continue;
        }
        this.#emit({
          type: "session.event",
          sessionId: input.sessionId,
          turnId: input.turnId,
          event,
        });
      }
      this.#emit(promptError
        ? {
            type: "session.error",
            sessionId: input.sessionId,
            turnId: input.turnId,
            message: promptError,
          }
        : {
            type: "session.complete",
            sessionId: input.sessionId,
            turnId: input.turnId,
          });
    } catch (error) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.turns.delete(input.turnId);
    }
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) {
      for (const controller of session.turns.values()) controller.abort();
      await session.acp.dispose().catch(() => undefined);
      this.#sessions.delete(sessionId);
    }
    this.#emit({ type: "session.disposed", sessionId });
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.#sessions.entries()];
    await Promise.all(sessions.map(async ([sessionId, session]) => {
      for (const controller of session.turns.values()) controller.abort();
      await session.acp.dispose().catch(() => undefined);
      this.#sessions.delete(sessionId);
    }));
  }

  async drain(options: ManagedAgentsDrainOptions): Promise<ManagedAgentsDrainReport> {
    this.#draining = true;
    const initialTurns = this.activeTurnCount();
    const sessions = this.sessionCount();
    const startedAt = this.#scheduler.now();
    const pollIntervalMs = options.pollIntervalMs ?? 200;

    while (this.activeTurnCount() > 0) {
      const elapsed = this.#scheduler.now() - startedAt;
      if (elapsed >= options.deadlineMs) break;
      const msLeft = options.deadlineMs - elapsed;
      options.onProgress?.(this.activeTurnCount(), msLeft);
      await this.#scheduler.sleep(Math.min(pollIntervalMs, msLeft));
    }

    let abortedTurns = 0;
    for (const session of this.#sessions.values()) {
      for (const controller of session.turns.values()) {
        if (!controller.signal.aborted) {
          controller.abort();
          abortedTurns += 1;
        }
      }
    }
    if (abortedTurns > 0 && (options.abortGraceMs ?? 2_000) > 0) {
      await this.#scheduler.sleep(options.abortGraceMs ?? 2_000);
    }
    await this.disposeAll();
    return { initialTurns, abortedTurns, sessions };
  }

  cancel(sessionId: string, turnId: string): void {
    this.#sessions.get(sessionId)?.turns.get(turnId)?.abort();
  }
}
