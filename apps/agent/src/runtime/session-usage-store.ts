// Cloudflare SessionUsageStorePort: token counters live in SessionDO state.
// `input_tokens` / `output_tokens` are the session-wide totals and
// `thread_usage[threadId]` the per-thread buckets (what POST /usage echoes and
// GET /threads/:id reads). The usage rules themselves are the application's
// (packages/managed-agents-application/src/sessions/budget.ts).
import type {
  SessionTokenTotals,
  SessionUsageStorePort,
} from "@open-managed-agents/managed-agents-application";

/** The slice of SessionDO state this adapter reads and writes. */
export interface SessionUsageState {
  input_tokens: number;
  output_tokens: number;
  thread_usage?: Record<string, SessionTokenTotals>;
}

export function sessionDoUsageStore<S extends SessionUsageState>(state: {
  get(): S;
  set(next: S): void;
}): SessionUsageStorePort {
  return {
    loadThread: (threadId) => {
      const totals = state.get().thread_usage?.[threadId];
      return totals === undefined ? null : { ...totals };
    },
    loadSession: () => {
      const current = state.get();
      return { input_tokens: current.input_tokens ?? 0, output_tokens: current.output_tokens ?? 0 };
    },
    save: ({ threadId, thread, session }) => {
      const current = state.get();
      state.set({
        ...current,
        input_tokens: session.input_tokens,
        output_tokens: session.output_tokens,
        thread_usage: { ...(current.thread_usage ?? {}), [threadId]: { ...thread } },
      });
    },
  };
}
