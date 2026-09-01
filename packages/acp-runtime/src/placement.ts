import type { SandboxDuplexProcessPort } from "@open-managed-agents/sandbox";
import type {
  AcpRuntime,
  AcpSession,
  ChildHandle,
  SessionOptions,
  Spawner,
} from "@openma/common/acp-runtime";

import { AcpRuntimeImpl } from "./runtime.js";
import { SandboxSpawner } from "./spawners/sandbox.js";

/** Runtime placement is a composition decision, not a second ACP runtime.
 * Both branches construct the same AcpRuntimeImpl and therefore share ACP
 * negotiation, lifecycle, prompt streaming, cancellation, and restart logic. */
export type AcpRuntimePlacement =
  | {
      type: "local";
      /** Injected by a Node/desktop composition root so this cross-platform
       * module never imports node:child_process into a Worker bundle. */
      spawner: Spawner;
    }
  | {
      type: "sandbox";
      sandbox: SandboxDuplexProcessPort;
    };

export interface AcpRuntimeLifecycleOptions {
  /** Maximum time an ACP child may keep a prompt open after cancel. The
   * process is hard-killed when it fails to stop cooperatively. */
  cancelGraceMs?: number;
}

export class AcpPromptCancellationTimeoutError extends Error {
  override readonly name = "AcpPromptCancellationTimeoutError";

  constructor(readonly cancelGraceMs: number) {
    super(`ACP prompt did not stop within ${cancelGraceMs}ms after cancellation`);
  }
}

export function createAcpRuntime(
  placement: AcpRuntimePlacement,
  lifecycle: AcpRuntimeLifecycleOptions = {},
): AcpRuntime {
  const spawner = placement.type === "local"
    ? placement.spawner
    : new SandboxSpawner(placement.sandbox);
  return new PlacementAcpRuntime(spawner, lifecycle.cancelGraceMs ?? 2_000);
}

/**
 * The shared ACP session owns the protocol connection, while placement owns
 * the child-process lifecycle. Keeping the child exit signal at this boundary
 * makes `AcpSession.isAlive()` truthful without forking the common protocol
 * implementation for Node and sandbox runtimes.
 */
class PlacementAcpRuntime implements AcpRuntime {
  constructor(
    private readonly spawner: Spawner,
    private readonly cancelGraceMs: number,
  ) {
    if (!Number.isFinite(cancelGraceMs) || cancelGraceMs < 0) {
      throw new TypeError("ACP cancelGraceMs must be a non-negative number");
    }
  }

  async start(options: SessionOptions): Promise<AcpSession> {
    let child: ChildHandle | undefined;
    const runtime = new AcpRuntimeImpl({
      spawn: async (spec) => {
        if (child) {
          throw new Error("ACP runtime attempted to spawn more than one child for a session");
        }
        child = await this.spawner.spawn(spec);
        return child;
      },
    });
    const session = await runtime.start(options);
    if (!child) {
      await session.dispose().catch(() => undefined);
      throw new Error("ACP runtime initialized without a child process");
    }
    return withChildLiveness(session, child, this.cancelGraceMs);
  }
}

