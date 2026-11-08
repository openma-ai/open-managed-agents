// The provider's continuous-run cap (design §0.0 rule 11,
// sandbox.maxLifetimeMs; null = none, e.g. Cloudflare). The core records
// when the sandbox's current continuous run started (acquire / resume / its
// own refresh; kept with the handle so a new host instance knows it) and
// never trusts keepAlive: E2B silently truncates a renewal at the cap. Once
// the run passes maxLifetimeMs − MAX_TOOL_CALL_MS − LIFETIME_REFRESH_MARGIN_MS
// and no call is in flight (the model-inference gap), it refreshes: fence
// check, sandbox.pause, sandbox.attach (wakes the paused sandbox), then
// egress.attach and storage.attach again. The next call waits for it; a
// failed refresh fails that call, once. Layer 2 (the provider pausing at
// the cap) is the adapter's (E2B onTimeout: pause).

import { SandboxGoneError } from "@open-managed-agents/sandbox";
import type { LiveSessionSandbox, OpenSandbox } from "./session-sandbox-live";
import { attachEgress, attachStorage } from "./session-sandbox-storage-egress";

/** The longest single tool call (bash MAX_BASH_TIMEOUT, harness/tools.ts). */
export const MAX_TOOL_CALL_MS = 10 * 60_000;
/** Headroom for the lifetime refresh itself (pause + attach). */
export const LIFETIME_REFRESH_MARGIN_MS = 5 * 60_000;

export function lifetimeDue<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>): boolean {
  const max = state.maxLifetimeMs;
  if (max === null) return false;
  return state.now() - open.runStartedAt >= max - MAX_TOOL_CALL_MS - LIFETIME_REFRESH_MARGIN_MS;
}

/** Design §0.0 rule 11 layer 1: pause → attach, single-flight. Only when
 * this owner still holds the fence (rule 10: a fenced-out owner does not
 * pause). Never rejects: a failure is kept for the next call. */
export function refreshLifetime<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>): Promise<void> {
  return state.refreshing ??= (async () => {
    if (!await state.isCurrent(state.execution())) return;
    const { ports } = await state.compose();
    const scope = state.scope();
    const signal = new AbortController().signal;
    // Nothing may use the runtime being paused; callers wait on `refreshing`.
    state.current = null;
    await ports.sandbox.pause({ scope, runtime: open.runtime, handle: open.handle, signal });
    const attached = await ports.sandbox.attach({ scope, handle: open.handle, signal });
    if (attached === "gone") {
      state.markLost();
      throw new SandboxGoneError("The sandbox did not come back after its lifetime refresh");
    }
    const now = state.now();
    const next: OpenSandbox<R> = { ...attached, executor: state.options.executor(attached.runtime), generation: open.generation, plan: open.plan, runStartedAt: now };
    await state.record(next);
    if (Object.keys(state.env).length > 0) await next.executor.setEnvVars(state.env);
    await attachEgress(state, next, open.plan.egress, now, signal);
    await attachStorage(state, next, signal);
    state.current = next;
  })().catch((error: unknown) => {
    state.current = null;
    state.refreshError = error;
  }).finally(() => { state.refreshing = null; });
}
