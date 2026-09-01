import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApi } from "./api";

const CONSOLE_API_BETAS = [
  "managed-agents-2026-04-01",
  "files-api-2025-04-14",
  "skills-2025-10-02",
  "agent-memory-2026-07-22",
  "dreaming-2026-04-21",
  "mcp-tunnels-2026-06-22",
  "user-profiles-2026-08-18",
].join(",");

describe("useApi Managed Agents negotiation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
    vi.restoreAllMocks();
  });

  it("sends the Managed Agents beta on JSON API requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: [] }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    await act(async () => {
      await result.current.api("/v1/agents");
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
      CONSOLE_API_BETAS,
    );
  });

  it("returns auth-aware raw responses for Managed SDK downloads", async () => {
    localStorage.setItem("oma_active_tenant_id", "tenant_1");
    const response = new Response("archive", { status: 200 });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    const received = await result.current.apiRaw("/v1/files/file_1/content", {
      headers: { Accept: "application/binary" },
    });

    expect(received).toBe(response);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("x-active-tenant")).toBe("tenant_1");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/binary");
  });

  it("returns an SDK-style async iterable and skips SSE ping frames", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          [
            "event: ping\ndata: {}\n\n",
            "event: agent.message\ndata: {\"type\":\"agent.message\",\"message\":\"hi\"}\n\n",
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    const events: unknown[] = [];
    const iterable = await result.current.apiStream<Record<string, unknown>>(
      "/v1/sessions/session_1/events/stream",
    );
    for await (const event of iterable) events.push(event);

    expect(events).toEqual([{ type: "agent.message", message: "hi" }]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("Accept")).toBe("text/event-stream");
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
      CONSOLE_API_BETAS,
    );
  });

  it("updates one toast when the same API error repeats", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({}, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const toastError = vi.spyOn(toast, "error");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useApi());

    await act(async () => {
      await expect(result.current.api("/v1/agents")).rejects.toThrow(
        "HTTP 500",
      );
      await expect(result.current.api("/v1/environments")).rejects.toThrow(
        "HTTP 500",
      );
    });

    expect(toastError).toHaveBeenNthCalledWith(
      1,
      "Server error. Please try again.",
      {
        id: "api-error:500:HTTP 500",
      },
    );
    expect(toastError).toHaveBeenNthCalledWith(
      2,
      "Server error. Please try again.",
      {
        id: "api-error:500:HTTP 500",
      },
    );
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});