function withChildLiveness(
  session: AcpSession,
  child: ChildHandle,
  cancelGraceMs: number,
): AcpSession {
  const liveness = { alive: true };
  let disposal: Promise<void> | null = null;
  void child.exited.then(
    () => { liveness.alive = false; },
    () => { liveness.alive = false; },
  );

  return new Proxy(session, {
    get(target, property) {
      if (property === "isAlive") {
        return () => liveness.alive && target.isAlive();
      }
      if (property === "prompt") {
        return (
          input: Parameters<AcpSession["prompt"]>[0],
          options?: Parameters<AcpSession["prompt"]>[1],
        ) => supervisedPrompt(
          target,
          child,
          input,
          options,
          cancelGraceMs,
          () => { liveness.alive = false; },
        );
      }
      if (property === "dispose") {
        return () => {
          disposal ??= supervisedDispose(
            target,
            child,
            cancelGraceMs,
            () => { liveness.alive = false; },
          );
          return disposal;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function supervisedDispose(
  session: AcpSession,
  child: ChildHandle,
  cancelGraceMs: number,
  markDead: () => void,
): Promise<void> {
  const coreDisposal = session.dispose();
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  const hardKill = new Promise<void>((resolve) => {
    hardKillTimer = setTimeout(() => {
      markDead();
      void child.kill("SIGKILL").catch(() => undefined);
      resolve();
    }, cancelGraceMs);
  });
  try {
    await Promise.race([coreDisposal, hardKill]);
  } finally {
    if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
    void coreDisposal.catch(() => undefined);
  }
}

/** Stream the underlying prompt while independently supervising its child.
 * The common ACP engine sends session/cancel on abort; placement owns the
 * escalation because it is the only layer with a real process handle. */
async function* supervisedPrompt(
  session: AcpSession,
  child: ChildHandle,
  input: Parameters<AcpSession["prompt"]>[0],
  options: Parameters<AcpSession["prompt"]>[1],
  cancelGraceMs: number,
  markDead: () => void,
): AsyncIterable<unknown> {
  const turnController = new AbortController();
  const forwardAbort = () => turnController.abort(options?.abortSignal?.reason);
  if (options?.abortSignal?.aborted) forwardAbort();
  else options?.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

  const turnTimeoutMs = session.options.perTurnTimeoutMs;
  const timeout = turnTimeoutMs === undefined
    ? undefined
    : setTimeout(
        () => turnController.abort(
          new Error(`ACP prompt exceeded its ${turnTimeoutMs}ms turn deadline`),
        ),
        turnTimeoutMs,
      );

  let settled = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectEscalation!: (error: AcpPromptCancellationTimeoutError) => void;
  const escalation = new Promise<never>((_resolve, reject) => {
    rejectEscalation = reject;
  });
  const escalate = () => {
    escalationTimer = setTimeout(() => {
      if (settled) return;
      markDead();
      void child.kill("SIGKILL").catch(() => undefined);
      rejectEscalation(new AcpPromptCancellationTimeoutError(cancelGraceMs));
    }, cancelGraceMs);
  };
  turnController.signal.addEventListener("abort", escalate, { once: true });

  const iterator = session.prompt(input, {
    ...options,
    abortSignal: turnController.signal,
  })[Symbol.asyncIterator]();
  let completed = false;
  let escalated = false;
  try {
    while (true) {
      const next = iterator.next();
      let item: IteratorResult<unknown>;
      try {
        item = await Promise.race([next, escalation]);
      } catch (error) {
        escalated = error instanceof AcpPromptCancellationTimeoutError;
        void next.catch(() => undefined);
        throw error;
      }
      if (item.done) {
        completed = true;
        break;
      }
      yield item.value;
    }
  } finally {
    settled = true;
    const consumerClosed = !completed && !escalated;
    if (!completed && !turnController.signal.aborted) {
      // A consumer that stops reading early still relinquishes the active ACP
      // turn; otherwise the next prompt would race an invisible old request.
      turnController.abort(new Error("ACP prompt consumer closed before completion"));
    }
    if (timeout !== undefined) clearTimeout(timeout);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    turnController.signal.removeEventListener("abort", escalate);
    options?.abortSignal?.removeEventListener("abort", forwardAbort);
    if (consumerClosed) {
      // AsyncGenerator.return() cannot interrupt the common engine while it
      // awaits a non-cooperative agent response. Even when return() resolves,
      // it does not prove the background ACP request stopped, so this session
      // is no longer safe to reuse: give cancel its grace, then fence child.
      void iterator.return?.().catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, cancelGraceMs));
      markDead();
      await child.kill("SIGKILL").catch(() => undefined);
    }
  }
}
