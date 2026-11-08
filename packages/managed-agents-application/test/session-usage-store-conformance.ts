// Conformance suite for SessionUsageStorePort (design §0.7 用量 / 预算). Every
// platform adapter (in-memory here, Cloudflare SessionDO state in apps/agent)
// runs it; the usage rules on top are the application's createSessionUsageMeter.
import { describe, expect, it } from "vitest";
import {
  createSessionUsageMeter,
  type SessionUsageStorePort,
} from "../src/sessions/budget";

/** A store over fresh, empty storage. */
export type SessionUsageStoreFactory = () => SessionUsageStorePort;

export function describeSessionUsageStoreConformance(
  name: string,
  createStore: SessionUsageStoreFactory,
): void {
  describe(`SessionUsageStorePort conformance: ${name}`, () => {
    it("starts empty: unknown threads load null, session totals load 0", () => {
      const store = createStore();
      expect(store.loadThread("sthr_primary")).toBeNull();
      expect(store.loadSession()).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    it("save persists one thread and the session totals without touching other threads", () => {
      const store = createStore();
      const a = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
      const b = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      store.save({ threadId: "sthr_a", thread: a, session: { input_tokens: 1, output_tokens: 2 } });
      store.save({ threadId: "sthr_b", thread: b, session: { input_tokens: 11, output_tokens: 22 } });
      expect(store.loadThread("sthr_a")).toEqual(a);
      expect(store.loadThread("sthr_b")).toEqual(b);
      expect(store.loadSession()).toEqual({ input_tokens: 11, output_tokens: 22 });
    });

    it("loads are copies: mutating a loaded value does not change the store", () => {
      const store = createStore();
      const thread = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      store.save({ threadId: "sthr_a", thread, session: { input_tokens: 1, output_tokens: 1 } });
      thread.input_tokens = 99;
      const loaded = store.loadThread("sthr_a")!;
      loaded.output_tokens = 99;
      store.loadSession().input_tokens = 99;
      expect(store.loadThread("sthr_a")).toEqual({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      expect(store.loadSession()).toEqual({ input_tokens: 1, output_tokens: 1 });
    });

    it("under the meter: per-thread buckets, session-wide input/output across threads", () => {
      const meter = createSessionUsageMeter(createStore());
      meter.credit("sthr_primary", { input_tokens: 100, output_tokens: 50 });
      meter.credit("sthr_child", { input_tokens: 7, output_tokens: 3 });
      expect(meter.creditModelSpan("sthr_primary", {
        type: "span.model_request_end",
        model_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 },
      })).toBe(true);
      expect(meter.creditModelSpan("sthr_primary", { type: "span.model_request_end", model_usage: { input_tokens: 1 } })).toBe(false);
      expect(meter.creditModelSpan("sthr_primary", { type: "agent.message" })).toBe(false);
      expect(meter.thread("sthr_primary")).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 });
      expect(meter.thread("sthr_child")).toEqual({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      expect(meter.thread("sthr_never")).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      expect(meter.session()).toEqual({ input_tokens: 107, output_tokens: 53 });
    });
  });
}
