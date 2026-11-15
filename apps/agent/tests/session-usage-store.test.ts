// SessionDO state adapter for the application SessionUsageStorePort, run
// against the shared conformance suite (design §0.7 用量 / 预算).
import { describe, expect, it } from "vitest";
import { describeSessionUsageStoreConformance } from "../../../packages/managed-agents-application/test/session-usage-store-conformance";
import { sessionDoUsageStore, type SessionUsageState } from "../src/runtime/session-usage-store";

function doState(initial: SessionUsageState & Record<string, unknown>) {
  let state = initial;
  return { get: () => state, set: (next: typeof state) => { state = next; }, current: () => state };
}

describeSessionUsageStoreConformance("cloudflare SessionDO state", () =>
  sessionDoUsageStore(doState({ input_tokens: 0, output_tokens: 0 })));

describe("SessionDO usage state adapter", () => {
  it("keeps every other DO state field and the existing thread buckets", () => {
    const holder = doState({ input_tokens: 5, output_tokens: 6, session_id: "s", thread_usage: {
      sthr_old: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } });
    sessionDoUsageStore(holder).save({
      threadId: "sthr_primary",
      thread: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      session: { input_tokens: 6, output_tokens: 7 },
    });
    expect(holder.current()).toEqual({
      input_tokens: 6, output_tokens: 7, session_id: "s",
      thread_usage: {
        sthr_old: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        sthr_primary: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  });

  it("reads pre-thread-usage state (no thread_usage) as empty threads", () => {
    const store = sessionDoUsageStore(doState({ input_tokens: 3, output_tokens: 4 }));
    expect(store.loadThread("sthr_primary")).toBeNull();
    expect(store.loadSession()).toEqual({ input_tokens: 3, output_tokens: 4 });
  });
});
