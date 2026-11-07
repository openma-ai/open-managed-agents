import { expect, it, vi } from "vitest";
import { observeProxyBody } from "../../packages/http-routes/src/proxy/forward";

it("does not start a body read when an OAuth 401 will be discarded", async () => {
  const pull = vi.fn(); const cancel = vi.fn();
  const upstream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const response = observeProxyBody(new Response(upstream, { status: 401 }));
  await Promise.resolve();
  expect(pull).not.toHaveBeenCalled();
  await response.body!.cancel("refreshing");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("refreshing");
});

it("observes cancellation of an already pending workerd body read", async () => {
  let pulled!: () => void;
  const entered = new Promise<void>(resolve => { pulled = resolve; });
  const cancel = vi.fn();
  const upstream = new ReadableStream<Uint8Array>({ pull() { pulled(); }, cancel }, { highWaterMark: 0 });
  const reader = observeProxyBody(new Response(upstream)).body!.getReader();
  const pending = reader.read();
  await entered;
  await reader.cancel("disconnected");
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancel).toHaveBeenCalledExactlyOnceWith("disconnected");
});
