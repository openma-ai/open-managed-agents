import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWebFetchUrlAllowed,
  fetchWebFetchUrl,
  webFetchGuardError,
  webFetchHttpErrorMessage,
  WebFetchHttpError,
} from "../../apps/agent/src/harness/web-fetch-http";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("assertWebFetchUrlAllowed", () => {
  it("rejects invalid URL and non-http(s) protocols", () => {
    expect(() => assertWebFetchUrlAllowed("not-a-url")).toThrow(WebFetchHttpError);
    expect(() => assertWebFetchUrlAllowed("ftp://example.com/x")).toThrow(/protocol/);
  });

  it("accepts URL object input", () => {
    expect(assertWebFetchUrlAllowed(new URL("https://api.safe.com/"))).toBeInstanceOf(URL);
  });

  it("matches subdomain allowlist with trailing-dot host entry", () => {
    expect(
      assertWebFetchUrlAllowed("https://api.safe.com/", {
        type: "limited",
        allowed_hosts: ["safe.com."],
      }),
    ).toBeInstanceOf(URL);
  });

  it("treats missing allowed_hosts as empty in limited mode", () => {
    expect(() =>
      assertWebFetchUrlAllowed("https://x.com/", { type: "limited" }),
    ).toThrow(/\(none\)/);
  });

  it("enforces allowed_hosts in limited mode including empty list", () => {
    expect(() =>
      assertWebFetchUrlAllowed("https://evil.com/", {
        type: "limited",
        allowed_hosts: ["safe.com"],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      assertWebFetchUrlAllowed("https://x.com/", {
        type: "limited",
        allowed_hosts: [],
      }),
    ).toThrow(/\(none\)/);
    expect(
      assertWebFetchUrlAllowed("https://api.safe.com/", {
        type: "limited",
        allowed_hosts: ["safe.com"],
      }),
    ).toBeInstanceOf(URL);
  });

  it("allows any host when networking is unrestricted or omitted", () => {
    expect(assertWebFetchUrlAllowed("http://127.0.0.1/", { type: "unrestricted" })).toBeInstanceOf(URL);
    expect(assertWebFetchUrlAllowed("https://example.com/")).toBeInstanceOf(URL);
  });
});

describe("webFetchGuardError", () => {
  it("returns null when allowed and Error string when blocked", () => {
    expect(
      webFetchGuardError("https://safe.com/", { type: "limited", allowed_hosts: ["safe.com"] }),
    ).toBeNull();
    expect(webFetchGuardError("https://evil.com/", { type: "limited", allowed_hosts: ["safe.com"] })).toMatch(
      /^Error:/,
    );
  });

});

describe("webFetchHttpErrorMessage", () => {
  it("maps WebFetchHttpError and delegates timeout/abort to shared helper", () => {
    expect(webFetchHttpErrorMessage(new WebFetchHttpError("blocked"))).toBe("blocked");
    expect(webFetchHttpErrorMessage(new DOMException("t", "TimeoutError"), 99)).toMatch(/99/);
    expect(webFetchHttpErrorMessage(new Error("network"))).toBe("network");
    expect(webFetchHttpErrorMessage("plain")).toBe("plain");
  });
});

describe("fetchWebFetchUrl", () => {
  it("rejects redirect to disallowed host in limited mode", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.com/payload" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWebFetchUrl(
        "https://safe.com/redirect",
        {},
        { networking: { type: "limited", allowed_hosts: ["safe.com"] }, timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/not allowed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects middle hop that leaves allowlist", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://hop.safe.com/mid" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.com/final" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWebFetchUrl(
        "https://safe.com/start",
        {},
        { networking: { type: "limited", allowed_hosts: ["safe.com"] }, timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/not allowed/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows relative Location and http→https scheme change when allowed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/next" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://safe.com/secure" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWebFetchUrl(
      "http://safe.com/start",
      {},
      { networking: { type: "limited", allowed_hosts: ["safe.com"] }, timeoutMs: 5000 },
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("http://safe.com/next");
  });

  it("returns redirect response when Location header is missing", async () => {
    const redirect = new Response(null, { status: 302 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirect));
    const res = await fetchWebFetchUrl("https://example.com/", {}, { timeoutMs: 5000 });
    expect(res.status).toBe(302);
  });

  it("throws when max redirects exceeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWebFetchUrl("https://example.com/", {}, { maxRedirects: 1, timeoutMs: 5000 }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it("honors caller abortSignal cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
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
      ),
    );
    const controller = new AbortController();
    const promise = fetchWebFetchUrl(
      "https://example.com/",
      {},
      { abortSignal: controller.signal, timeoutMs: 60_000 },
    );
    controller.abort(new DOMException("user cancel", "AbortError"));
    await expect(promise).rejects.toSatisfy(
      (err: Error) => err.name === "AbortError" || err.name === "TimeoutError",
    );
  });

  it("accepts URL object input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const res = await fetchWebFetchUrl(new URL("https://example.com/"), {}, { timeoutMs: 5000 });
    expect(res.status).toBe(200);
  });

  it("uses default timeout when options omit timeoutMs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const res = await fetchWebFetchUrl("https://example.com/");
    expect(res.status).toBe(200);
  });
});
