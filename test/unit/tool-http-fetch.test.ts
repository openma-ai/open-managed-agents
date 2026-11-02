import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWebSearchGet,
  fetchWithTimeout,
  httpFetchErrorMessage,
  mergeAbortSignals,
  postTavilySearch,
  WEB_SEARCH_TAVILY_TIMEOUT_MS,
} from "../../apps/agent/src/harness/tool-http-fetch";

function abortAwareFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Timed out", "TimeoutError")),
        { once: true },
      );
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mergeAbortSignals", () => {
  it("returns undefined for empty input", () => {
    expect(mergeAbortSignals([null, undefined])).toBeUndefined();
  });

  it("returns the sole signal unchanged", () => {
    const c = new AbortController();
    expect(mergeAbortSignals([c.signal])).toBe(c.signal);
  });

  it("uses AbortSignal.any when available", () => {
    if (typeof AbortSignal.any !== "function") return;
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    const merged = mergeAbortSignals([a.signal, b.signal, c.signal]);
    expect(merged).toBeDefined();
    expect(merged?.aborted).toBe(false);
  });

  it("falls back when AbortSignal.any is missing", () => {
    const anyFn = AbortSignal.any;
    // @ts-expect-error test override
    AbortSignal.any = undefined;
    try {
      const early = new AbortController();
      early.abort("early");
      const peer = new AbortController();
      expect(mergeAbortSignals([early.signal, peer.signal])?.aborted).toBe(true);

      const a = new AbortController();
      const b = new AbortController();
      const merged = mergeAbortSignals([a.signal, b.signal]);
      expect(merged?.aborted).toBe(false);
      b.abort();
      expect(merged?.aborted).toBe(true);
    } finally {
      // @ts-expect-error restore
      AbortSignal.any = anyFn;
    }
  });
});

describe("httpFetchErrorMessage", () => {
  it("maps timeout/abort, generic Error, and non-Errors", () => {
    expect(httpFetchErrorMessage(new DOMException("t", "TimeoutError"), 99)).toMatch(/99/);
    expect(httpFetchErrorMessage(new DOMException("a", "AbortError"), 50)).toMatch(/50/);
    expect(httpFetchErrorMessage(new Error("network down"))).toBe("network down");
    expect(httpFetchErrorMessage("plain")).toBe("plain");
  });
});

describe("fetchWithTimeout", () => {
  it("fetches successfully with URL object input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const res = await fetchWithTimeout(new URL("https://example.com/"), {}, { timeoutMs: 5000 });
    expect(res.status).toBe(200);
  });

  it("uses default timeout when options omit timeoutMs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const res = await fetchWithTimeout("https://example.com/");
    expect(res.status).toBe(200);
  });

  it("surfaces timeout via abort signal", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    await expect(
      fetchWithTimeout("https://example.com/slow", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((err: Error) => err.name === "TimeoutError" || err.name === "AbortError");
  });

  it("honors caller abortSignal", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const controller = new AbortController();
    const promise = fetchWithTimeout("https://example.com/", {}, {
      abortSignal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort(new DOMException("cancel", "AbortError"));
    await expect(promise).rejects.toSatisfy(
      (err: Error) => err.name === "AbortError" || err.name === "TimeoutError",
    );
  });
});

describe("web_search helpers", () => {
  it("fetchWebSearchGet wraps timeout errors", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    await expect(
      fetchWebSearchGet("https://duckduckgo.com/", AbortSignal.timeout(50), 50),
    ).rejects.toThrow(/timed out/i);
  });

  it("postTavilySearch times out", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    await expect(
      postTavilySearch("{}", AbortSignal.timeout(50)),
    ).rejects.toThrow(new RegExp(`${WEB_SEARCH_TAVILY_TIMEOUT_MS}|timed out`, "i"));
  });
});
