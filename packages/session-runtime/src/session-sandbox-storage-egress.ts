import { traceSessionSandbox } from "./session-sandbox-tracing";
// What the core attaches to an open sandbox (design §0.1 steps 3, 6, 7, 9):
// egress (attach with the current fence; revoke at execution end, where a
// failure is only a warning) and storage (Memory Stores and outputs attached
// on open; written back at turn end / before stop).

import { sessionErrorMessage } from "./session-error-message";
import { SandboxGoneError, type SandboxPlan } from "@open-managed-agents/sandbox";
import { errorText, type LiveSessionSandbox, type OpenSandbox } from "./session-sandbox-live";

export async function attachEgress<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>, policy: SandboxPlan["egress"], now: number, signal: AbortSignal): Promise<void> {
  const { ports } = await state.compose();
  const scope = state.scope();
  await traceSessionSandbox(state, "egress.attach", async () => ports.egress.attach({ runtime: open.runtime, scope, fence: state.fence(scope), policy, signal }));
  state.markEgress(now);
}

/** egress.revoke; on routes 1 / 3 / 4 a failure is only a warning
 * (design §0.1 step 9). The next call attaches again either way. */
export async function revokeEgress<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>, reason: "completed" | "failed"): Promise<void> {
  const { ports } = await state.compose();
  const scope = state.scope();
  try {
    await ports.egress.revoke({ runtime: open.runtime, scope, fence: state.fence(scope), reason });
  } catch (error) {
    state.options.warn(`egress_revoke_failed reason=${reason} error=${errorText(error)}`);
  }
  state.egressRevoked = true;
}

/** storage.attach for the Session's Memory Stores and outputs, when it has any. */
export async function attachStorage<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>, signal: AbortSignal): Promise<void> {
  if (!state.attachesStorage) return;
  const { ports } = await state.compose();
  const scope = state.scope();
  await traceSessionSandbox(state, "storage.attach", async span => {
    span.setAttributes({ "storage.outputs": state.outputs, "storage.memory_count": state.stores.length });
    await ports.storage.attach({ runtime: open.runtime, scope, fence: state.fence(scope), stores: state.stores, outputs: open.plan.outputs, signal });
  });
}

/** Turn end / before stop: storage.sync (copy: Memory write-back + pull
 * and the outputs upload; native: credential renewal or a no-op). Any
 * failure, including a sandbox lost during the turn, is an error. */
export async function syncStorage<R>(state: LiveSessionSandbox<R>, reason: "turn_end" | "before_stop" | "checkpoint"): Promise<void> {
  await state.quiesce();
  state.throwRefreshError();
  if (state.lost) {
    state.lost = false;
    throw new SandboxGoneError("The sandbox was lost during the turn; its Memory and outputs changes were not published");
  }
  const open = state.current;
  if (open === null || !state.attachesStorage) return;
  const { ports } = await state.compose();
  const scope = state.scope();
  try {
    await ports.storage.sync({ runtime: open.runtime, scope, fence: state.fence(scope), stores: state.stores, outputs: open.plan.outputs, reason, signal: new AbortController().signal });
  } catch (error) {
    throw new Error(sessionErrorMessage(error, `storage.sync:${reason}`), { cause: error });
  }
  state.storageSyncedAt = state.now();
}
