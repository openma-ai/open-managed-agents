// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { buildTools } from "../../apps/agent/src/harness/tools";
import * as toolHttpFetch from "../../apps/agent/src/harness/tool-http-fetch";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import type { AgentConfig } from "@open-managed-agents/shared";

function makeAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_test",
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    system: "You are a test agent.",
    tools: [{ type: "agent_toolset_20260401" }],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  abortSignal: undefined as any,
};

function mockFetch(body = "<html>ok</html>", init?: Partial<ResponseInit>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, ...init })),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web_fetch egress (rescoped #281)", () => {
  it("rejects disallowed host via guard before fetch", async () => {
    mockFetch();
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      environmentConfig: {
        networking: { type: "limited", allowed_hosts: ["example.com"] },
      },
    });
    const result = await tools.web_fetch.execute(
      { url: "https://evil.com/page" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toMatch(/not allowed/i);
  });

  it("rejects redirect to disallowed host in limited mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.com/" },
        }),
      ),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      environmentConfig: {
        networking: { type: "limited", allowed_hosts: ["example.com"] },
      },
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/redirect" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toMatch(/Error:.*not allowed/i);
  });

  it("fetches public URLs successfully via raw fallback", async () => {
    mockFetch("hello world");
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toContain("hello world");
  });

  it("uses toMarkdown when configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html><body>Hi</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      toMarkdown: async () => ({ format: "markdown", data: "# Hi\n\nConverted." }),
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/page" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toContain("Converted.");
  });

  it("falls back to raw fetch when toMarkdown returns non-markdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>raw</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      toMarkdown: async () => ({ format: "text", data: "nope", error: "bad fmt" }),
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/bad-md" },
      TOOL_EXEC_OPTS,
    );
    expect(String(result)).toMatch(/markdown extraction unavailable/i);
    expect(String(result)).toContain("raw");
  });

  it("falls back when origin returns non-OK for toMarkdown path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      toMarkdown: async () => ({ format: "markdown", data: "unused" }),
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/missing" },
      TOOL_EXEC_OPTS,
    );
    expect(String(result)).toMatch(/markdown extraction unavailable/i);
  });

  it("falls back when toMarkdown throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>x</html>", { status: 200 })),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      toMarkdown: async () => {
        throw new Error("converter blew up");
      },
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/throw" },
      TOOL_EXEC_OPTS,
    );
    expect(String(result)).toMatch(/markdown extraction unavailable/i);
  });

  it("returns fetch error from raw fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Timed out", "TimeoutError");
      }),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/timeout" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toMatch(/^Error:/i);
    expect(String(result)).toMatch(/timed out/i);
  });

  it("respects max_length on markdown return", async () => {
    const long = "z".repeat(8000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(long, { status: 200 })),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/long", max_length: 500 },
      TOOL_EXEC_OPTS,
    );
    expect(String(result)).toContain("truncated to 500 chars");
  });

  it("summarizes large markdown with aux model", async () => {
    const auxModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "short summary" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const sandbox: any = {
      exec: async () => "exit=0\n",
      readFile: async () => "",
      writeFile: async () => "ok",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>big</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const events: unknown[] = [];
    const tools = await buildTools(makeAgentConfig(), sandbox, {
      toMarkdown: async () => ({ format: "markdown", data: "x".repeat(6000) }),
      auxModel,
      auxModelInfo: { model_id: "aux-test" },
      broadcastEvent: (e) => events.push(e),
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/large" },
      TOOL_EXEC_OPTS,
    );
    const parsed = JSON.parse(String(result));
    expect(parsed.content).toBe("short summary");
    expect(parsed._meta.raw_at).toMatch(/^\/workspace\/\.web\//);
    expect(events.some((e: any) => e.type === "aux.model_call" && e.status === "ok")).toBe(true);
  });

  it("returns truncated markdown when aux summarization fails", async () => {
    const auxModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { status: 200 })),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      toMarkdown: async () => ({ format: "markdown", data: "y".repeat(6000) }),
      auxModel,
      auxModelInfo: { model_id: "aux-test" },
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/aux-fail" },
      TOOL_EXEC_OPTS,
    );
    const parsed = JSON.parse(String(result));
    expect(parsed._meta.summary_failed).toBe(true);
    expect(parsed.content.length).toBeGreaterThan(1000);
  });
});

describe("web_search timeouts and wiring", () => {
  it("returns timeout error when upstream hangs", async () => {
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
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_search.execute(
      { query: "test query" },
      { ...TOOL_EXEC_OPTS, abortSignal: AbortSignal.timeout(80) },
    );
    expect(result).toMatch(/timed out/i);
  });

  it("DDG happy path parses results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("duckduckgo.com/?")) {
          return new Response(`<html>vqd='99-88'</html>`, { status: 200 });
        }
        return new Response(
          "DDG.pageLayout.load('d',[{\"u\":\"https://r.example\",\"t\":\"Hit\",\"a\":\"<b>desc</b>\"}]);DDG.duckbar.load('x',[]);",
          { status: 200 },
        );
      }),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_search.execute({ query: "oma" }, TOOL_EXEC_OPTS);
    const parsed = JSON.parse(String(result));
    expect(parsed[0].url).toBe("https://r.example");
    expect(parsed[0].description).toBe("desc");
  });

  it("DDG reports missing VQD token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>no token</html>", { status: 200 })));
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_search.execute({ query: "x" }, TOOL_EXEC_OPTS);
    expect(result).toContain("failed to get search token");
  });

  it("DDG reports HTTP error on token fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 503 })));
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_search.execute({ query: "x" }, TOOL_EXEC_OPTS);
    expect(result).toContain("DuckDuckGo error: 503");
  });

  it("DDG reports rate limiting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("duckduckgo.com/?")) {
          return new Response(`vqd='1-2'`, { status: 200 });
        }
        return new Response("DDG.deep.anomalyDetectionBlock", { status: 200 });
      }),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_search.execute({ query: "x" }, TOOL_EXEC_OPTS);
    expect(result).toContain("rate limited");
  });

  it("Tavily returns error when API key missing", async () => {
    const tools = await buildTools(
      makeAgentConfig({ tools: [{ type: "web_search_tavily" }] }),
      new TestSandbox(),
    );
    const result = await tools.web_search.execute({ query: "q" }, TOOL_EXEC_OPTS);
    expect(result).toContain("TAVILY_API_KEY not configured");
  });

  it("Tavily maps API results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [{ title: "T", url: "https://t.example", content: "snippet" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const tools = await buildTools(
      makeAgentConfig({ tools: [{ type: "web_search_tavily" }] }),
      new TestSandbox(),
      { TAVILY_API_KEY: "tvly-test" },
    );
    const result = await tools.web_search.execute({ query: "find" }, TOOL_EXEC_OPTS);
    const parsed = JSON.parse(String(result));
    expect(parsed[0].snippet).toBe("snippet");
  });

  it("Tavily surfaces post errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const tools = await buildTools(
      makeAgentConfig({ tools: [{ type: "web_search_tavily" }] }),
      new TestSandbox(),
      { TAVILY_API_KEY: "tvly-test" },
    );
    const result = await tools.web_search.execute({ query: "q" }, TOOL_EXEC_OPTS);
    expect(result).toBe("Error: network down");
  });

  it("Tavily stringifies non-Error post failures", async () => {
    vi.spyOn(toolHttpFetch, "postTavilySearch").mockRejectedValueOnce("plain fail");
    const tools = await buildTools(
      makeAgentConfig({ tools: [{ type: "web_search_tavily" }] }),
      new TestSandbox(),
      { TAVILY_API_KEY: "tvly-test" },
    );
    const result = await tools.web_search.execute({ query: "q" }, TOOL_EXEC_OPTS);
    expect(result).toBe("Error: plain fail");
  });
});
